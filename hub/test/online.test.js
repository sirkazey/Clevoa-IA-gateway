// Accès en ligne pour Claude (ONLINE=on) : relais OAuth du SDK vers Entra (simulé par le bouchon), jetons d'accès Entra vérifiés
// par le hub, rattachement à la clé du SSO du portail, port public cloisonné. Aucun réseau réel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { startUpstream } from "./helpers/upstream.js";
import { startHub, freePort } from "./helpers/hub.js";
import { sign } from "./helpers/jwt.js";

const CLIENT = "online-client-id", SECRET = "online-client-secret-0123456789";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const noFollow = { redirect: "manual" };
let up, hub, port, base;

before(async () => {
  up = await startUpstream();
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  hub = await startHub({ upstreamUrl: up.url, env: { APP_ENV: "preprod", SSO_MODE: "mock", ONLINE: "on", ONLINE_PORT: String(port), ONLINE_URL: base,
    ONLINE_CLIENT_ID: CLIENT, ONLINE_CLIENT_SECRET: SECRET } });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* port public pas encore ouvert */ } await new Promise((r) => setTimeout(r, 50)); }
});
after(async () => { await hub?.stop(); await up?.stop?.(); });

const now = () => Math.floor(Date.now() / 1000);
/** Jeton d'accès Entra v2 signé par l'annuaire simulé ; `over` remplace ou retire (undefined) des revendications. */
const entraToken = (over = {}, opts) => sign(Object.fromEntries(Object.entries({ iss: `${up.url}/ms/common/v2.0`, aud: CLIENT, tid: "common", azp: CLIENT,
  oid: "oid-marie", scp: "mcp", preferred_username: "marie@charlois.example", name: "Marie", iat: now(), nbf: now(), exp: now() + 3600, ...over }).filter(([, v]) => v !== undefined)), opts);

async function rpc(token, message) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(message) });
  const text = await r.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  let body = null; try { body = JSON.parse(data ? data.slice(6) : text); } catch { /* non JSON */ }
  return { status: r.status, headers: r.headers, body };
}
const tools = (token) => rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

test("Métadonnées : ressource protégée (RFC 9728) et serveur d'autorisation (RFC 8414) conformes à ce qu'exige Claude, sans inscription automatique", async () => {
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  assert.deepEqual(prm.authorization_servers, [`${base}/`]);
  assert.deepEqual(prm.scopes_supported, ["mcp"]);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.authorization_endpoint, `${base}/authorize`);
  assert.equal(as.token_endpoint, `${base}/token`);
  assert.equal(as.registration_endpoint, undefined, "client pré-enregistré par l'Owner : pas de DCR");
  assert.equal(as.revocation_endpoint, undefined, "Entra n'a pas de point de révocation : rien à relayer");
});

test("/mcp sans jeton : 401 avec WWW-Authenticate qui désigne les métadonnées (déclenche le « Connect » de Claude)", async () => {
  const r = await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));
});

test("Parcours Claude : /authorize relayé vers Entra (scope imposé, resource retiré, PKCE transmis), puis /token relayé avec le code_verifier", async () => {
  const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT, redirect_uri: CLAUDE, code_challenge: challenge, code_challenge_method: "S256",
    state: "etat-claude", scope: "mcp", resource: `${base}/mcp` });
  const a = await fetch(`${base}/authorize?${q}`, noFollow);
  assert.equal(a.status, 302);
  const entra = new URL(a.headers.get("location"));
  assert.equal(entra.origin + entra.pathname, `${up.url}/ms/common/oauth2/v2.0/authorize`);
  assert.equal(entra.searchParams.get("client_id"), CLIENT);
  assert.equal(entra.searchParams.get("redirect_uri"), CLAUDE, "Entra renvoie directement à Claude");
  assert.equal(entra.searchParams.get("code_challenge"), challenge);
  assert.equal(entra.searchParams.get("state"), "etat-claude");
  assert.equal(entra.searchParams.get("scope"), `api://${CLIENT}/mcp offline_access`);
  assert.equal(entra.searchParams.get("resource"), null, "Entra v2 travaille par scope");
  // Connexion de Marie chez Entra (simulé), retour vers Claude avec le code.
  entra.searchParams.set("mock_user", "marie");
  const code = new URL((await fetch(entra, noFollow)).headers.get("location")).searchParams.get("code");
  up.reset();
  const t = await fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE, client_id: CLIENT, client_secret: SECRET, resource: `${base}/mcp` }) });
  assert.equal(t.status, 200, await t.clone().text());
  const tokens = await t.json();
  assert.equal(tokens.access_token, "ms-token-marie", "jetons d'Entra rendus tels quels : le hub n'en délivre aucun");
  assert.equal(tokens.refresh_token, "ms-refresh-marie");
  const sent = new URLSearchParams(up.requests("/ms/common/oauth2/v2.0/token", "POST")[0].body);
  assert.equal(sent.get("code_verifier"), verifier, "PKCE vérifié par Entra");
  assert.equal(sent.get("resource"), null);
  assert.equal(sent.get("client_secret"), SECRET);
});

test("/authorize refuse un client inconnu, une adresse de retour autre que Claude et une ressource étrangère", async () => {
  const q = (o) => new URLSearchParams({ response_type: "code", client_id: CLIENT, redirect_uri: CLAUDE, code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s", ...o });
  const unknown = await fetch(`${base}/authorize?${q({ client_id: "autre-client" })}`, noFollow);
  assert.equal(unknown.status, 400);
  const evil = await fetch(`${base}/authorize?${q({ redirect_uri: "https://evil.example/callback" })}`, noFollow);
  assert.equal(evil.status, 400, "jamais de redirection vers une adresse non enregistrée");
  // Ressource étrangère (RFC 8707) : adresse de retour déjà validée, l'erreur repart vers Claude comme le veut OAuth, jamais vers Entra.
  const other = await fetch(`${base}/authorize?${q({ resource: "https://autre-serveur.example/mcp" })}`, noFollow);
  const back = new URL(other.headers.get("location"));
  assert.equal(back.origin + back.pathname, CLAUDE);
  assert.equal(back.searchParams.get("error"), "invalid_target");
  assert.equal(back.searchParams.get("state"), "s");
});

test("/token : mauvais secret refusé sans appel à Entra ; renouvellement refusé par Entra rendu en invalid_grant (Claude propose de se reconnecter)", async () => {
  up.reset();
  const bad = await fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "r", client_id: CLIENT, client_secret: "mauvais-secret-0123456789" }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid_client");
  assert.equal(up.requests("/ms/common/oauth2/v2.0/token").length, 0);
  up.state.msRefresh = "invalid_grant";
  const r = await fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "ms-refresh-marie", client_id: CLIENT, client_secret: SECRET, resource: `${base}/mcp` }) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "invalid_grant");
  const sent = new URLSearchParams(up.requests("/ms/common/oauth2/v2.0/token", "POST")[0].body);
  assert.equal(sent.get("scope"), `api://${CLIENT}/mcp offline_access`);
  assert.equal(sent.get("resource"), null);
  up.state.msRefresh = "plain";
  const ok = await fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "ms-refresh-marie", client_id: CLIENT, client_secret: SECRET }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).refresh_token, "ms-refresh-tourne", "rotation du refresh token par Entra transmise");
});

test("/mcp avec un jeton Entra valide : outils servis, collaborateur rattaché à SA clé du portail (mêmes connexions), sans écriture ensuite", async () => {
  // Marie passe d'abord par le SSO du portail : sa clé porte l'identité oid-marie.
  const start = await fetch(`${hub.url}/auth/sso`, noFollow);
  const tmp = start.headers.get("set-cookie").match(/mcp_key=([^;]+)/)[1];
  const st = new URL(start.headers.get("location")).searchParams.get("state");
  const cb = await fetch(`${hub.url}/auth/sso/callback?code=marie&state=${st}`, { headers: { cookie: `mcp_key=${tmp}` }, ...noFollow });
  const portalKey = cb.headers.get("set-cookie").match(/mcp_key=([^;]+)/)[1];
  const before = Object.keys(hub.readUsers()).length;
  const r = await tools(entraToken());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.result.tools.some((t) => t.name === "sagex3_query"));
  const users = hub.readUsers();
  assert.equal(Object.keys(users).length, before, "aucune clé créée : Marie retrouve celle du portail");
  assert.equal(users[portalKey].sso.sub, "oid-marie");
  assert.ok(users[portalKey].assistantAt, "« Assistant : branché » sur le portail");
});

test("/mcp : un collaborateur jamais passé par le portail reçoit une clé liée à son identité Entra, une seule", async () => {
  const paul = entraToken({ oid: "oid-paul", preferred_username: "paul@charlois.example", name: "Paul" });
  assert.equal((await tools(paul)).status, 200);
  assert.equal((await tools(paul)).status, 200);
  const keys = Object.entries(hub.readUsers()).filter(([, u]) => u.sso?.sub === "oid-paul");
  assert.equal(keys.length, 1);
  assert.equal(keys[0][1].email, "paul@charlois.example");
});

test("/mcp refuse les jetons qui ne sont pas des jetons délégués d'Entra pour le connecteur Claude de ce locataire", async () => {
  const refused = {
    "signature falsifiée": entraToken({}, { tamper: true }),
    "autre émetteur": entraToken({ iss: "https://login.microsoftonline.com/autre/v2.0" }),
    "autre locataire": entraToken({ tid: "autre-locataire" }),
    "autre audience (jeton Graph, jeton du portail)": entraToken({ aud: "00000003-0000-0000-c000-000000000000" }),
    "autre application cliente du locataire": entraToken({ azp: "autre-application" }),
    "jeton d'application sans scope délégué": entraToken({ scp: undefined, roles: ["mcp"] }),
    "sans identité": entraToken({ oid: undefined }),
    "expiré": entraToken({ exp: now() - 3600, iat: now() - 7200, nbf: now() - 7200 }),
    "clé MCP statique du portail": "test-key-alice-0123456789",
  };
  for (const [why, token] of Object.entries(refused)) {
    const r = await tools(token);
    assert.equal(r.status, 401, `${why} : ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_token");
  }
  assert.ok(!hub.logs().includes("eyJ"), "aucun jeton dans le journal");
  const h = (await tools(entraToken({ tid: "autre-locataire" }))).headers.get("www-authenticate");
  assert.match(h, /^[\x20-\x7e]+$/, "en-tête WWW-Authenticate en ASCII imprimable (RFC 6750) : Claude y lit resource_metadata pour se reconnecter");
});

test("Port public cloisonné : icône seulement ; ni portail, ni API du portail, ni SSE, ni supervision, ni diagnostic, ni départ OAuth des connecteurs", async () => {
  for (const path of ["/", "/index.html", "/favicon.svg", "/brand/clevoa-icone-app.svg", "/api/me", "/api/test/sagex3", "/sse", "/messages", "/metrics", "/metrics/prtg", "/auth/sso", "/auth/salesforce", "/register", "/revoke"]) {
    const r = await fetch(`${base}${path}`, noFollow);
    assert.equal(r.status, 404, `${path} : ${r.status}`);
  }
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  const ico = await fetch(`${base}/favicon.ico`);
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get("content-type"), "image/x-icon");
  assert.deepEqual([...new Uint8Array(await ico.arrayBuffer()).slice(0, 4)], [0, 0, 1, 0], "fichier ICO");
  const h = (await fetch(`${base}/.well-known/oauth-authorization-server`)).headers;
  assert.equal(h.get("x-powered-by"), null);
  assert.equal(h.get("x-content-type-options"), "nosniff");
});

test("Portail interne : une requête relayée par Cloudflare (route de tunnel mal saisie vers 8080) est refusée ; sans ces en-têtes, inchangé", async () => {
  for (const header of [{ "cf-ray": "8f0000000000-CDG" }, { "cf-connecting-ip": "203.0.113.7" }]) {
    for (const path of ["/", "/api/me", "/auth/sso", "/mcp"]) {
      const r = await fetch(`${hub.url}${path}`, { headers: header, ...noFollow });
      assert.equal(r.status, 403, `${path} ${JSON.stringify(header)} : ${r.status}`);
    }
  }
  assert.equal((await fetch(`${hub.url}/api/me`)).status, 200);
});

test("Verrous de démarrage : SSO absent, secret absent ou trop court, URL invalide, http en production, même port que le portail", async () => {
  const env = { ONLINE: "on", ONLINE_URL: "https://mcp.exemple.fr", ONLINE_CLIENT_ID: CLIENT, ONLINE_CLIENT_SECRET: SECRET, SSO_MODE: "mock", APP_ENV: "preprod" };
  const cases = [
    [{ SSO_MODE: "" }, /exige le SSO Entra/],
    [{ ONLINE_CLIENT_SECRET: "" }, /ONLINE_CLIENT_ID et ONLINE_CLIENT_SECRET/],
    [{ ONLINE_CLIENT_SECRET: "court" }, /trop court/],
    [{ ONLINE_URL: "https://mcp.exemple.fr/chemin" }, /sans chemin.*reçu : "https:\/\/mcp\.exemple\.fr\/chemin"/],
    [{ ONLINE_URL: "" }, /reçu : vide \(variable absente ou mal nommée/],
    [{ ONLINE_REDIRECT_URIS: "http://claude.example/cb" }, /https seulement/],
    [{ ONLINE_URL: "http://mcp.exemple.fr" }, /en https \(http seulement en local\)/],
    [{ APP_ENV: "production", SSO_MODE: "entra", MS_LOGIN_URL: "", MS_TENANT_ID: "11111111-2222-3333-4444-555555555555", ONLINE_URL: "http://mcp.exemple.fr" }, /https en production/],
    [{ PORT: "18080", ONLINE_PORT: "18080" }, /port distinct/],
  ];
  for (const [over, err] of cases) await assert.rejects(startHub({ upstreamUrl: up.url, env: { ...env, ONLINE_PORT: String(await freePort()), ...over } }), err, JSON.stringify(over));
});

test("Activation par CLOUDFLARE_TUNNEL=1 (ONLINE=1 dans le conteneur), comme ONLINE=on", async () => {
  const p = await freePort();
  const h = await startHub({ upstreamUrl: up.url, env: { APP_ENV: "preprod", SSO_MODE: "mock", ONLINE: "1", ONLINE_PORT: String(p), ONLINE_URL: `http://127.0.0.1:${p}`, ONLINE_CLIENT_ID: CLIENT, ONLINE_CLIENT_SECRET: SECRET } });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${p}/health`)).ok) break; } catch { /* pas encore ouvert */ } await new Promise((r) => setTimeout(r, 50)); }
    assert.equal((await fetch(`http://127.0.0.1:${p}/health`)).status, 200);
    assert.match(h.logs(), /\[online\] accès en ligne actif/);
  } finally { await h.stop(); }
});

test("Désactivé par défaut : sans ONLINE=on (ou avec ONLINE=0, valeur par défaut de Compose), aucun port public n'est ouvert", async () => {
  const p = await freePort();
  const h = await startHub({ upstreamUrl: up.url, env: { ONLINE: "0", ONLINE_PORT: String(p), ONLINE_URL: `http://127.0.0.1:${p}`, ONLINE_CLIENT_ID: CLIENT, ONLINE_CLIENT_SECRET: SECRET } });
  try {
    await assert.rejects(fetch(`http://127.0.0.1:${p}/health`));
    assert.ok(!h.logs().includes("[online]"));
  } finally { await h.stop(); }
});
