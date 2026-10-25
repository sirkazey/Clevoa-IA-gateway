// Serveur d'autorisation OAuth 2.1 du hub (prototype « connexion en un clic », OAUTH=on, désactivé par défaut).
// L'assistant (Claude, ChatGPT, Copilot) s'inscrit (DCR), le collaborateur choisit son annuaire (Entra Charlois, Entra Oakwood,
// Google…) et s'y authentifie en OIDC (code + PKCE) ; le hub délivre alors SES jetons, liés à l'identité et à l'adresse /mcp
// (RFC 8707), jamais ceux de l'annuaire (pas de passthrough). Servi sur un port à part (OAUTH_PORT), le seul que le tunnel
// expose : /mcp, métadonnées, /authorize, /token, /register, /revoke, /oauth/login et /oauth/callback. Le portail et les clés
// statiques restent sur le port interne.
import express from "express";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidGrantError, InvalidTokenError, InvalidTargetError, InvalidClientMetadataError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { store } from "./store.js";
import { IS_PROD } from "./version.js";

export const ENABLED = process.env.OAUTH === "on";
export const PUBLIC = (process.env.OAUTH_PUBLIC_URL || "").replace(/\/$/, "");
export const PORT = Number(process.env.OAUTH_PORT || 8090);
export const RESOURCE = `${PUBLIC}/mcp`;
const ACCESS_TTL = 15 * 60; // secondes : un compte désactivé perd l'accès au plus tard à l'expiration du jeton suivant la revalidation
const SESSION_DAYS = Number(process.env.OAUTH_SESSION_DAYS || 30); // sans utilisation pendant ce délai, la session expire
const REVALIDATE_MIN = Number(process.env.OAUTH_REVALIDATE_MIN || 60); // au renouvellement, l'annuaire est réinterrogé au moins à ce rythme
const MAX_CLIENTS = 500;
export const SCOPES = ["mcp.read", "offline_access"]; // un scope métier en plus d'offline_access : certains clients n'envoient rien sinon
// Adresses de retour acceptées à l'inscription : Claude par défaut ; les applications locales (Claude Code, inspecteur MCP) sur la boucle locale.
const REDIRECTS = (process.env.OAUTH_REDIRECT_URIS || "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback").split(",").map((s) => s.trim()).filter(Boolean);
const LOOPBACK = process.env.OAUTH_LOOPBACK !== "off";
const [rewriteFrom, rewriteTo] = (process.env.BROWSER_URL_REWRITE || "").split("=>"); // pré-prod : annuaire simulé joint par son nom Docker

// ---------- Annuaires (OIDC_PROVIDERS=charlois,oakwood,acquise ; OIDC_<ID>_ISSUER, _CLIENT_ID, _CLIENT_SECRET, _LABEL, _DOMAINS…) ----------
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROVIDERS = (process.env.OIDC_PROVIDERS || "").split(",").map((s) => s.trim()).filter(Boolean).map((id) => {
  const v = (n) => (process.env[`OIDC_${id.toUpperCase()}_${n}`] || "").trim();
  const issuer = v("ISSUER").replace(/\/$/, ""), host = URL.canParse(issuer) ? new URL(issuer).hostname : "";
  const kind = v("KIND") || (host === "login.microsoftonline.com" ? "entra" : host === "accounts.google.com" ? "google" : "oidc");
  const parts = URL.canParse(issuer) ? new URL(issuer).pathname.split("/") : [];
  return {
    id, issuer, kind, host, label: v("LABEL") || id, clientId: v("CLIENT_ID"), clientSecret: v("CLIENT_SECRET"),
    tenant: kind === "entra" ? (parts[parts.indexOf("v2.0") - 1] || "").toLowerCase() : "", // segment qui précède v2.0
    domains: v("DOMAINS").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
    scope: v("SCOPE") || (kind === "google" ? "openid email profile" : "openid email profile offline_access"),
    // Google ne délivre de refresh token (revalidation) qu'avec access_type=offline, et prompt=consent pour le redonner.
    authParams: Object.fromEntries(new URLSearchParams(v("AUTH_PARAMS") || (kind === "google" ? "access_type=offline&prompt=consent" : ""))),
  };
});
const byIdp = Object.assign(Object.create(null), Object.fromEntries(PROVIDERS.map((p) => [p.id, p])));

if (ENABLED) {
  const fail = (m) => { console.error(`[oauth-server] ${m}`); process.exit(1); };
  if (!URL.canParse(PUBLIC)) fail("OAUTH=on exige OAUTH_PUBLIC_URL (ex. https://mcp-proto.socle.si)");
  if (!/^https:|^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(PUBLIC)) fail(`OAUTH_PUBLIC_URL doit être en https : ${PUBLIC}`);
  if (new URL(PUBLIC).pathname !== "/") fail("OAUTH_PUBLIC_URL doit être une origine, sans chemin");
  if (!(PORT > 0) || PORT === Number(process.env.PORT || 8080)) fail("OAUTH_PORT doit être un port distinct de PORT (le tunnel n'expose que lui)");
  if (!PROVIDERS.length) fail("OAUTH=on exige au moins un annuaire dans OIDC_PROVIDERS");
  for (const p of PROVIDERS) {
    const who = `annuaire ${p.id}`;
    if (!/^[a-z0-9]{1,20}$/.test(p.id)) fail(`${who} : identifiant en minuscules et chiffres, 20 caractères au plus`);
    if (!URL.canParse(p.issuer)) fail(`${who} : OIDC_${p.id.toUpperCase()}_ISSUER absent ou invalide`);
    if (!p.clientId || !p.clientSecret) fail(`${who} : CLIENT_ID et CLIENT_SECRET requis`);
    if (!["entra", "google", "oidc"].includes(p.kind)) fail(`${who} : KIND doit être entra, google ou oidc`);
    if (p.kind === "entra" && !p.tenant) fail(`${who} : émetteur Entra attendu en https://login.microsoftonline.com/<ID de l'annuaire>/v2.0`);
    if (p.kind !== "entra" && !p.domains.length) fail(`${who} : DOMAINS requis (domaines autorisés), sinon tout compte ${p.kind} entrerait`);
    if (IS_PROD) { // en production : de vrais annuaires seulement
      if (!p.issuer.startsWith("https://")) fail(`${who} : émetteur en https exigé en production`);
      if (p.kind === "entra" && (p.host !== "login.microsoftonline.com" || !GUID.test(p.tenant))) fail(`${who} : Entra exige login.microsoftonline.com et l'ID (GUID) de l'annuaire, jamais common ni organizations`);
      if (p.kind === "google" && p.host !== "accounts.google.com") fail(`${who} : Google exige https://accounts.google.com`);
    }
  }
}

// ---------- Outils ----------
const rand = (n = 32) => randomBytes(n).toString("base64url");
const sha = (s) => createHash("sha256").update(String(s)).digest("base64url");
const same = (a, b) => { const x = Buffer.from(sha(a)), y = Buffer.from(sha(b)); return timingSafeEqual(x, y); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sameResource = (r) => !r || String(r).replace(/#.*$/, "").replace(/\/$/, "") === RESOURCE;
const LOOP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//;
export const redirectAllowed = (u) => REDIRECTS.includes(u) || (LOOPBACK && LOOP.test(u));
const state = () => store.oauthState();
const cookie = (req) => req.headers.cookie?.match(/(?:^|;\s*)clevoa_oauth=([\w-]+)/)?.[1];
const secure = PUBLIC.startsWith("https") ? "; Secure" : "";

// Mémoire seulement (perdus au redémarrage, sans conséquence : l'assistant recommence ou renouvelle) :
const requests = new Map(); // demande d'autorisation en cours -> { clientId, clientName, redirectUri, codeChallenge, state, scopes, exp }
const logins = new Map();   // state envoyé à l'annuaire -> { req, idp, verifier, nonce, exp }
const codes = new Map();    // empreinte du code -> { clientId, redirectUri, codeChallenge, scopes, identity, idpRefresh, exp }
const usedCodes = new Map(); // empreinte d'un code déjà échangé -> { sid, exp } (rejeu : la session issue du code est révoquée)
const access = new Map();   // empreinte du jeton d'accès -> { sid, clientId, scopes, exp }
const purge = (m) => { const now = Date.now(); for (const [k, v] of m) if (v.exp < now) m.delete(k); };

// ---------- Annuaires : découverte, échange de code, identité ----------
const discovered = new Map(); // id -> { at, meta }
async function discover(p) {
  const d = discovered.get(p.id);
  if (d && d.at > Date.now() - 3600_000) return d.meta;
  const r = await fetch(`${p.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
  const meta = await r.json().catch(() => ({}));
  if (!r.ok || !meta.authorization_endpoint || !meta.token_endpoint) throw new Error("découverte OIDC invalide");
  if (String(meta.issuer).replace(/\/$/, "") !== p.issuer) throw new Error("émetteur annoncé différent de l'émetteur configuré");
  discovered.set(p.id, { at: Date.now(), meta });
  return meta;
}
async function idpToken(p, params) {
  const meta = await discover(p);
  const r = await fetch(meta.token_endpoint, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, ...params }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`annuaire ${p.id} : jeton refusé (${r.status})`), { status: r.status }); // rien du corps (il peut citer le compte)
  return body;
}
class Refused extends Error {} // compte authentifié mais refusé par la politique du hub (domaine, annuaire)

/** Identité vérifiée de l'id_token reçu en direct du point de terminaison token de l'annuaire (TLS, code + PKCE + secret :
 *  la signature n'est pas revérifiée, OIDC Core § 3.1.3.7 règle 6). Entra : annuaire épinglé par l'émetteur et `tid`, identité
 *  = `oid` (stable entre applications du même annuaire, comme le SSO du portail). Google : domaine Workspace (`hd`) exigé.
 *  Autre OIDC : e-mail vérifié dans un domaine autorisé. L'e-mail ne sert qu'à l'affichage pour Entra (revendication modifiable). */
export function identity(p, idToken, nonce) {
  let c; try { c = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8")); } catch { c = null; }
  if (!c) throw new Error("id_token absent ou illisible");
  const iss = String(c.iss || "").replace(/\/$/, "");
  if (iss !== p.issuer && !(p.kind === "google" && iss === "accounts.google.com")) throw new Error("émetteur inattendu");
  if (!(c.aud === p.clientId || (Array.isArray(c.aud) && c.aud.includes(p.clientId) && c.azp === p.clientId))) throw new Error("audience inattendue");
  if (!(c.exp > Date.now() / 1000)) throw new Error("id_token expiré");
  if (!nonce || c.nonce !== nonce) throw new Error("nonce inattendu");
  const email = String(c.email || c.preferred_username || "").toLowerCase(), domainOf = (e) => e.split("@")[1] || "";
  if (p.kind === "entra") {
    if (typeof c.oid !== "string" || !c.oid || String(c.tid || "").toLowerCase() !== p.tenant) throw new Error("annuaire Entra inattendu");
    const upn = String(c.preferred_username || "").toLowerCase();
    if (p.domains.length && !p.domains.includes(domainOf(upn))) throw new Refused(`domaine ${domainOf(upn) || "inconnu"} non autorisé pour ${p.label}`);
    return { sub: c.oid, tid: String(c.tid).toLowerCase(), upn, name: c.name || "", email: email || null };
  }
  if (typeof c.sub !== "string" || !c.sub) throw new Error("sub absent");
  const domain = p.kind === "google" ? String(c.hd || "").toLowerCase() : c.email_verified === true ? domainOf(email) : "";
  if (!domain || !p.domains.includes(domain)) throw new Refused(p.kind === "google" && !c.hd ? "compte Google personnel : seul un compte de l'entreprise est accepté" : `domaine ${domain || "non vérifié"} non autorisé pour ${p.label}`);
  return { sub: c.sub, tid: p.issuer, upn: email, name: c.name || "", email: email || null };
}

/** Lie l'identité à une clé du store : la même pour le même collaborateur, quel que soit le client ou le navigateur. */
function bind(id) {
  const key = store.findSso(id.sub, id.tid) ?? store.create();
  store.setSso(key, id);
  return key;
}

// ---------- Jetons du hub ----------
/** Jeton d'accès opaque de 15 min (mémoire) et refresh token tourné à chaque usage (empreinte seule sur disque). */
function issue(sid, s) {
  purge(access);
  const at = `cgo_at_${rand()}`, secret = rand();
  access.set(sha(at), { sid, clientId: s.clientId, scopes: s.scopes, exp: Date.now() + ACCESS_TTL * 1000 });
  s.refreshHash = sha(secret);
  s.exp = Date.now() + SESSION_DAYS * 86_400_000;
  return { access_token: at, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: `cgo_rt_${sid}.${secret}`, scope: s.scopes.join(" ") };
}
function endSession(sid) {
  delete state().sessions[sid];
  for (const [k, v] of access) if (v.sid === sid) access.delete(k);
  store.persist();
}
const parseRefresh = (t) => String(t).match(/^cgo_rt_([\w-]{20,64})\.([\w-]{20,64})$/)?.slice(1) ?? [];
const sessionOf = (sid) => (sid && Object.hasOwn(state().sessions, sid) ? state().sessions[sid] : null);

/** Réinterroge l'annuaire avec son refresh token : un compte désactivé ou supprimé, ou une politique d'accès qui ne passe plus,
 *  est refusé (400/401). Une panne réseau ne coupe pas la session mais refuse ce renouvellement (l'assistant réessaiera). */
async function revalidate(s) {
  const p = byIdp[s.idp];
  if (!p || !s.idpRefresh) throw new InvalidGrantError("Session de l'annuaire sans renouvellement possible : reconnectez-vous.");
  try {
    const t = await idpToken(p, { grant_type: "refresh_token", refresh_token: s.idpRefresh, scope: p.scope });
    if (t.refresh_token) s.idpRefresh = t.refresh_token; // Entra tourne ses refresh tokens ; Google garde le même
    s.revalidatedAt = Date.now();
  } catch (e) {
    if (e.status === 400 || e.status === 401) throw new InvalidGrantError("Compte désactivé ou session de l'annuaire révoquée : reconnectez-vous.");
    throw new ServerError("Annuaire injoignable, réessayez dans un instant.");
  }
}

// ---------- Fournisseur du SDK MCP ----------
export const provider = {
  clientsStore: {
    getClient: (id) => (Object.hasOwn(state().clients, id) ? state().clients[id] : undefined),
    registerClient(client) {
      if (!client.redirect_uris.length || !client.redirect_uris.every(redirectAllowed)) throw new InvalidClientMetadataError("redirect_uri non autorisée par ce hub");
      if (Object.keys(state().clients).length >= MAX_CLIENTS) throw new InvalidClientMetadataError("nombre maximal de clients inscrits atteint");
      const c = { ...client, client_name: String(client.client_name || "").slice(0, 80) };
      state().clients[c.client_id] = c; store.persist();
      return c;
    },
  },

  /** Page « Se connecter avec… » : choix de l'annuaire et consentement (le nom de l'application et son adresse de retour). */
  async authorize(client, params, res) {
    if (!sameResource(params.resource)) throw new InvalidTargetError("resource inconnue de ce hub");
    purge(requests);
    const id = rand(16);
    const scopes = [...new Set(["mcp.read", ...(params.scopes || []).filter((s) => SCOPES.includes(s))])];
    requests.set(id, { clientId: client.client_id, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge, state: params.state, scopes, exp: Date.now() + 10 * 60_000 });
    const app = client.client_name || "Assistant IA", host = new URL(params.redirectUri).host;
    res.setHeader("Set-Cookie", `clevoa_oauth=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
    res.type("html").send(page("Connexion", `<h1>Connexion à vos applications</h1>
<p><b>${esc(app)}</b> <span class="muted">(${esc(host)})</span> demande à lire, en votre nom et avec vos droits, les données des applications de l'entreprise. Aucune modification n'est possible.</p>
<p class="muted">Choisissez le compte de votre entreprise :</p>
${PROVIDERS.map((p) => `<a class="btn" href="/oauth/login/${p.id}?req=${id}">Continuer avec ${esc(p.label)}</a>`).join("\n")}
<p class="muted small">Vous n'êtes pas à l'origine de cette demande ? Fermez simplement cette fenêtre.</p>`));
  },

  async challengeForAuthorizationCode(client, code) {
    const h = sha(code), c = codes.get(h);
    // Le SDK demande le challenge PKCE avant l'échange : c'est ici qu'un code déjà échangé est vu rejoué. La session qu'il a
    // ouverte est révoquée (OAuth 2.1 § 4.1.3 : le code a probablement fuité).
    const used = !c && usedCodes.get(h);
    if (used) { usedCodes.delete(h); endSession(used.sid); }
    if (!c || c.clientId !== client.client_id || c.exp < Date.now()) throw new InvalidGrantError("Code d'autorisation invalide ou expiré");
    return c.codeChallenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const h = sha(code), c = codes.get(h);
    if (!c) throw new InvalidGrantError("Code d'autorisation invalide ou déjà utilisé");
    codes.delete(h);
    if (c.clientId !== client.client_id || c.exp < Date.now()) throw new InvalidGrantError("Code d'autorisation invalide ou expiré");
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri différente de celle de la demande");
    if (!sameResource(resource)) throw new InvalidTargetError("resource inconnue de ce hub");
    const sid = rand(24), now = Date.now();
    const s = { clientId: c.clientId, idp: c.idp, sub: c.identity.sub, tid: c.identity.tid, scopes: c.scopes, idpRefresh: c.idpRefresh || null, revalidatedAt: now, createdAt: new Date(now).toISOString() };
    purge(usedCodes); usedCodes.set(h, { sid, exp: now + 10 * 60_000 });
    for (const [k, v] of Object.entries(state().sessions)) if (v.exp < now) delete state().sessions[k];
    const tokens = issue(sid, s);
    state().sessions[sid] = s; store.persist();
    console.log(`[oauth-server] session ouverte (annuaire ${c.idp})`); // jamais l'identité
    return tokens;
  },

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const [sid, secret] = parseRefresh(refreshToken), s = sessionOf(sid);
    if (!s || s.clientId !== client.client_id) throw new InvalidGrantError("Refresh token invalide");
    if (s.prevHash && same(sha(secret), s.prevHash)) { endSession(sid); throw new InvalidGrantError("Refresh token déjà utilisé : session révoquée par précaution"); } // vol probable
    if (!same(sha(secret), s.refreshHash)) throw new InvalidGrantError("Refresh token invalide");
    if (s.exp < Date.now()) { endSession(sid); throw new InvalidGrantError("Session expirée : reconnectez-vous"); }
    if (!sameResource(resource)) throw new InvalidTargetError("resource inconnue de ce hub");
    if (scopes?.some((x) => !s.scopes.includes(x))) throw new InvalidGrantError("scope plus large que celui accordé");
    s.prevHash = s.refreshHash; // rotation avant toute attente : un second usage concurrent du même jeton est un rejeu
    const tokens = issue(sid, s);
    if (scopes?.length) tokens.scope = scopes.join(" ");
    store.persist();
    try {
      if (Date.now() - s.revalidatedAt > REVALIDATE_MIN * 60_000) await revalidate(s);
      if (!store.findSso(s.sub, s.tid)) throw new InvalidGrantError("Collaborateur retiré du hub");
    } catch (e) {
      if (e instanceof InvalidGrantError) { endSession(sid); throw e; }
      // Annuaire injoignable : toléré 24 h après la dernière revalidation réussie (une panne courte ne déconnecte personne), refusé ensuite.
      if (Date.now() - s.revalidatedAt > 24 * 3600_000) {
        access.delete(sha(tokens.access_token)); s.refreshHash = s.prevHash; s.prevHash = null; store.persist(); // l'ancien refresh token reste valable
        throw e;
      }
      console.error(`[oauth-server] annuaire ${s.idp} injoignable : revalidation reportée`);
    }
    store.persist();
    return tokens;
  },

  async verifyAccessToken(token) {
    const a = access.get(sha(token)), s = a && sessionOf(a.sid);
    if (!a || a.exp < Date.now() || !s) throw new InvalidTokenError("Jeton invalide ou expiré");
    const key = store.findSso(s.sub, s.tid);
    if (!key) throw new InvalidTokenError("Collaborateur retiré du hub");
    return { token, clientId: a.clientId, scopes: a.scopes, expiresAt: Math.floor(a.exp / 1000), resource: new URL(RESOURCE), extra: { key } };
  },

  async revokeToken(client, { token }) {
    const a = access.get(sha(token));
    if (a) { if (a.clientId === client.client_id) endSession(a.sid); return; }
    const [sid, secret] = parseRefresh(token), s = sessionOf(sid);
    if (s && s.clientId === client.client_id && (same(sha(secret), s.refreshHash) || (s.prevHash && same(sha(secret), s.prevHash)))) endSession(sid);
  },
};

// ---------- Pages ----------
function page(title, body) {
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Clevoa AI Gateway</title>
<style>:root{color-scheme:light dark;--ink:#2B2540;--accent:#6B30D9;--bg:#fff;--line:#ddd;--muted:#5d5870}
@media(prefers-color-scheme:dark){:root{--ink:#eee;--accent:#B79CF0;--bg:#1b1726;--line:#3a3448;--muted:#b3adc2}}
body{font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--ink);max-width:460px;margin:48px auto;padding:0 16px}
h1{font-size:1.3rem}.muted{color:var(--muted)}.small{font-size:.85rem}
.btn{display:block;margin:10px 0;padding:12px 16px;border:1px solid var(--line);border-radius:8px;color:var(--ink);text-decoration:none;font-weight:600}
.btn:hover,.btn:focus-visible{border-color:var(--accent);outline:2px solid var(--accent)}</style>
<body><main>${body}</main></body></html>`;
}
const fail = (res, status, message) => res.status(status).type("html").send(page("Connexion impossible", `<h1>Connexion impossible</h1><p>${esc(message)}</p><p class="muted">Fermez cette fenêtre et relancez la connexion depuis votre assistant.</p>`));

// ---------- Routes publiques ----------
const PUBLIC_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
};

/** Application Express du port public : rien d'autre que l'autorisation et /mcp (`mcpHandler(req, res)` avec `req.key`). */
export function publicApp(mcpHandler) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1)); // adresse réelle derrière cloudflared (limites de débit par IP)
  app.use((_req, res, next) => { res.set(PUBLIC_HEADERS); next(); });
  // Les adresses sortantes de Claude sont partagées par tous ses utilisateurs : limites par IP relevées en conséquence.
  const limit = (max, windowMs) => ({ rateLimit: { windowMs, max } });
  app.use(mcpAuthRouter({
    provider, issuerUrl: new URL(PUBLIC), resourceServerUrl: new URL(RESOURCE), scopesSupported: SCOPES, resourceName: "Clevoa AI Gateway",
    authorizationOptions: limit(300, 15 * 60_000), tokenOptions: limit(2000, 15 * 60_000), revocationOptions: limit(300, 15 * 60_000),
    clientRegistrationOptions: { clientSecretExpirySeconds: 0, ...limit(100, 3600_000) }, // secret sans expiration : sinon l'assistant perd la connexion au bout de 30 jours
  }));

  app.get("/oauth/login/:idp", async (req, res) => {
    const id = String(req.query.req || ""), r = requests.get(id), p = byIdp[req.params.idp];
    // La demande doit avoir été ouverte par CE navigateur (cookie) : un lien forgé ne peut pas faire entrer la victime dans la demande d'un autre.
    if (!r || r.exp < Date.now() || cookie(req) !== id || !p) return fail(res, 400, "Demande de connexion inconnue ou expirée.");
    let meta; try { meta = await discover(p); } catch { console.error(`[oauth-server] annuaire ${p.id} injoignable (découverte)`); return fail(res, 502, `${p.label} ne répond pas pour le moment.`); }
    purge(logins);
    const st = rand(), verifier = rand(), nonce = rand(16);
    logins.set(st, { req: id, idp: p.id, verifier, nonce, exp: Date.now() + 10 * 60_000 });
    const u = new URL(meta.authorization_endpoint);
    u.search = new URLSearchParams({ response_type: "code", client_id: p.clientId, redirect_uri: `${PUBLIC}/oauth/callback/${p.id}`, scope: p.scope, state: st, nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ...p.authParams });
    res.redirect(rewriteFrom ? u.href.replace(rewriteFrom, rewriteTo) : u.href);
  });

  app.get("/oauth/callback/:idp", async (req, res) => {
    const l = logins.get(String(req.query.state || "")), p = byIdp[req.params.idp];
    if (!l || !p || l.idp !== p.id || l.exp < Date.now() || cookie(req) !== l.req) return fail(res, 400, "Retour de l'annuaire inattendu ou expiré.");
    logins.delete(String(req.query.state));
    const r = requests.get(l.req); requests.delete(l.req); // une demande ne sert qu'une fois
    if (!r || r.exp < Date.now()) return fail(res, 400, "Demande de connexion expirée.");
    res.setHeader("Set-Cookie", `clevoa_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    const back = new URL(r.redirectUri);
    if (r.state) back.searchParams.set("state", r.state);
    if (req.query.error) { // vocabulaire fixe : rien de ce que renvoie l'annuaire n'est reflété
      console.error(`[oauth-server] annuaire ${p.id} : ${req.query.error === "access_denied" ? "refus de l'utilisateur" : "erreur renvoyée"}`);
      back.searchParams.set("error", "access_denied");
      return res.redirect(back.href);
    }
    try {
      const t = await idpToken(p, { grant_type: "authorization_code", code: String(req.query.code || ""), redirect_uri: `${PUBLIC}/oauth/callback/${p.id}`, code_verifier: l.verifier });
      const id = identity(p, t.id_token, l.nonce);
      bind(id);
      const code = rand();
      purge(codes);
      codes.set(sha(code), { clientId: r.clientId, redirectUri: r.redirectUri, codeChallenge: r.codeChallenge, scopes: r.scopes, idp: p.id, identity: id, idpRefresh: t.refresh_token, exp: Date.now() + 60_000 });
      back.searchParams.set("code", code);
      back.searchParams.set("iss", new URL(PUBLIC).href); // RFC 9207 : l'émetteur de la réponse
      res.redirect(back.href);
    } catch (e) {
      if (e instanceof Refused) { console.error(`[oauth-server] annuaire ${p.id} : compte refusé par la politique du hub`); return fail(res, 403, `Ce compte n'est pas autorisé : ${e.message}.`); }
      console.error(`[oauth-server] annuaire ${p.id} : échec de la connexion (${e.status ?? "vérification"})`);
      return fail(res, 502, `La connexion avec ${p.label} a échoué. Réessayez ; si le problème persiste, contactez votre administrateur.`);
    }
  });

  // Jeton du hub exigé ; 401 avec l'adresse des métadonnées (RFC 9728) pour que l'assistant découvre où se connecter.
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: ["mcp.read"], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(RESOURCE)), expectedResource: new URL(RESOURCE) });
  app.post("/mcp", express.json({ limit: "1mb" }), bearer, (req, res) => { req.key = req.auth.extra.key; return mcpHandler(req, res); });
  app.all("/mcp", (_req, res) => res.status(405).json({ error: "Utilisez POST (mode sans état)." }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use((_req, res) => res.status(404).type("text/plain").send("Introuvable\n")); // le portail n'existe pas de ce côté
  return app;
}
