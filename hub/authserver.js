// Serveur d'autorisation OAuth 2.1 du hub (prototype « connexion en un clic », OAUTH=on, désactivé par défaut).
// L'assistant (Claude, ChatGPT, Copilot) s'inscrit (DCR), le collaborateur choisit son annuaire (Entra Charlois, Entra Oakwood,
// Google…) et s'y authentifie en OIDC (code + PKCE) ; le hub délivre alors SES jetons, liés à l'identité et à l'adresse /mcp
// (RFC 8707), jamais ceux de l'annuaire (pas de passthrough). Servi sur un port à part (OAUTH_PORT), le seul que le tunnel
// expose : /mcp, métadonnées, /authorize, /token, /register, /revoke, /oauth/login et /oauth/callback. Le portail et les clés
// statiques restent sur le port interne.
import express from "express";
import { rateLimit } from "express-rate-limit";
import * as oidc from "openid-client";
import { randomBytes, createHash, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidGrantError, InvalidTokenError, InvalidTargetError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { store } from "./store.js";
import * as db from "./db.js";
import { IS_PROD } from "./version.js";

export const ENABLED = process.env.OAUTH === "on";
export const PUBLIC = (process.env.OAUTH_PUBLIC_URL || "").replace(/\/$/, "");
export const PORT = Number(process.env.OAUTH_PORT || 8090);
export const RESOURCE = `${PUBLIC}/mcp`;
const ACCESS_TTL = 15 * 60; // secondes : un compte désactivé perd l'accès au plus tard à l'expiration du jeton suivant la revalidation
const SESSION_DAYS = Number(process.env.OAUTH_SESSION_DAYS || 30); // sans utilisation pendant ce délai, la session expire
const REVALIDATE_MIN = Number(process.env.OAUTH_REVALIDATE_MIN || 60); // l'annuaire est réinterrogé au moins à ce rythme (après le renouvellement)
const REQUEST_TTL = 20 * 60_000; // une demande de connexion vit 20 min, prolongées au clic (temps d'une MFA)
const REFRESH_GRACE = Number(process.env.OAUTH_REFRESH_GRACE_MS ?? 30_000); // le refresh token qui vient d'être remplacé reste accepté 30 s (réponse perdue, réessai)
const MAX_CLIENTS = 500; // au-delà, les inscriptions de plus de 24 h sans session sont oubliées
const MAX_PENDING = 5000; // plafond des tables en mémoire (codes émis, codes échangés) : au-delà, 503 plutôt qu'une saturation
export const SCOPES = ["mcp.read", "offline_access"]; // un scope métier en plus d'offline_access : certains clients n'envoient rien sinon
// Adresses de retour acceptées à l'inscription : Claude par défaut. La boucle locale (Claude Code, inspecteur MCP) seulement avec
// OAUTH_LOOPBACK=on : sinon un lien piégé pourrait faire livrer un code à une application locale quelconque.
const REDIRECTS = (process.env.OAUTH_REDIRECT_URIS || "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback").split(",").map((s) => s.trim()).filter(Boolean);
const LOOPBACK = process.env.OAUTH_LOOPBACK === "on";
const [rewriteFrom, rewriteTo] = (process.env.BROWSER_URL_REWRITE || "").split("=>"); // pré-prod : annuaire simulé joint par son nom Docker
const TITLE = (process.env.INSTANCE_LABEL || "").trim().slice(0, 80) || "Clevoa AI Gateway";
const SUPPORT = (process.env.OAUTH_SUPPORT_CONTACT || "").trim().slice(0, 200); // affiché sur les pages d'erreur (ex. « Service informatique, poste 1234 »)

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
  const fail = (m) => { console.error(`[oauth-server] ${m}`); process.exit(1); }; // refus de démarrer
  // Un réglage illisible (« 1h ») désactiverait en silence la revalidation ou l'expiration des sessions : refusé.
  if (!(Number.isInteger(SESSION_DAYS) && SESSION_DAYS > 0)) fail("OAUTH_SESSION_DAYS doit être un nombre entier de jours, supérieur à 0");
  if (!(Number.isInteger(REVALIDATE_MIN) && REVALIDATE_MIN >= 0)) fail("OAUTH_REVALIDATE_MIN doit être un nombre entier de minutes (0 = à chaque renouvellement)");
  if (!(Number.isInteger(REFRESH_GRACE) && REFRESH_GRACE >= 0 && REFRESH_GRACE <= 120_000)) fail("OAUTH_REFRESH_GRACE_MS doit être un nombre entier de millisecondes entre 0 et 120000");
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
    if (!p.domains.length) fail(`${who} : DOMAINS requis (domaines des comptes autorisés), sinon tout compte ${p.kind === "entra" ? "de l'annuaire, invités compris," : p.kind} entrerait`);
    // Un émetteur en http n'est admis que pour les annuaires simulés (bouchon, boucle locale), et jamais en production ; un vrai
    // annuaire (https) est contrôlé dès la pré-production : Microsoft avec l'ID de l'annuaire, Google à son adresse officielle.
    const simulated = /^http:\/\/(mcp-stub|localhost|127\.0\.0\.1)(:\d+)?\//.test(p.issuer + "/");
    if (!p.issuer.startsWith("https://") && (IS_PROD || !simulated)) fail(`${who} : émetteur en https exigé${IS_PROD ? " en production" : " (http réservé aux annuaires simulés)"}`);
    if (p.issuer.startsWith("https://")) {
      if ([p.clientId, p.clientSecret].includes("simule")) fail(`${who} : CLIENT_ID et CLIENT_SECRET de l'application inscrite dans l'annuaire requis (valeur « simule » réservée au bouchon)`);
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
// Clients inscrits et sessions : en mémoire, chaque modification écrite ligne à ligne dans hub.db (db.js), chiffrée. Repris une
// fois de users.json (prototype avant la 1.5). Base indisponible : le serveur continue en mémoire, les assistants se reconnectent
// après un redémarrage.
let oauth = null;
function state() {
  if (oauth) return oauth;
  oauth = db.oauthLoad() ?? { clients: {}, sessions: {} };
  const legacy = store.takeLegacyOauth();
  if (legacy) {
    for (const [id, c] of Object.entries(legacy.clients ?? {})) { oauth.clients[id] ??= c; db.oauthClient(id, oauth.clients[id]); }
    for (const [sid, s] of Object.entries(legacy.sessions ?? {})) { oauth.sessions[sid] ??= s; db.oauthSession(sid, oauth.sessions[sid]); }
    console.log("[oauth-server] clients et sessions repris de users.json dans hub.db");
  }
  return oauth;
}

// ---------- Demandes de connexion : dans un cookie chiffré, rien en mémoire avant le retour de l'annuaire ----------
// Une demande (assistant, adresse de retour, PKCE, state de l'assistant) puis la connexion à l'annuaire (state, verifier, nonce)
// voyagent dans un cookie AES-256-GCM propre à la demande : un afflux de demandes ne remplit aucune table du hub, et plusieurs
// fenêtres « Connect » peuvent être ouvertes en même temps. Préfixe __Host- en https : ni sous-domaine frère ni domaine parent.
const COOKIE = PUBLIC.startsWith("https") ? "__Host-clevoa_oauth_" : "clevoa_oauth_", secure = PUBLIC.startsWith("https") ? "; Secure" : "";
const SEAL_KEY = createHash("sha256").update(`clevoa-oauth-request:${process.env.ENCRYPTION_KEY || ""}`).digest();
const RID = /^[\w-]{12}$/;
function seal(o) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", SEAL_KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(o), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64url");
}
function unseal(v) {
  try {
    const b = Buffer.from(String(v), "base64url"), d = createDecipheriv("aes-256-gcm", SEAL_KEY, b.subarray(0, 12), { authTagLength: 16 });
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
  } catch { return null; }
}
/** Demande `rid` portée par le cookie de CE navigateur, encore valable, ou null. */
function request(req, rid) {
  if (!RID.test(rid)) return null;
  const raw = req.headers.cookie?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}${rid}=`))?.slice(COOKIE.length + rid.length + 1);
  const r = raw && unseal(raw);
  return r && r.rid === rid && r.exp > Date.now() ? r : null;
}
const setRequest = (res, r) => res.append("Set-Cookie", `${COOKIE}${r.rid}=${seal({ ...r, exp: Date.now() + REQUEST_TTL })}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${REQUEST_TTL / 1000}${secure}`);
const dropRequest = (res, rid) => res.append("Set-Cookie", `${COOKIE}${rid}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);

// Mémoire seulement (perdus au redémarrage, sans conséquence : l'assistant recommence ou renouvelle) :
const codes = new Map();    // empreinte du code -> { clientId, redirectUri, codeChallenge, scopes, identity, idpRefresh, exp }
const usedCodes = new Map(); // empreinte d'un code déjà échangé -> { sid, clientId, exp } (rejeu par le même client : la session issue du code est révoquée)
const access = new Map();   // empreinte du jeton d'accès -> { sid, clientId, scopes, exp }
const revalidating = new Set(); // sessions en cours de revalidation (une seule interrogation de l'annuaire à la fois)
const purge = (m) => { const now = Date.now(); for (const [k, v] of m) if (v.exp < now) m.delete(k); };
/** Purge puis vrai si la table est pleine : le hub refuse (503) au lieu de grossir sans limite. */
const full = (m, max = MAX_PENDING) => { purge(m); return m.size >= max; };

// ---------- Annuaires : openid-client (découverte, échange de code, nonce, signature de l'id_token, refresh) ----------
const configs = new Map(); // id de l'annuaire -> promesse de Configuration (découverte une fois, refaite après un échec)
/** Configuration OIDC de l'annuaire : la signature des id_token est vérifiée avec les clés qu'il publie. http seulement pour les
 *  annuaires simulés hors production (contrôlé au démarrage) ; délai de 5 s par requête. */
function idpConfig(p) {
  if (!configs.has(p.id)) {
    const execute = [oidc.enableNonRepudiationChecks, ...(!IS_PROD && p.issuer.startsWith("http:") ? [oidc.allowInsecureRequests] : [])];
    const c = oidc.discovery(new URL(p.issuer), p.clientId, p.clientSecret, undefined, { execute, timeout: 5 });
    c.catch(() => configs.delete(p.id));
    configs.set(p.id, c);
  }
  return configs.get(p.id);
}
/** Erreur d'openid-client avec un code court journalisable : code OAuth de l'annuaire (invalid_grant…), « id_token » si la
 *  vérification a échoué ; jamais la description, qui peut citer le compte. */
const idpError = (e) => Object.assign(e, { code: e instanceof oidc.ResponseBodyError ? (/^[a-z_]{1,40}$/.test(e.error) ? e.error : "") : e instanceof oidc.ClientError ? "id_token" : "" });
class Refused extends Error {} // compte authentifié mais refusé par la politique du hub (domaine, annuaire)

/** Politique du hub sur les revendications d'un id_token déjà vérifié par openid-client (signature, émetteur, audience,
 *  expiration, nonce). Entra : annuaire épinglé par `tid`, identité = `oid` (stable entre applications du même annuaire, comme le
 *  SSO du portail), invités refusés. Google : domaine Workspace (`hd`) exigé. Autre OIDC : e-mail vérifié dans un domaine
 *  autorisé. L'e-mail ne sert qu'à l'affichage pour Entra (revendication modifiable). */
export function identity(p, c) {
  if (!c) throw new Error("id_token absent");
  const email = String(c.email || c.preferred_username || "").toLowerCase(), domainOf = (e) => e.split("@")[1] || "";
  if (p.kind === "entra") {
    if (typeof c.oid !== "string" || !c.oid || String(c.tid || "").toLowerCase() !== p.tenant) throw new Error("annuaire Entra inattendu");
    // Invité B2B : son compte vient d'un autre fournisseur (revendication idp, ou acct=1 si configurée) ; refusé, seuls les membres entrent.
    if ((c.idp && c.idp !== c.iss && c.idp.toLowerCase() !== `https://sts.windows.net/${p.tenant}/`) || c.acct === 1) throw new Refused(`Ce compte est un compte invité. Utilisez votre propre compte ${p.label}.`);
    const upn = String(c.preferred_username || "").toLowerCase();
    if (!p.domains.includes(domainOf(upn))) throw new Refused(`Les comptes ${domainOf(upn) ? `du domaine ${domainOf(upn)}` : "sans domaine"} ne sont pas acceptés pour ${p.label}.`);
    return { sub: c.oid, tid: String(c.tid).toLowerCase(), upn, name: c.name || "", email: email || null };
  }
  if (typeof c.sub !== "string" || !c.sub) throw new Error("sub absent");
  const domain = p.kind === "google" ? String(c.hd || "").toLowerCase() : c.email_verified === true ? domainOf(email) : "";
  if (!domain || !p.domains.includes(domain)) throw new Refused(p.kind === "google" && !c.hd ? `Ce compte Google est personnel. Utilisez votre compte de l'entreprise (@${p.domains[0]}).` : `Les comptes ${domain ? `du domaine ${domain}` : "à l'adresse non vérifiée"} ne sont pas acceptés pour ${p.label}.`);
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
function issue(sid, s, scopes = s.scopes) {
  purge(access);
  const at = `cgo_at_${rand()}`, secret = rand();
  access.set(sha(at), { sid, clientId: s.clientId, scopes, exp: Date.now() + ACCESS_TTL * 1000 });
  s.refreshHash = sha(secret);
  s.exp = Date.now() + SESSION_DAYS * 86_400_000;
  return { access_token: at, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: `cgo_rt_${sid}.${secret}`, scope: scopes.join(" ") };
}
/** Ferme une session (et ses jetons d'accès) ; la raison est journalisée, jamais l'identité. */
function endSession(sid, reason) {
  const s = sessionOf(sid); if (!s) return;
  delete state().sessions[sid]; db.oauthSession(sid, null);
  for (const [k, v] of access) if (v.sid === sid) access.delete(k);
  console.log(`[oauth-server] session fermée (annuaire ${s.idp}) : ${reason}`);
}
const parseRefresh = (t) => String(t).match(/^cgo_rt_([\w-]{20,64})\.([\w-]{20,64})$/)?.slice(1) ?? [];
const sessionOf = (sid) => (sid && Object.hasOwn(state().sessions, sid) ? state().sessions[sid] : null);

/** Réinterroge l'annuaire avec son refresh token, APRÈS avoir répondu à l'assistant (le renouvellement n'attend jamais l'annuaire).
 *  invalid_grant (compte désactivé ou supprimé, politique d'accès qui ne passe plus, session révoquée) : session fermée, ses jetons
 *  d'accès avec. Secret du hub refusé (invalid_client) : alerte au journal, sans couper personne (ce n'est pas le fait du collaborateur).
 *  Annuaire injoignable : toléré 24 h après la dernière revalidation réussie, session fermée ensuite. */
async function revalidate(sid) {
  const s = sessionOf(sid), p = s && byIdp[s.idp];
  if (!s || revalidating.has(sid)) return;
  if (!p || !s.idpRefresh) return endSession(sid, "annuaire sans renouvellement possible, reconnexion demandée");
  revalidating.add(sid);
  try {
    let t; try { t = await oidc.refreshTokenGrant(await idpConfig(p), s.idpRefresh, { scope: p.scope }); } catch (e) { throw idpError(e); }
    if (!sessionOf(sid)) return;
    if (t.refresh_token) s.idpRefresh = t.refresh_token; // Entra tourne ses refresh tokens ; Google garde le même
    s.revalidatedAt = Date.now(); db.oauthSession(sid, s);
  } catch (e) {
    if (e.code === "invalid_grant") return endSession(sid, "refusée par l'annuaire (compte désactivé ou session révoquée)");
    if (["invalid_client", "unauthorized_client"].includes(e.code)) console.error(`[oauth-server] ALERTE : l'annuaire ${s.idp} refuse l'application du hub (${e.code}) ; vérifier OIDC_${s.idp.toUpperCase()}_CLIENT_ID et _CLIENT_SECRET (secret expiré ?)`);
    else console.error(`[oauth-server] annuaire ${s.idp} injoignable (${e.status ?? "réseau"}${e.code ? ` ${e.code}` : ""}) : revalidation reportée`);
    if (Date.now() - s.revalidatedAt > 24 * 3600_000) endSession(sid, "annuaire injoignable ou application refusée depuis plus de 24 h");
  } finally { revalidating.delete(sid); }
}

// ---------- Fournisseur du SDK MCP ----------
export const provider = {
  clientsStore: {
    // Revérifié à chaque usage : un client inscrit avant un resserrement (OAUTH_LOOPBACK, OAUTH_REDIRECT_URIS) perd les adresses retirées.
    getClient(id) {
      const c = Object.hasOwn(state().clients, id) ? state().clients[id] : null, uris = c?.redirect_uris.filter(redirectAllowed);
      return uris?.length ? { ...c, redirect_uris: uris } : undefined;
    },
    registerClient(client) {
      if (!client.redirect_uris.length || !client.redirect_uris.every(redirectAllowed)) throw new InvalidClientMetadataError("redirect_uri non autorisée par ce hub");
      if (Object.keys(state().clients).length >= MAX_CLIENTS) { // plafond : on oublie les inscriptions de plus de 24 h sans session ouverte
        const active = new Set(Object.values(state().sessions).map((x) => x.clientId)), old = Date.now() / 1000 - 86_400;
        for (const [id, c] of Object.entries(state().clients)) if (!active.has(id) && (c.client_id_issued_at ?? 0) < old) { delete state().clients[id]; db.oauthClient(id, null); }
        if (Object.keys(state().clients).length >= MAX_CLIENTS) throw new InvalidClientMetadataError("nombre maximal de clients inscrits atteint");
      }
      // Le SDK n'authentifie au point de terminaison token qu'en client_secret_post : la méthode effective est annoncée au client (RFC 7591 § 3.2.1).
      const c = { ...client, client_name: String(client.client_name || "").slice(0, 80), token_endpoint_auth_method: client.client_secret ? "client_secret_post" : "none" };
      state().clients[c.client_id] = c; db.oauthClient(c.client_id, c);
      return c;
    },
  },

  /** Page « Se connecter avec… » : choix de l'annuaire et consentement (le nom de l'application et son adresse de retour). */
  async authorize(client, params, res) {
    if (!sameResource(params.resource)) throw new InvalidTargetError("resource inconnue de ce hub");
    const rid = rand(9); // 12 caractères
    const scopes = [...new Set(["mcp.read", ...(params.scopes || []).filter((s) => SCOPES.includes(s))])];
    setRequest(res, { rid, clientId: client.client_id, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge, state: params.state, scopes });
    const app = client.client_name || "Assistant IA", host = new URL(params.redirectUri).host;
    res.type("html").send(page("Connexion", `<p class="brand">${esc(TITLE)}</p><h1>Connexion à vos applications</h1>
<p><b>${esc(app)}</b> <span class="muted">(${esc(host)})</span> demande à lire, en votre nom et avec vos droits, les données des applications de l'entreprise. Aucune modification n'est possible.</p>
<p class="muted">Choisissez le compte de votre entreprise :</p>
${buttons(rid)}
<p class="muted small">Vous n'êtes pas à l'origine de cette demande ? Fermez simplement cette fenêtre.</p>`));
  },

  async challengeForAuthorizationCode(client, code) {
    const h = sha(code), c = codes.get(h);
    // Le SDK demande le challenge PKCE avant l'échange : c'est ici qu'un code déjà échangé est vu rejoué. La session qu'il a
    // ouverte est révoquée (OAuth 2.1 § 4.1.3 : le code a probablement fuité).
    const used = !c && usedCodes.get(h);
    if (used && used.clientId === client.client_id) { usedCodes.delete(h); endSession(used.sid, "code d'autorisation rejoué"); } // un autre client ne peut pas couper la session d'autrui
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
    if (!full(usedCodes)) usedCodes.set(h, { sid, clientId: c.clientId, exp: now + 10 * 60_000 });
    for (const [k, v] of Object.entries(state().sessions)) if (v.exp < now) { delete state().sessions[k]; db.oauthSession(k, null); }
    const tokens = issue(sid, s);
    state().sessions[sid] = s; db.oauthSession(sid, s);
    console.log(`[oauth-server] session ouverte (annuaire ${c.idp})`); // jamais l'identité
    return tokens;
  },

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const [sid, secret] = parseRefresh(refreshToken), s = sessionOf(sid), now = Date.now();
    if (!s || s.clientId !== client.client_id) throw new InvalidGrantError("Refresh token invalide");
    const current = same(sha(secret), s.refreshHash), previous = !!s.prevHash && same(sha(secret), s.prevHash);
    // Le jeton tout juste remplacé reste valable REFRESH_GRACE (réponse perdue, réessai) ; au-delà, son retour signe un vol : session fermée.
    if (previous && now - (s.rotatedAt ?? 0) > REFRESH_GRACE) { endSession(sid, "refresh token rejoué"); throw new InvalidGrantError("Refresh token déjà utilisé : reconnectez-vous"); }
    if (!current && !previous) throw new InvalidGrantError("Refresh token invalide");
    if (s.exp < now) { endSession(sid, "expirée (inutilisée trop longtemps)"); throw new InvalidGrantError("Session expirée : reconnectez-vous"); }
    if (!sameResource(resource)) throw new InvalidTargetError("resource inconnue de ce hub");
    if (!store.findSso(s.sub, s.tid)) { endSession(sid, "collaborateur retiré du hub"); throw new InvalidGrantError("Accès retiré : reconnectez-vous"); }
    // Portée demandée : réduite à ce qui a été accordé ; un scope inconnu (propre à l'assistant) est ignoré, comme à l'autorisation.
    const granted = (scopes || []).filter((x) => s.scopes.includes(x));
    s.prevHash = s.refreshHash; s.rotatedAt = now;
    const tokens = issue(sid, s, granted.length ? granted : s.scopes);
    db.oauthSession(sid, s);
    if (now - s.revalidatedAt > REVALIDATE_MIN * 60_000) setImmediate(() => revalidate(sid)); // après la réponse : l'assistant n'attend pas l'annuaire
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
    if (a) { if (a.clientId === client.client_id) endSession(a.sid, "révoquée par l'assistant"); return; }
    const [sid, secret] = parseRefresh(token), s = sessionOf(sid);
    if (s && s.clientId === client.client_id && (same(sha(secret), s.refreshHash) || (s.prevHash && same(sha(secret), s.prevHash)))) endSession(sid, "révoquée par l'assistant");
  },
};

// ---------- Pages ----------
function page(title, body) {
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Clevoa AI Gateway</title>
<style>:root{color-scheme:light dark;--ink:#2B2540;--accent:#6B30D9;--bg:#fff;--line:#857f93;--muted:#5d5870}
@media(prefers-color-scheme:dark){:root{--ink:#eee;--accent:#B79CF0;--bg:#1b1726;--line:#7a7390;--muted:#b3adc2}}
body{font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--ink);max-width:460px;margin:48px auto;padding:0 16px}
h1{font-size:1.3rem;margin-top:.2rem}.brand{margin:0;color:var(--muted);font-weight:600;font-size:.9rem}.muted{color:var(--muted)}.small{font-size:.85rem}
.btn{display:block;margin:10px 0;padding:12px 16px;border:1px solid var(--line);border-radius:8px;color:var(--ink);text-decoration:none;font-weight:600}
.btn:hover,.btn:focus-visible{border-color:var(--accent);outline:2px solid var(--accent)}</style>
<body><main>${body}</main></body></html>`;
}
/** Un bouton par annuaire ; `select` force le choix du compte (après un refus, pour ne pas retomber sur le même compte). */
const buttons = (rid, select = false) => PROVIDERS.map((p) => `<a class="btn" href="/oauth/login/${p.id}?rid=${rid}${select ? "&amp;select=1" : ""}">${select ? "Choisir un autre compte" : "Continuer avec"} ${esc(p.label)}</a>`).join("\n");
const contact = () => (SUPPORT ? `<p class="muted small">Besoin d'aide : ${esc(SUPPORT)}</p>` : "");
/** Page d'erreur ; avec `rid`, la demande reste ouverte et l'on peut réessayer avec un autre compte. */
const errorPage = (res, status, message, rid) => res.status(status).type("html").send(page("Connexion impossible", `<p class="brand">${esc(TITLE)}</p><h1>Connexion impossible</h1><p>${esc(message)}</p>
${rid ? buttons(rid, true) : `<p class="muted">Fermez cette fenêtre et relancez la connexion depuis votre assistant.</p>`}${contact()}`));

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
  // Chemins exacts seulement : Express route sans tenir compte de la casse ni de la barre finale, alors que la règle du pare-feu
  // Cloudflare compare le chemin tel quel ; /REGISTER ou /mcp/ contourneraient le filtrage par adresse de Claude.
  const CANONICAL = /^\/(mcp|authorize|token|register|revoke|health|\.well-known\/oauth-authorization-server|\.well-known\/oauth-protected-resource\/mcp|oauth\/(login|callback)\/[a-z0-9]{1,20})$/;
  app.use((req, res, next) => (CANONICAL.test(req.path) ? next() : res.status(404).type("text/plain").send("Introuvable\n")));
  // Les adresses sortantes de Claude sont partagées par tous ses utilisateurs : limites par IP relevées en conséquence.
  const limit = (max, windowMs) => ({ rateLimit: { windowMs, max } });
  app.use(mcpAuthRouter({
    provider, issuerUrl: new URL(PUBLIC), resourceServerUrl: new URL(RESOURCE), scopesSupported: SCOPES, resourceName: "Clevoa AI Gateway",
    authorizationOptions: limit(300, 15 * 60_000), tokenOptions: limit(2000, 15 * 60_000), revocationOptions: limit(300, 15 * 60_000),
    clientRegistrationOptions: { clientSecretExpirySeconds: 0, ...limit(100, 3600_000) }, // secret sans expiration : sinon l'assistant perd la connexion au bout de 30 jours
  }));

  // Pages du navigateur : 60 par minute et par adresse (un bureau entier derrière une même adresse reste loin du plafond).
  app.use("/oauth", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, message: "Trop de tentatives, réessayez dans une minute." }));
  app.get("/oauth/login/:idp", async (req, res) => {
    const rid = String(req.query.rid || ""), r = request(req, rid), p = byIdp[req.params.idp];
    // La demande doit avoir été ouverte par CE navigateur (cookie chiffré) : un lien forgé ne peut pas faire entrer la victime dans la demande d'un autre.
    if (!r || !p) return errorPage(res, 400, "Demande de connexion inconnue ou expirée.");
    let config; try { config = await idpConfig(p); } catch { console.error(`[oauth-server] annuaire ${p.id} injoignable (découverte)`); return errorPage(res, 502, `${p.label} ne répond pas pour le moment. Réessayez dans quelques minutes.`, rid); }
    // Une seule connexion en cours par demande : recliquer remplace la précédente (le cookie ne garde que la dernière).
    const login = { idp: p.id, st: `${rid}.${rand()}`, verifier: rand(), nonce: rand(16) };
    setRequest(res, { ...r, login });
    const u = oidc.buildAuthorizationUrl(config, { ...p.authParams, ...(req.query.select === "1" ? { prompt: p.kind === "google" ? "select_account consent" : "select_account" } : {}),
      redirect_uri: `${PUBLIC}/oauth/callback/${p.id}`, scope: p.scope, state: login.st, nonce: login.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(login.verifier), code_challenge_method: "S256" });
    res.redirect(rewriteFrom ? u.href.replace(rewriteFrom, rewriteTo) : u.href);
  });

  // Codes d'erreur OIDC journalisés tels quels (liste fermée) ; tout autre texte de l'annuaire est ignoré.
  const IDP_ERRORS = new Set(["access_denied", "consent_required", "interaction_required", "login_required", "account_selection_required", "invalid_request", "invalid_scope", "unauthorized_client", "server_error", "temporarily_unavailable"]);
  app.get("/oauth/callback/:idp", async (req, res) => {
    const st = String(req.query.state || ""), rid = st.split(".")[0], r = request(req, rid), p = byIdp[req.params.idp], l = r?.login;
    if (!r || !p || !l || l.idp !== p.id || !same(l.st, st)) return errorPage(res, 400, "Retour de l'annuaire inattendu ou expiré.");
    const back = new URL(r.redirectUri);
    if (r.state) back.searchParams.set("state", r.state);
    if (req.query.error) {
      const code = IDP_ERRORS.has(req.query.error) ? req.query.error : "autre";
      console.error(`[oauth-server] annuaire ${p.id} : erreur ${code}`);
      if (code === "access_denied") { dropRequest(res, rid); back.searchParams.set("error", "access_denied"); return res.redirect(back.href); } // refus du collaborateur : l'assistant en est informé
      setRequest(res, { ...r, login: undefined });
      return errorPage(res, 502, `${p.label} n'a pas pu vous connecter (${code}).`, rid);
    }
    setRequest(res, { ...r, login: undefined }); // la connexion n'est utilisable qu'une fois ; la demande reste ouverte pour réessayer
    try {
      // Adresse de retour telle qu'enregistrée chez l'annuaire (pas celle vue derrière cloudflared), avec le code, le state et l'iss éventuel.
      const current = new URL(`${PUBLIC}/oauth/callback/${p.id}`);
      current.search = new URLSearchParams({ code: String(req.query.code || ""), state: st, ...(req.query.iss ? { iss: String(req.query.iss) } : {}) });
      let t; try { t = await oidc.authorizationCodeGrant(await idpConfig(p), current, { pkceCodeVerifier: l.verifier, expectedState: st, expectedNonce: l.nonce, idTokenExpected: true }); } catch (e) { throw idpError(e); }
      const id = identity(p, t.claims());
      bind(id);
      if (full(codes)) return errorPage(res, 503, "Trop de connexions en cours, réessayez dans quelques minutes.", rid);
      const code = rand();
      codes.set(sha(code), { clientId: r.clientId, redirectUri: r.redirectUri, codeChallenge: r.codeChallenge, scopes: r.scopes, idp: p.id, identity: id, idpRefresh: t.refresh_token, exp: Date.now() + 60_000 });
      res.removeHeader("Set-Cookie"); dropRequest(res, rid); // demande consommée
      back.searchParams.set("code", code);
      back.searchParams.set("iss", new URL(PUBLIC).href); // RFC 9207 : l'émetteur de la réponse
      res.redirect(back.href);
    } catch (e) {
      if (e instanceof Refused) { console.error(`[oauth-server] annuaire ${p.id} : compte refusé par la politique du hub`); return errorPage(res, 403, e.message, rid); }
      console.error(`[oauth-server] annuaire ${p.id} : échec de la connexion (${e.status ?? "vérification"}${e.code ? ` ${e.code}` : ""})`);
      return errorPage(res, 502, `La connexion avec ${p.label} a échoué. Réessayez ; si le problème persiste, contactez votre administrateur.`, rid);
    }
  });

  // Jeton du hub exigé AVANT de lire le corps ; 401 avec l'adresse des métadonnées (RFC 9728) pour que l'assistant découvre où se connecter.
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: ["mcp.read"], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(RESOURCE)), expectedResource: new URL(RESOURCE) });
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), (req, res) => { req.key = req.auth.extra.key; req.oauth = true; return mcpHandler(req, res); });
  app.all("/mcp", (_req, res) => res.status(405).json({ error: "Utilisez POST (mode sans état)." }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use((_req, res) => res.status(404).type("text/plain").send("Introuvable\n")); // le portail n'existe pas de ce côté
  return app;
}
