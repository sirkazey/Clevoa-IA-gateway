// Accès en ligne pour Claude (claude.ai web, mobile et application de bureau) : port séparé, publié par un tunnel Cloudflare, qui ne
// sert que l'OAuth et /mcp. Désactivé par défaut (ONLINE=on ou 1, soit CLOUDFLARE_TUNNEL=1 dans la stack). Aucun serveur d'autorisation maison : le relais OAuth du SDK MCP
// (ProxyOAuthServerProvider) publie des métadonnées conformes (PKCE S256, RFC 8414, RFC 9728) et transmet connexion et jetons à
// Entra ID ; Entra authentifie (double authentification, accès conditionnel), délivre, renouvelle et révoque. Le hub ne délivre
// aucun jeton : il vérifie ceux d'Entra (signature, émetteur, locataire, audience, application cliente, scope) avec jose, puis
// rattache le collaborateur à sa clé par son identité Entra, comme le SSO du portail (même oid, même locataire, mêmes connexions).
// Client Claude pré-enregistré : inscription d'application Entra dédiée, dont l'Owner saisit l'identifiant et le secret dans Claude.
// Inscription automatique (CIMD, 1.8, expérimental, ONLINE_CIMD_CLIENTS) : l'assistant se présente par l'adresse de son document
// (cimd.js), sans secret ; le hub devient l'adresse de retour enregistrée dans Entra (/oauth/callback) et réémet son propre code,
// à usage unique, lié au client, à son adresse de retour et au PKCE de l'assistant. Les jetons restent ceux d'Entra.
import express from "express";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import { InvalidGrantError, InvalidTargetError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { store } from "./store.js";
import * as sso from "./sso.js";
import { IS_PROD } from "./version.js";
import * as cimd from "./cimd.js";

export const ENABLED = ["on", "1"].includes(process.env.ONLINE); // Compose : CLOUDFLARE_TUNNEL=1 ; vide ou 0 = désactivé
const PORT = Number(process.env.ONLINE_PORT || 8090);
const BASE = (process.env.ONLINE_URL || "").replace(/\/$/, "");
const CLIENT_ID = process.env.ONLINE_CLIENT_ID || "", CLIENT_SECRET = process.env.ONLINE_CLIENT_SECRET || "";
// Adresse de retour de Claude (web, bureau, mobile) ; une autre (claude.com, boucle locale de Claude Code) s'ajoute explicitement.
const REDIRECTS = (process.env.ONLINE_REDIRECT_URIS || "https://claude.ai/api/mcp/auth_callback").split(",").map((s) => s.trim()).filter(Boolean);
const LOGIN = (process.env.MS_LOGIN_URL || "https://login.microsoftonline.com").replace(/\/$/, "");
const TENANT = process.env.MS_TENANT_ID || "";
const SCOPE = "mcp"; // scope exposé par l'inscription Entra (« Exposer une API ») : api://<ONLINE_CLIENT_ID>/mcp
const ENTRA_SCOPES = [`api://${CLIENT_ID}/${SCOPE}`, "offline_access"]; // demandés à Entra quoi qu'envoie l'assistant
export const MCP_URL = `${BASE}/mcp`; // adresse à saisir dans Claude, affichée par le portail
export const ICON_URL = `${BASE}/icon.png`; // logo annoncé aux assistants par adresse https (en plus des icônes intégrées)
const ISSUER = `${LOGIN}/${TENANT}/v2.0`; // jetons d'accès v2 (requestedAccessTokenVersion = 2 dans le manifeste)
// CIMD : assistants admis par l'adresse de leur document (vide = désactivé, comportement 1.7 inchangé).
const CIMD_CLIENTS = cimd.parseClients(process.env.ONLINE_CIMD_CLIENTS);
const CIMD_LOOPBACK = process.env.ONLINE_CIMD_ALLOW_LOOPBACK === "1"; // tests et poste de développement seulement
export const CIMD = CIMD_CLIENTS.length > 0;
const CALLBACK = `${BASE}/oauth/callback`; // adresse de retour du hub, enregistrée dans Entra quand CIMD est actif
const AS_ISSUER = BASE ? new URL(BASE).href : ""; // identifiant du serveur d'autorisation publié par le SDK (RFC 9207 : paramètre iss)

if (ENABLED) {
  const fail = (m) => { console.error(`[online] ${m}`); process.exit(1); };
  if (!sso.MODE) fail("CLOUDFLARE_TUNNEL=1 (ONLINE) exige le SSO Entra du portail (SSO_MODE=entra, ou mock en pré-production) : même annuaire, même identité");
  // La valeur reçue est citée (adresse publique, pas un secret) : une variable mal nommée dans Portainer arrive vide.
  if (!/^https?:\/\/[^/]+$/.test(BASE)) fail(`CLOUDFLARE_PUBLIC_URL (ONLINE_URL) doit être l'adresse publique sans chemin, ex. https://charlois-test.clevoa.fr ; reçu : ${BASE ? JSON.stringify(BASE) : "vide (variable absente ou mal nommée dans la stack ?)"}`);
  if (IS_PROD && !BASE.startsWith("https://")) fail("CLOUDFLARE_PUBLIC_URL (ONLINE_URL) doit être en https en production");
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(BASE)) fail("CLOUDFLARE_PUBLIC_URL (ONLINE_URL) doit être en https (http seulement en local)");
  if (!CLIENT_ID || !CLIENT_SECRET) fail("ENTRAID_CLAUDE_CLIENT_ID et ENTRAID_CLAUDE_CLIENT_SECRET (ONLINE_CLIENT_ID et ONLINE_CLIENT_SECRET dans le conteneur) sont requis");
  if (CLIENT_SECRET.length < 16) fail("ENTRAID_CLAUDE_CLIENT_SECRET trop court : copier la valeur du secret Entra, pas son identifiant");
  if (!(PORT > 0 && PORT < 65536) || PORT === Number(process.env.PORT || 8080)) fail("ONLINE_PORT doit être un port distinct de celui du portail");
  if (REDIRECTS.some((u) => !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(u))) fail("ENTRAID_CLAUDE_REDIRECT_URIS (ONLINE_REDIRECT_URIS) : https seulement (boucle locale tolérée)");
  if (CIMD_LOOPBACK && IS_PROD) fail("ONLINE_CIMD_ALLOW_LOOPBACK est interdit en production");
  for (const id of CIMD_CLIENTS) {
    const why = cimd.checkId(id, { loopback: CIMD_LOOPBACK });
    if (why) fail(`ENTRAID_CIMD_CLIENTS (ONLINE_CIMD_CLIENTS) : ${JSON.stringify(id)} refusé (${why}) ; valeurs admises : vide, on, ou des adresses https de documents CIMD`);
  }
}

const client = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uris: REDIRECTS, token_endpoint_auth_method: "client_secret_post",
  grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };

/** Le jeton est-il demandé pour ce hub ? (RFC 8707) : absent, ou égal à l'adresse de /mcp, au fragment et à la barre finale près. */
const forUs = (r) => !r || String(r.href ?? r).replace(/#.*$/, "").replace(/\/$/, "") === MCP_URL;

// CIMD : autorisations en cours (10 min, le temps de se connecter chez Entra) et codes du hub (5 min, échangés en quelques secondes).
const pending = cimd.onceMap({ ttlMs: 10 * 60_000 });
const codes = cimd.onceMap({ ttlMs: 5 * 60_000 });
const txCookie = (tx) => `clevoa_oauth_${tx.slice(0, 16)}`; // un témoin par connexion : deux onglets ne se gênent pas
const sameText = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const s256 = (v) => createHash("sha256").update(v).digest("base64url");

/** Relais du SDK, avec trois ajustements pour Entra : scopes de l'inscription imposés, paramètre `resource` vérifié ici puis
 *  retiré (Entra v2 travaille par scope et refuse un `resource` qui ne correspond pas), refus d'Entra rendus en invalid_grant
 *  (l'assistant propose alors de se reconnecter, au lieu d'une erreur serveur). */
class EntraRelay extends ProxyOAuthServerProvider {
  async authorize(c, params, res) {
    if (!forUs(params.resource)) throw new InvalidTargetError("resource inconnue de ce serveur");
    if (!CIMD) return super.authorize(c, { ...params, scopes: ENTRA_SCOPES, resource: undefined }, res);
    // CIMD actif (tous les clients) : Entra renvoie au hub, avec le défi PKCE de l'assistant ; un témoin lie le retour à ce navigateur.
    const tx = randomBytes(24).toString("base64url"), nonce = randomBytes(24).toString("base64url");
    pending.put(tx, { clientId: c.client_id, redirectUri: params.redirectUri, state: params.state, challenge: params.codeChallenge, nonce });
    res.cookie(txCookie(tx), nonce, { httpOnly: true, sameSite: "lax", secure: BASE.startsWith("https://"), path: "/oauth/callback", maxAge: 10 * 60_000 });
    return super.authorize(client, { ...params, redirectUri: CALLBACK, state: tx, scopes: ENTRA_SCOPES, resource: undefined }, res);
  }
  async exchangeAuthorizationCode(c, code, verifier, redirectUri, resource) {
    if (!forUs(resource)) throw new InvalidTargetError("resource inconnue de ce serveur");
    if (!CIMD) return refused(() => super.exchangeAuthorizationCode(c, code, verifier, redirectUri, undefined), "code");
    // Code du hub : usage unique, même client, même adresse de retour, PKCE vérifié ici puis par Entra (même défi).
    const g = codes.take(code);
    if (!g || g.clientId !== c.client_id) throw new InvalidGrantError("code inconnu, expire ou deja utilise");
    if (redirectUri && redirectUri !== g.redirectUri) throw new InvalidGrantError("redirect_uri differente de celle de l'autorisation");
    if (!verifier || s256(verifier) !== g.challenge) throw new InvalidGrantError("code_verifier invalide");
    return refused(() => super.exchangeAuthorizationCode(client, g.entraCode, verifier, CALLBACK, undefined), "code");
  }
  async exchangeRefreshToken(_c, refreshToken, _scopes, resource) {
    if (!forUs(resource)) throw new InvalidTargetError("resource inconnue de ce serveur");
    // Toujours l'inscription du hub (et son secret) : un client CIMD n'en a pas, Entra n'en connaît pas d'autre.
    return refused(() => super.exchangeRefreshToken(client, refreshToken, ENTRA_SCOPES, undefined), "refresh");
  }
}
/** Réponse 4xx d'Entra (code expiré, compte désactivé, consentement retiré) : invalid_grant ; panne réseau ou 5xx : erreur serveur. */
async function refused(run, during) {
  try { return await run(); } catch (e) {
    const status = Number(e.message?.match(/: (\d{3})$/)?.[1]);
    if (e instanceof ServerError && status >= 400 && status < 500) {
      console.error(`[online] ${during === "code" ? "échange de code" : "renouvellement"} refusé par Entra (${status}) : code expiré, compte refusé ou secret ONLINE_CLIENT_SECRET expiré`); // jamais le jeton
      throw new InvalidGrantError("refuse par Microsoft Entra ID : se reconnecter");
    }
    throw e;
  }
}

// Clés publiques d'Entra, mises en cache et renouvelées par jose (rotation des clés de signature de Microsoft).
const keys = createRemoteJWKSet(new URL(`${LOGIN}/${TENANT}/discovery/v2.0/keys`), { timeoutDuration: 5000 });

/** Jeton d'accès Entra : signature, émetteur, audience (notre inscription), locataire, application cliente (le connecteur Claude,
 *  pas une autre application du locataire consentie à notre API), scope délégué (jamais un jeton d'application), expiration. */
export async function verify(token) {
  let c;
  try {
    ({ payload: c } = await jwtVerify(token, keys, { issuer: ISSUER, audience: [CLIENT_ID, `api://${CLIENT_ID}`], algorithms: ["RS256"], clockTolerance: 60 }));
  } catch (e) {
    if (e instanceof joseErrors.JOSEError && !(e instanceof joseErrors.JWKSTimeout)) throw new InvalidTokenError(`jeton refuse (${e.code})`);
    throw new ServerError("cles d'Entra indisponibles"); // panne d'Entra : pas une raison de déconnecter l'assistant
  }
  // Messages en ASCII : le SDK les recopie dans l'en-tête WWW-Authenticate (RFC 6750 § 3).
  const bad = (m) => { throw new InvalidTokenError(`jeton refuse (${m})`); };
  if (String(c.tid).toLowerCase() !== TENANT.toLowerCase()) bad("locataire");
  if ((c.azp ?? c.appid) !== CLIENT_ID) bad("application cliente");
  if (typeof c.oid !== "string" || !c.oid) bad("identite absente");
  const scopes = typeof c.scp === "string" ? c.scp.split(" ") : [];
  if (!scopes.includes(SCOPE)) bad("scope");
  return { token, clientId: CLIENT_ID, scopes, expiresAt: c.exp, resource: new URL(MCP_URL),
    extra: { oid: c.oid, tid: c.tid, upn: c.preferred_username || c.upn || "", name: c.name || "", given: c.given_name || "" } };
}

/** Clé du collaborateur : celle que le SSO du portail lui a déjà liée (mêmes connexions Sage, Salesforce…), ou une clé neuve liée
 *  à son identité Entra s'il n'est jamais passé par le portail. Aucune écriture pour un collaborateur déjà connu. */
export function keyFor({ oid, tid, upn, name, given }) {
  const known = store.findSso(oid, tid);
  if (known) return known;
  const key = store.create();
  store.setSso(key, { sub: oid, tid, upn, name, given, email: upn || null });
  return key;
}

const FAVICON = readFileSync(new URL("./public/favicon.ico", import.meta.url));
const ICON = readFileSync(new URL("./public/brand/clevoa-icone-app-256.png", import.meta.url));
const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Cache-Control": "no-store" };

/** Application du port public : métadonnées, /authorize, /token (relayés vers Entra) et /mcp. Rien d'autre : ni portail, ni clé
 *  statique, ni SSE, ni supervision, ni diagnostic. `mcp` = [...middlewares, gestionnaire] de /mcp du hub, appelés avec req.key. */
export function app(mcp) {
  const a = express();
  a.disable("x-powered-by");
  a.set("trust proxy", Number(process.env.ONLINE_TRUST_PROXY ?? 1)); // cloudflared devant : propre à ce port, indépendant du portail
  a.use((_req, res, next) => { res.set(SECURITY_HEADERS); next(); });
  const registry = cimd.createRegistry({ clients: CIMD_CLIENTS, redirects: REDIRECTS, loopback: CIMD_LOOPBACK });
  const provider = new EntraRelay({
    endpoints: { authorizationUrl: `${LOGIN}/${TENANT}/oauth2/v2.0/authorize`, tokenUrl: `${LOGIN}/${TENANT}/oauth2/v2.0/token` }, // ni révocation ni inscription : Entra n'en propose pas
    verifyAccessToken: verify,
    getClient: async (id) => (id === CLIENT_ID ? client : CIMD ? registry.getClient(id) : undefined),
  });
  // Toutes les demandes de jeton de Claude viennent des quelques adresses d'Anthropic : le plafond par adresse du SDK (50 par 15 min)
  // couperait les renouvellements de tous les collaborateurs. Plafond relevé ; la règle WAF de Cloudflare filtre en amont.
  const generous = { windowMs: 15 * 60_000, max: 1000 };
  // Refus du relais OAuth écrits au journal, sans secret ni code : le 06/11/2026, un secret mal recopié dans ChatGPT était
  // refusé sans aucune trace. Les messages du SDK (« Invalid client_secret », « Unregistered redirect_uri »…) ne citent aucune valeur.
  a.use(["/authorize", "/token"], (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400) console.error(`[online] ${req.baseUrl || req.path} refusé (${res.statusCode}) : ${body?.error ?? "erreur"}${body?.error_description ? ` – ${body.error_description}` : ""}`);
      return json(body);
    };
    next();
  });
  // Secret en en-tête (client_secret_basic, méthode par défaut de nombreux clients OAuth) : recopié dans le corps, où le SDK le lit.
  a.post("/token", express.urlencoded({ extended: false, limit: "16kb" }), (req, _res, next) => {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || "");
    if (m && req.body && !req.body.client_secret) {
      const raw = Buffer.from(m[1], "base64").toString("utf8"), i = raw.indexOf(":");
      const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } }; // RFC 6749 § 2.3.1
      if (i > 0) { req.body.client_id ??= dec(raw.slice(0, i)); req.body.client_secret = dec(raw.slice(i + 1)); }
    }
    next();
  });
  if (CIMD) {
    // Métadonnées : CIMD annoncé, et paramètre iss dans chaque réponse d'autorisation (RFC 9207 ; ChatGPT utilise alors son
    // document et son adresse de retour stables). « none » figure déjà dans token_endpoint_auth_methods_supported (SDK).
    a.use("/.well-known/oauth-authorization-server", (_req, res, next) => {
      const json = res.json.bind(res);
      res.json = (body) => json(res.statusCode === 200 ? { ...body, client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true } : body);
      next();
    });
    // Erreurs renvoyées par le SDK à l'assistant depuis /authorize : iss ajouté aussi (le départ vers Entra n'est pas touché).
    a.use("/authorize", (_req, res, next) => {
      const redirect = res.redirect.bind(res);
      res.redirect = (...args) => {
        const i = args.length - 1, to = new URL(String(args[i]));
        if (!to.href.startsWith(`${LOGIN}/`) && to.searchParams.has("error")) { to.searchParams.set("iss", AS_ISSUER); args[i] = to.href; }
        return redirect(...args);
      };
      next();
    });
    // Retour d'Entra : le hub vérifie l'autorisation en cours et le témoin du navigateur, puis renvoie à l'assistant son propre code.
    a.get("/oauth/callback", (req, res) => {
      const tx = typeof req.query.state === "string" ? req.query.state : "";
      const p = tx && pending.take(tx);
      const fail = (m) => { console.error(`[online] /oauth/callback refusé : ${m}`); res.status(400).json({ error: "invalid_request", error_description: m }); };
      if (!p) return fail("connexion inconnue ou expirée : la relancer depuis l'assistant");
      const name = txCookie(tx), got = (req.headers.cookie || "").split(/;\s*/).find((k) => k.startsWith(`${name}=`))?.slice(name.length + 1);
      res.clearCookie(name, { path: "/oauth/callback" });
      if (!sameText(got, p.nonce)) return fail("navigateur différent de celui qui a commencé la connexion");
      const back = new URL(p.redirectUri), code = typeof req.query.code === "string" ? req.query.code : "";
      if (code) {
        const own = randomBytes(32).toString("base64url");
        codes.put(own, { entraCode: code, clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge });
        back.searchParams.set("code", own);
      } else {
        const error = ["access_denied", "consent_required", "interaction_required", "login_required", "temporarily_unavailable"].includes(req.query.error) ? req.query.error : "server_error";
        console.error(`[online] connexion refusée par Entra (${error}) pour ${p.clientId}`); // jamais le détail d'Entra ni un code
        back.searchParams.set("error", error);
      }
      if (p.state) back.searchParams.set("state", p.state);
      back.searchParams.set("iss", AS_ISSUER);
      res.redirect(302, back.href);
    });
  }
  a.use(mcpAuthRouter({ provider, issuerUrl: new URL(BASE), resourceServerUrl: new URL(MCP_URL), scopesSupported: [SCOPE],
    resourceName: process.env.INSTANCE_LABEL || "Clevoa AI Gateway", tokenOptions: { rateLimit: generous }, authorizationOptions: { rateLimit: generous } }));
  const auth = requireBearerAuth({ verifier: provider, requiredScopes: [SCOPE], expectedResource: new URL(MCP_URL),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(MCP_URL)) });
  const bind = (req, _res, next) => { req.key = keyFor(req.auth.extra); next(); };
  // Jeton vérifié AVANT de lire le corps de la requête.
  a.post("/mcp", auth, bind, express.json({ limit: "1mb" }), ...mcp);
  a.all("/mcp", (_req, res) => res.status(405).json({ error: "Utilisez POST (mode sans état)." }));
  a.get("/health", (_req, res) => res.json({ ok: true }));
  // Icône du nom public, pour les assistants qui la cherchent à la racine du domaine (chemin autorisé par la règle WAF 1).
  a.get("/favicon.ico", (_req, res) => res.type("image/x-icon").set("Cache-Control", "public, max-age=86400").send(FAVICON));
  a.get("/icon.png", (_req, res) => res.type("image/png").set("Cache-Control", "public, max-age=86400").send(ICON));
  a.use((_req, res) => res.status(404).json({ error: "introuvable" }));
  return a;
}

/** Garde du portail quand l'accès en ligne est actif : une requête relayée par Cloudflare (en-têtes posés par son réseau) n'a rien
 *  à faire sur le port interne. Protège contre une route de tunnel mal saisie (:8080 au lieu de :8090) ou modifiée. */
export const portalGuard = (req, res, next) => (ENABLED && (req.headers["cf-connecting-ip"] || req.headers["cf-ray"])
  ? res.status(403).json({ error: "Le portail n'est pas accessible par l'accès en ligne." }) : next());

export function start(mcp) {
  if (!ENABLED) return;
  app(mcp).listen(PORT, () => {
    console.log(`[online] accès en ligne actif : ${MCP_URL} (port ${PORT}, annuaire ${TENANT})`);
    if (CIMD) console.log(`[online] inscription automatique (CIMD, expérimental) : ${CIMD_CLIENTS.join(", ")} ; adresse de retour à enregistrer dans Entra : ${CALLBACK}`);
  });
}
