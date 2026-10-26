// Mires d'authentification du bouchon : OAuth2 "authorization code" avec refresh (Salesforce, Microsoft, Dropbox, IdP de Sage),
// clés d'API / Basic (Sage X3 Syracuse), jeton ou X-Api-Key (MyReport). Les jetons d'accès expirent (TOKEN_TTL_MIN) pour
// exercer le renouvellement automatique du hub ; les refresh tokens n'expirent pas.
import { randomBytes, createHash, generateKeyPairSync, createSign } from "node:crypto";
import { USERS } from "./data.js";

const TTL = Number(process.env.TOKEN_TTL_MIN ?? 10) * 60_000;
const codes = new Map(); // code -> { sys, user, exp }

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const dec = (t) => { try { return JSON.parse(Buffer.from(t, "base64url").toString()); } catch { return null; } };
// Clé de signature des id_token simulés (RS256), publiée comme celle d'Entra : le hub vérifie la signature (openid-client).
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "bouchon", alg: "RS256", use: "sig" }] };
export function signJwt(claims) {
  const head = enc({ alg: "RS256", typ: "JWT", kid: "bouchon" }), body = enc(claims);
  return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url")}`;
}
/** Métadonnées OIDC d'un annuaire simulé (émetteur `issuer`, clés publiées à `keys`). */
export const discovery = (issuer, authorize, token, keys) => ({ issuer, authorization_endpoint: authorize, token_endpoint: token, jwks_uri: keys,
  response_types_supported: ["code"], subject_types_supported: ["pairwise"], id_token_signing_alg_values_supported: ["RS256"] });
// id_token Entra simulé, signé.
const idToken = (user, base, { tenant, clientId }) => signJwt({ iss: `${base}/ms/${tenant}/v2.0`, sub: `pairwise-${user.split("@")[0]}`, aud: clientId, tid: tenant, oid: `oid-${user.split("@")[0]}`,
  preferred_username: user, email: user, name: USERS[user].name, iat: Math.floor(Date.now() / 1000), exp: Math.floor((Date.now() + TTL) / 1000) });

/** Émet un couple de jetons pour un système et un utilisateur (`ctx` : locataire et client_id, pour l'id_token Entra). */
export function issue(sys, user, base, ctx) {
  const extra = { sf: { instance_url: base, id: `${base}/id/00D/${user}`, issued_at: String(Date.now()) }, ms: { scope: "User.Read Files.Read.All Sites.Read.All" }, dbx: { account_id: `dbid:${user}`, uid: "1" }, sage: {} }[sys];
  if (sys === "ms") extra.id_token = idToken(user, base, ctx);
  return { access_token: enc({ sys, user, exp: Date.now() + TTL, r: randomBytes(4).toString("hex") }), refresh_token: enc({ sys, user, refresh: true, r: randomBytes(4).toString("hex") }), token_type: "Bearer", expires_in: TTL / 1000, ...extra };
}

/** Utilisateur porté par un jeton d'accès valide pour ce système, sinon null (expiré, autre système, inconnu). */
export const bearerUser = (req, sys) => {
  const t = dec(req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] || "");
  return t && t.sys === sys && !t.refresh && t.exp > Date.now() && USERS[t.user] ? t.user : null;
};

/** Page de connexion simulée : on choisit le collaborateur, le bouchon renvoie un code vers redirect_uri. */
export function authorizePage(sys, label) {
  return (req, res) => {
    const { redirect_uri, state, client_id, code_challenge } = req.query;
    if (!redirect_uri || !client_id) return res.status(400).send("redirect_uri et client_id requis");
    let back; try { back = new URL(String(redirect_uri)); } catch { back = null; }
    if (!back || !/^https?:$/.test(back.protocol)) return res.status(400).send("redirect_uri invalide (URL http(s) attendue)");
    if (state) back.searchParams.set("state", String(state));
    if (req.query.prompt === "none") { // comme Entra : sans interface, réussit seulement si login_hint désigne un collaborateur connu, sinon login_required
      if (USERS[req.query.login_hint]) return issueCode(res, sys, String(req.query.login_hint), back.origin + back.pathname, state, code_challenge);
      back.searchParams.set("error", "login_required"); return res.redirect(back.href);
    }
    back.searchParams.set("error", "access_denied"); back.searchParams.set("error_description", "Refus");
    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const q = (u) => new URLSearchParams({ sys, user: u, redirect_uri: back.origin + back.pathname, state: state || "", code_challenge: code_challenge || "" });
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Connexion ${label} (bouchon)</title>
<body style="font:16px system-ui;max-width:420px;margin:60px auto"><h2>${label} — connexion simulée</h2>
<!-- nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- mire de simulation : redirect_uri validée (URL http(s) parsée), client_id échappé --><p>Application : <code>${esc(client_id)}</code></p><p>Choisissez le collaborateur :</p>
${Object.entries(USERS).map(([u, p]) => `<p><a href="/_stub/approve?${q(u)}" style="display:block;padding:12px;border:1px solid #999;border-radius:8px;text-decoration:none;color:#111">${p.name} — ${p.role}<br><small>${u}</small></a></p>`).join("")}
<p><a href="${esc(back.href)}">Refuser</a></p></body>`);
  };
}

function issueCode(res, sys, user, redirect_uri, state, challenge) {
  const code = randomBytes(8).toString("hex");
  codes.set(code, { sys, user, exp: Date.now() + 120_000, challenge: String(challenge || "") }); // PKCE : le code est lié au code_challenge du départ
  const u = new URL(redirect_uri); u.searchParams.set("code", code); if (state) u.searchParams.set("state", String(state));
  res.redirect(u.href);
}
export function approve(req, res) {
  const { sys, user, redirect_uri, state, code_challenge } = req.query;
  if (!USERS[user]) return res.status(400).send("utilisateur inconnu");
  let back; try { back = new URL(String(redirect_uri)); } catch { back = null; } // même contrôle que la mire : URL http(s) seulement
  if (!back || !/^https?:$/.test(back.protocol)) return res.status(400).send("redirect_uri invalide (URL http(s) attendue)");
  issueCode(res, sys, user, back.href, state, code_challenge);
}

/** Endpoint /token : échange d'un code ou d'un refresh_token. */
export function tokenEndpoint(sys) {
  return (req, res) => {
    const p = req.body || {};
    if (!p.client_id) return res.status(400).json({ error: "invalid_client" });
    const base = `${req.protocol}://${req.headers.host}`, ctx = { tenant: req.params.tenant || "common", clientId: p.client_id };
    if (p.grant_type === "authorization_code") {
      const c = codes.get(p.code); codes.delete(p.code);
      if (!c || c.sys !== sys || c.exp < Date.now()) return res.status(400).json({ error: "invalid_grant", error_description: "code inconnu ou expiré" });
      if (c.challenge && createHash("sha256").update(String(p.code_verifier || "")).digest("base64url") !== c.challenge) return res.status(400).json({ error: "invalid_grant", error_description: "PKCE : code_verifier invalide" });
      return res.json(issue(sys, c.user, base, ctx));
    }
    if (p.grant_type === "refresh_token") {
      const t = dec(p.refresh_token || "");
      if (!t?.refresh || t.sys !== sys) return res.status(400).json({ error: "invalid_grant", error_description: "refresh_token invalide" });
      const { refresh_token, ...fresh } = issue(sys, t.user, base, ctx); // comme Salesforce : pas de nouveau refresh_token
      return res.json(fresh);
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  };
}

/** Sage X3 Syracuse : jeton OAuth de l'IdP, clé d'API en Bearer, ou Basic login:clé. */
export function sageUser(req) {
  const h = req.headers.authorization || "";
  const b = bearerUser(req, "sage"); if (b) return b;
  const key = h.match(/^Bearer (.+)$/)?.[1];
  if (key) return Object.keys(USERS).find((u) => USERS[u].sageKey === key) || null;
  const basic = h.match(/^Basic (.+)$/)?.[1];
  if (basic) { const [login, pwd] = Buffer.from(basic, "base64").toString().split(":"); return Object.keys(USERS).find((u) => USERS[u].sageLogin === login && USERS[u].sageKey === pwd) || null; }
  return null;
}

/** MyReport Server : jeton personnel en Bearer ou en X-Api-Key. */
export function myreportUser(req) {
  const key = req.headers["x-api-key"] || req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  return Object.keys(USERS).find((u) => USERS[u].myreportKey === key) || null;
}
