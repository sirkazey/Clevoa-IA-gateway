// Accès en ligne pour Claude (claude.ai web, mobile et application de bureau) : port séparé, publié par un tunnel Cloudflare, qui ne
// sert que l'OAuth et /mcp. Désactivé par défaut (ONLINE=on ou 1, soit CLOUDFLARE_TUNNEL=1 dans la stack). Aucun serveur d'autorisation maison : le relais OAuth du SDK MCP
// (ProxyOAuthServerProvider) publie des métadonnées conformes (PKCE S256, RFC 8414, RFC 9728) et transmet connexion et jetons à
// Entra ID ; Entra authentifie (double authentification, accès conditionnel), délivre, renouvelle et révoque. Le hub ne délivre
// aucun jeton : il vérifie ceux d'Entra (signature, émetteur, locataire, audience, application cliente, scope) avec jose, puis
// rattache le collaborateur à sa clé par son identité Entra, comme le SSO du portail (même oid, même locataire, mêmes connexions).
// Client Claude pré-enregistré : inscription d'application Entra dédiée, dont l'Owner saisit l'identifiant et le secret dans Claude.
import express from "express";
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import { InvalidGrantError, InvalidTargetError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { store } from "./store.js";
import * as sso from "./sso.js";
import { IS_PROD } from "./version.js";

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
const MCP_URL = `${BASE}/mcp`;
const ISSUER = `${LOGIN}/${TENANT}/v2.0`; // jetons d'accès v2 (requestedAccessTokenVersion = 2 dans le manifeste)

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
}

const client = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uris: REDIRECTS, token_endpoint_auth_method: "client_secret_post",
  grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };

/** Le jeton est-il demandé pour ce hub ? (RFC 8707) : absent, ou égal à l'adresse de /mcp, au fragment et à la barre finale près. */
const forUs = (r) => !r || String(r.href ?? r).replace(/#.*$/, "").replace(/\/$/, "") === MCP_URL;

/** Relais du SDK, avec trois ajustements pour Entra : scopes de l'inscription imposés, paramètre `resource` vérifié ici puis
 *  retiré (Entra v2 travaille par scope et refuse un `resource` qui ne correspond pas), refus d'Entra rendus en invalid_grant
 *  (l'assistant propose alors de se reconnecter, au lieu d'une erreur serveur). */
class EntraRelay extends ProxyOAuthServerProvider {
  async authorize(c, params, res) {
    if (!forUs(params.resource)) throw new InvalidTargetError("resource inconnue de ce serveur");
    return super.authorize(c, { ...params, scopes: ENTRA_SCOPES, resource: undefined }, res);
  }
  async exchangeAuthorizationCode(c, code, verifier, redirectUri, resource) {
    if (!forUs(resource)) throw new InvalidTargetError("resource inconnue de ce serveur");
    return refused(() => super.exchangeAuthorizationCode(c, code, verifier, redirectUri, undefined), "code");
  }
  async exchangeRefreshToken(c, refreshToken, _scopes, resource) {
    if (!forUs(resource)) throw new InvalidTargetError("resource inconnue de ce serveur");
    return refused(() => super.exchangeRefreshToken(c, refreshToken, ENTRA_SCOPES, undefined), "refresh");
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
    extra: { oid: c.oid, tid: c.tid, upn: c.preferred_username || c.upn || "", name: c.name || "" } };
}

/** Clé du collaborateur : celle que le SSO du portail lui a déjà liée (mêmes connexions Sage, Salesforce…), ou une clé neuve liée
 *  à son identité Entra s'il n'est jamais passé par le portail. Aucune écriture pour un collaborateur déjà connu. */
export function keyFor({ oid, tid, upn, name }) {
  const known = store.findSso(oid, tid);
  if (known) return known;
  const key = store.create();
  store.setSso(key, { sub: oid, tid, upn, name, email: upn || null });
  return key;
}

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Cache-Control": "no-store" };

/** Application du port public : métadonnées, /authorize, /token (relayés vers Entra) et /mcp. Rien d'autre : ni portail, ni clé
 *  statique, ni SSE, ni supervision, ni diagnostic. `mcp` = [...middlewares, gestionnaire] de /mcp du hub, appelés avec req.key. */
export function app(mcp) {
  const a = express();
  a.disable("x-powered-by");
  a.set("trust proxy", Number(process.env.ONLINE_TRUST_PROXY ?? 1)); // cloudflared devant : propre à ce port, indépendant du portail
  a.use((_req, res, next) => { res.set(SECURITY_HEADERS); next(); });
  const provider = new EntraRelay({
    endpoints: { authorizationUrl: `${LOGIN}/${TENANT}/oauth2/v2.0/authorize`, tokenUrl: `${LOGIN}/${TENANT}/oauth2/v2.0/token` }, // ni révocation ni inscription : Entra n'en propose pas
    verifyAccessToken: verify,
    getClient: async (id) => (id === CLIENT_ID ? client : undefined),
  });
  // Toutes les demandes de jeton de Claude viennent des quelques adresses d'Anthropic : le plafond par adresse du SDK (50 par 15 min)
  // couperait les renouvellements de tous les collaborateurs. Plafond relevé ; la règle WAF de Cloudflare filtre en amont.
  const generous = { windowMs: 15 * 60_000, max: 1000 };
  a.use(mcpAuthRouter({ provider, issuerUrl: new URL(BASE), resourceServerUrl: new URL(MCP_URL), scopesSupported: [SCOPE],
    resourceName: process.env.INSTANCE_LABEL || "Clevoa AI Gateway", tokenOptions: { rateLimit: generous }, authorizationOptions: { rateLimit: generous } }));
  const auth = requireBearerAuth({ verifier: provider, requiredScopes: [SCOPE], expectedResource: new URL(MCP_URL),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(MCP_URL)) });
  const bind = (req, _res, next) => { req.key = keyFor(req.auth.extra); next(); };
  // Jeton vérifié AVANT de lire le corps de la requête.
  a.post("/mcp", auth, bind, express.json({ limit: "1mb" }), ...mcp);
  a.all("/mcp", (_req, res) => res.status(405).json({ error: "Utilisez POST (mode sans état)." }));
  a.get("/health", (_req, res) => res.json({ ok: true }));
  a.use((_req, res) => res.status(404).json({ error: "introuvable" }));
  return a;
}

/** Garde du portail quand l'accès en ligne est actif : une requête relayée par Cloudflare (en-têtes posés par son réseau) n'a rien
 *  à faire sur le port interne. Protège contre une route de tunnel mal saisie (:8080 au lieu de :8090) ou modifiée. */
export const portalGuard = (req, res, next) => (ENABLED && (req.headers["cf-connecting-ip"] || req.headers["cf-ray"])
  ? res.status(403).json({ error: "Le portail n'est pas accessible par l'accès en ligne." }) : next());

export function start(mcp) {
  if (!ENABLED) return;
  app(mcp).listen(PORT, () => console.log(`[online] accès en ligne actif : ${MCP_URL} (port ${PORT}, annuaire ${TENANT})`));
}
