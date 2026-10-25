// Serveur OAuth du hub (prototype « connexion en un clic », OAUTH=on) : le client OAuth du SDK MCP joue l'assistant (comme
// Claude : découverte RFC 9728, inscription, PKCE, resource), trois annuaires simulés (Entra Charlois, Entra Oakwood, Google de
// la société acquise). Vérifie le parcours complet jusqu'à l'appel d'un outil, la politique d'accès par annuaire, la liaison
// d'identité, la rotation et le rejeu des refresh tokens, la revalidation auprès de l'annuaire, la révocation, la persistance,
// le cloisonnement du port public et les verrous de démarrage.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { startUpstream } from "./helpers/upstream.js";
import { startHub, freePort, KEY, connectedUser } from "./helpers/hub.js";
import { startIdp, SECRET } from "./helpers/idp.js";

let up, idp, hub, pub, mcpUrl;
const REDIRECT = "http://localhost:9999/callback";
const manual = { redirect: "manual" };

async function oauthEnv(extra = {}) {
  const port = await freePort();
  return {
    APP_ENV: "preprod", SAGE_URL: "", MYREPORT_MCP_URL: "", // Sage X3 et MyReport en simulateur : pas de connexion par application
    OAUTH: "on", OAUTH_LOOPBACK: "on", OAUTH_PORT: String(port), OAUTH_PUBLIC_URL: `http://127.0.0.1:${port}`, OAUTH_REVALIDATE_MIN: "60",
    OIDC_PROVIDERS: "charlois,oakwood,acquise",
    OIDC_CHARLOIS_ISSUER: idp.entra("charlois-tid"), OIDC_CHARLOIS_KIND: "entra", OIDC_CHARLOIS_CLIENT_ID: "hub-charlois", OIDC_CHARLOIS_CLIENT_SECRET: SECRET, OIDC_CHARLOIS_LABEL: "Microsoft (Charlois)", OIDC_CHARLOIS_DOMAINS: "charlois.com",
    OIDC_OAKWOOD_ISSUER: idp.entra("oakwood-tid"), OIDC_OAKWOOD_KIND: "entra", OIDC_OAKWOOD_CLIENT_ID: "hub-oakwood", OIDC_OAKWOOD_CLIENT_SECRET: SECRET, OIDC_OAKWOOD_LABEL: "Microsoft (Oakwood Cooperage)", OIDC_OAKWOOD_DOMAINS: "oakwoodcooperage.com",
    OIDC_ACQUISE_ISSUER: idp.google, OIDC_ACQUISE_KIND: "google", OIDC_ACQUISE_CLIENT_ID: "hub-google", OIDC_ACQUISE_CLIENT_SECRET: SECRET, OIDC_ACQUISE_LABEL: "Google (société acquise)", OIDC_ACQUISE_DOMAINS: "acquise.example",
    ...extra,
  };
}
async function waitPublic(url) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/health`)).ok) return; } catch { /* pas prêt */ } await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("port public muet");
}

/** L'assistant (client OAuth du SDK) : inscription, PKCE, jetons en mémoire. */
class Assistant {
  constructor(name = "Claude (test)") { this.name = name; }
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() { return { client_name: this.name, redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "client_secret_post" }; }
  clientInformation() { return this.info; }
  saveClientInformation(i) { this.info = i; }
  tokens() { return this.tok; }
  saveTokens(t) { this.tok = t; }
  redirectToAuthorization(u) { this.authUrl = u; }
  saveCodeVerifier(v) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}
const cookieOf = (r) => r.headers.get("set-cookie")?.match(/clevoa_oauth=([\w-]*)/)?.[1];

/** Parcours du navigateur : page de choix → annuaire `idpId` (compte `user`) → retour au hub → code pour l'assistant. */
async function browser(authUrl, idpId, user) {
  const pageRes = await fetch(authUrl, manual);
  assert.equal(pageRes.status, 200, await pageRes.clone().text());
  const html = await pageRes.text(), cookie = `clevoa_oauth=${cookieOf(pageRes)}`;
  const link = html.match(new RegExp(`href="(/oauth/login/${idpId}\\?req=[\\w-]+)"`))?.[1];
  assert.ok(link, `lien vers l'annuaire ${idpId}`);
  const login = await fetch(pub + link, { headers: { cookie }, ...manual });
  assert.equal(login.status, 302);
  idp.state.next = user;
  const atIdp = await fetch(login.headers.get("location"), manual);
  const cb = await fetch(atIdp.headers.get("location"), { headers: { cookie }, ...manual });
  return { html, cookie, login, cb, location: cb.headers.get("location") };
}
/** Connexion complète d'un assistant : renvoie l'assistant autorisé. */
async function connect(user, idpId = "charlois", a = new Assistant()) {
  assert.equal(await auth(a, { serverUrl: mcpUrl }), "REDIRECT");
  const b = await browser(a.authUrl, idpId, user);
  assert.equal(b.cb.status, 302, await b.cb.text());
  const back = new URL(b.location);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(await auth(a, { serverUrl: mcpUrl, authorizationCode: back.searchParams.get("code") }), "AUTHORIZED");
  return a;
}
async function tools(a) {
  const c = new Client({ name: "assistant", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: a }));
  try {
    const names = (await c.listTools()).tools.map((t) => t.name);
    const r = await c.callTool({ name: "sagex3_representations", arguments: {} });
    return { names, result: r };
  } finally { await c.close(); }
}
const token = (body) => fetch(`${pub}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
const mcpPing = (bearer) => fetch(mcpUrl, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });

before(async () => {
  up = await startUpstream();
  idp = await startIdp();
  hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, env: await oauthEnv() });
  pub = hub.env.OAUTH_PUBLIC_URL; mcpUrl = `${pub}/mcp`;
  await waitPublic(pub);
});
after(async () => { await hub?.stop(); await idp?.stop(); await up?.stop(); });

test("Découverte : 401 avec resource_metadata sur /mcp, métadonnées RFC 9728 et RFC 8414 (S256, DCR, offline_access + scope métier)", async () => {
  const r = await mcpPing("rien");
  assert.equal(r.status, 401);
  const www = r.headers.get("www-authenticate");
  assert.match(www, new RegExp(`resource_metadata="${pub}/.well-known/oauth-protected-resource/mcp"`));
  assert.match(www, /scope="mcp.read"/);
  const prm = await (await fetch(`${pub}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, mcpUrl);
  assert.deepEqual(prm.authorization_servers, [`${pub}/`]);
  const as = await (await fetch(`${pub}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.scopes_supported, ["mcp.read", "offline_access"]);
  assert.equal(as.registration_endpoint, `${pub}/register`);
  assert.equal(as.revocation_endpoint, `${pub}/revoke`);
});

test("Port public cloisonné : ni portail ni API ni clé statique, chemins exacts seulement ; le port interne garde la clé statique", async () => {
  for (const path of ["/", "/index.html", "/api/me", "/api/status", "/auth/salesforce", "/metrics", "/sse"]) assert.equal((await fetch(pub + path, manual)).status, 404, path);
  // Variantes de casse ou de barre finale : refusées, sinon elles passeraient à côté de la règle du pare-feu Cloudflare
  for (const path of ["/REGISTER", "/Register/", "/register/", "/MCP", "/mcp/", "/Token", "/REVOKE", "//mcp", "/%6dcp"]) {
    const r = await fetch(pub + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) });
    assert.equal(r.status, 404, path);
  }
  assert.equal((await mcpPing(KEY)).status, 401, "la clé statique d'un collaborateur n'ouvre rien côté public");
  const internal = await fetch(`${hub.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(internal.status, 200);
});

test("Inscription : adresse de retour hors liste refusée ; Claude (claude.ai) et la boucle locale acceptés", async () => {
  const reg = (uris) => fetch(`${pub}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: uris, client_name: "x" }) });
  for (const bad of [["https://evil.example/cb"], ["https://claude.ai.evil.example/api/mcp/auth_callback"], [REDIRECT, "https://evil.example/cb"], []]) {
    const r = await reg(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal((await r.json()).error, "invalid_client_metadata");
  }
  for (const ok of [["https://claude.ai/api/mcp/auth_callback"], ["http://127.0.0.1:33418/oauth/callback"]]) assert.equal((await reg(ok)).status, 201, JSON.stringify(ok));
});

let marie;
test("Parcours complet (Entra Charlois) : page de choix et consentement, PKCE vers l'annuaire, code lié à l'assistant, outils appelables", async () => {
  marie = new Assistant();
  assert.equal(await auth(marie, { serverUrl: mcpUrl }), "REDIRECT");
  assert.equal(marie.authUrl.searchParams.get("resource"), mcpUrl, "l'assistant annonce la ressource (RFC 8707)");
  const b = await browser(marie.authUrl, "charlois", "marie");
  assert.match(b.html, /Claude \(test\)/); assert.match(b.html, /localhost:9999/);
  for (const label of ["Microsoft (Charlois)", "Microsoft (Oakwood Cooperage)", "Google (société acquise)"]) assert.ok(b.html.includes(label), label);
  const q = idp.state.lastAuthorize;
  assert.equal(q.get("code_challenge_method"), "S256"); assert.ok(q.get("nonce")); assert.equal(q.get("client_id"), "hub-charlois");
  assert.match(q.get("scope"), /offline_access/);
  assert.equal(q.get("redirect_uri"), `${pub}/oauth/callback/charlois`);
  const back = new URL(b.location);
  assert.equal(back.searchParams.get("iss"), `${pub}/`, "RFC 9207");
  assert.equal(await auth(marie, { serverUrl: mcpUrl, authorizationCode: back.searchParams.get("code") }), "AUTHORIZED");
  assert.match(marie.tok.access_token, /^cgo_at_/); assert.match(marie.tok.refresh_token, /^cgo_rt_/);
  assert.equal(marie.tok.expires_in, 900);
  const { names, result } = await tools(marie);
  assert.ok(names.includes("sagex3_query") && names.includes("salesforce_call"));
  assert.ok(!result.isError, JSON.stringify(result));
  assert.match(result.content.at(-1).text, /^Source : Sage X3/);
  const u = hub.readUsers(), mine = Object.values(u).filter((x) => x.sso?.sub === "oid-marie");
  assert.equal(mine.length, 1); assert.equal(mine[0].sso.tid, "charlois-tid"); assert.equal(mine[0].email, "marie.dupont@charlois.com");
  assert.doesNotMatch(hub.logs(), /marie|oid-marie|cgo_/i, "ni identité ni jeton dans les journaux");
});

test("Liaison d'identité : la même collaboratrice depuis un second assistant retrouve sa clé ; Oakwood et Google ont la leur", async () => {
  await connect("marie", "charlois", new Assistant("ChatGPT (test)"));
  await connect("jack", "oakwood");
  const lea = await connect("lea", "acquise");
  assert.ok(!(await tools(lea)).result.isError);
  const users = Object.values(hub.readUsers()).filter((x) => x.sso);
  assert.equal(users.filter((x) => x.sso.sub === "oid-marie").length, 1, "une seule clé pour Marie");
  assert.equal(users.find((x) => x.sso.sub === "oid-jack").sso.tid, "oakwood-tid");
  assert.equal(users.find((x) => x.sso.sub === "g-lea").sso.tid, idp.google);
});

test("Politique : compte Google personnel, autre domaine, mauvais annuaire Entra, id_token falsifié ou refus → aucun code", async () => {
  const attempt = async (user, idpId) => { const a = new Assistant(); await auth(a, { serverUrl: mcpUrl }); return browser(a.authUrl, idpId, user); };
  let b = await attempt("perso", "acquise");
  assert.equal(b.cb.status, 403); assert.match(await b.cb.text(), /compte Google personnel/);
  b = await attempt("intrus", "acquise");
  assert.equal(b.cb.status, 403); assert.match(await b.cb.text(), /autre\.example non autorisé/);
  b = await attempt("marie", "oakwood"); // Oakwood n'accepte que ses domaines
  assert.equal(b.cb.status, 403);
  idp.state.flaw = "guest"; // invité B2B dans l'annuaire de Charlois
  b = await attempt("paul", "charlois");
  assert.equal(b.cb.status, 403); assert.match(await b.cb.text(), /compte invité/);
  for (const flaw of ["tid", "aud", "iss", "nonce", "exp"]) {
    idp.state.flaw = flaw;
    b = await attempt("paul", "charlois");
    assert.equal(b.cb.status, 502, flaw);
  }
  idp.state.flaw = "";
  b = await attempt("deny", "charlois");
  assert.equal(b.cb.status, 302);
  const back = new URL(b.location);
  assert.equal(back.searchParams.get("error"), "access_denied"); assert.equal(back.searchParams.get("code"), null);
  assert.ok(!Object.values(hub.readUsers()).some((x) => ["g-perso", "g-intrus", "oid-paul"].includes(x.sso?.sub)), "aucune identité refusée n'est enregistrée");
});

test("Navigateur : demande ouverte par un autre navigateur (cookie absent ou différent) refusée, à l'aller comme au retour", async () => {
  const a = new Assistant(); await auth(a, { serverUrl: mcpUrl });
  const pageRes = await fetch(a.authUrl, manual), html = await pageRes.text(), link = html.match(/href="(\/oauth\/login\/charlois\?req=[\w-]+)"/)[1];
  assert.equal((await fetch(pub + link, manual)).status, 400, "sans cookie");
  assert.equal((await fetch(pub + link, { headers: { cookie: "clevoa_oauth=autre" }, ...manual })).status, 400, "cookie d'un autre");
  const cookie = `clevoa_oauth=${cookieOf(pageRes)}`;
  const login = await fetch(pub + link, { headers: { cookie }, ...manual });
  idp.state.next = "paul";
  const atIdp = await fetch(login.headers.get("location"), manual);
  assert.equal((await fetch(atIdp.headers.get("location"), { headers: { cookie: "clevoa_oauth=autre" }, ...manual })).status, 400, "retour dans un autre navigateur");
});

test("Ressource : une audience étrangère est refusée à l'autorisation et au jeton", async () => {
  const a = new Assistant(); await auth(a, { serverUrl: mcpUrl });
  const u = new URL(a.authUrl); u.searchParams.set("resource", "https://autre-serveur.example/mcp");
  const r = await fetch(u, manual);
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get("location")).searchParams.get("error"), "invalid_target");
  const t = await token({ grant_type: "refresh_token", refresh_token: marie.tok.refresh_token, client_id: marie.info.client_id, client_secret: marie.info.client_secret, resource: "https://autre-serveur.example/mcp" });
  assert.equal(t.status, 400); assert.equal((await t.json()).error, "invalid_target");
});

test("Code d'autorisation : à usage unique, lié à l'assistant ; un rejeu révoque la session qu'il a ouverte", async () => {
  const a = new Assistant(); await auth(a, { serverUrl: mcpUrl });
  const b = await browser(a.authUrl, "charlois", "marie"), code = new URL(b.location).searchParams.get("code");
  const other = new Assistant(); await auth(other, { serverUrl: mcpUrl });
  const stolen = await token({ grant_type: "authorization_code", code, code_verifier: a.verifier, client_id: other.info.client_id, client_secret: other.info.client_secret, redirect_uri: REDIRECT });
  assert.equal(stolen.status, 400, "code d'un autre assistant");
  const bad = await token({ grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id: a.info.client_id, client_secret: a.info.client_secret, redirect_uri: REDIRECT });
  assert.equal(bad.status, 400, "PKCE");
  const ok = await token({ grant_type: "authorization_code", code, code_verifier: a.verifier, client_id: a.info.client_id, client_secret: a.info.client_secret, redirect_uri: REDIRECT });
  assert.equal(ok.status, 200);
  const first = await ok.json();
  assert.equal((await mcpPing(first.access_token)).status, 200);
  const foreign = await token({ grant_type: "authorization_code", code, code_verifier: a.verifier, client_id: other.info.client_id, client_secret: other.info.client_secret, redirect_uri: REDIRECT });
  assert.equal(foreign.status, 400);
  assert.equal((await mcpPing(first.access_token)).status, 200, "le rejeu par un autre client ne coupe pas la session d'autrui");
  const replay = await token({ grant_type: "authorization_code", code, code_verifier: a.verifier, client_id: a.info.client_id, client_secret: a.info.client_secret, redirect_uri: REDIRECT });
  assert.equal(replay.status, 400);
  assert.equal((await mcpPing(first.access_token)).status, 401, "session révoquée après rejeu");
});

test("Refresh : rotation ; l'ancien refresh token rejoué révoque toute la session", async () => {
  const a = await connect("paul");
  const old = a.tok, c = a.info;
  const r1 = await token({ grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: c.client_id, client_secret: c.client_secret });
  assert.equal(r1.status, 200);
  const fresh = await r1.json();
  assert.notEqual(fresh.refresh_token, old.refresh_token); assert.notEqual(fresh.access_token, old.access_token);
  assert.equal((await mcpPing(fresh.access_token)).status, 200);
  const replay = await token({ grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: c.client_id, client_secret: c.client_secret });
  assert.equal(replay.status, 400);
  assert.equal((await mcpPing(fresh.access_token)).status, 401, "jeton d'accès de la session révoquée");
  const after = await token({ grant_type: "refresh_token", refresh_token: fresh.refresh_token, client_id: c.client_id, client_secret: c.client_secret });
  assert.equal(after.status, 400);
});

test("Révocation (RFC 7009) : par l'assistant qui détient le jeton seulement", async () => {
  const a = await connect("paul"), other = await connect("lea", "acquise");
  const revoke = (cl, t) => fetch(`${pub}/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t, client_id: cl.client_id, client_secret: cl.client_secret }) });
  assert.equal((await revoke(other.info, a.tok.refresh_token)).status, 200);
  assert.equal((await mcpPing(a.tok.access_token)).status, 200, "un autre assistant ne révoque rien");
  assert.equal((await revoke(a.info, a.tok.refresh_token)).status, 200);
  assert.equal((await mcpPing(a.tok.access_token)).status, 401);
});

test("Revalidation auprès de l'annuaire : compte désactivé → refresh refusé et session close ; panne courte tolérée", async () => {
  const h2 = await startHub({ upstreamUrl: up.url, env: await oauthEnv({ OAUTH_REVALIDATE_MIN: "0" }) });
  const savePub = pub, saveMcp = mcpUrl;
  pub = h2.env.OAUTH_PUBLIC_URL; mcpUrl = `${pub}/mcp`;
  try {
    await waitPublic(pub);
    const a = await connect("marie"), c = a.info;
    await new Promise((r) => setTimeout(r, 5));
    idp.state.down = true; // panne de l'annuaire : revalidation reportée, l'assistant continue
    const r1 = await token({ grant_type: "refresh_token", refresh_token: a.tok.refresh_token, client_id: c.client_id, client_secret: c.client_secret });
    assert.equal(r1.status, 200);
    assert.match(h2.logs(), /revalidation reportée/);
    idp.state.down = false;
    const t1 = await r1.json(), before = idp.state.refreshes;
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: c.client_id, client_secret: c.client_secret });
    assert.equal(r2.status, 200); assert.equal(idp.state.refreshes, before + 1, "l'annuaire a été réinterrogé");
    const t2 = await r2.json();
    idp.state.disabled.add("marie"); // compte désactivé dans Entra
    await new Promise((r) => setTimeout(r, 5));
    const r3 = await token({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: c.client_id, client_secret: c.client_secret });
    assert.equal(r3.status, 400); assert.equal((await r3.json()).error, "invalid_grant");
    assert.equal((await mcpPing(t2.access_token)).status, 401, "session close, jeton d'accès compris");
  } finally { idp.state.disabled.clear(); idp.state.down = false; pub = savePub; mcpUrl = saveMcp; await h2.stop(); }
});

test("Persistance : après redémarrage, l'inscription et la session survivent (refresh), le jeton d'accès en mémoire non ; fichier chiffré, empreintes seulement", async () => {
  const a = await connect("lea", "acquise");
  const raw = hub.rawStore();
  assert.ok(raw.startsWith("enc1:"));
  const h2 = await startHub({ upstreamUrl: up.url, store: raw, env: await oauthEnv() });
  try {
    const p2 = h2.env.OAUTH_PUBLIC_URL; await waitPublic(p2);
    const ping = (t) => fetch(`${p2}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${t}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    assert.equal((await ping(a.tok.access_token)).status, 401, "jeton d'accès perdu au redémarrage");
    const r = await fetch(`${p2}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.tok.refresh_token, client_id: a.info.client_id, client_secret: a.info.client_secret }) });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await ping((await r.json()).access_token)).status, 200);
  } finally { await h2.stop(); }
  const { readStore } = await import("./helpers/hub.js");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs"), { join } = await import("node:path"), { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "oauth-store-")); writeFileSync(join(dir, "u.json"), raw);
  const db = readStore(join(dir, "u.json")); rmSync(dir, { recursive: true });
  const sessions = Object.values(db.oauth.sessions);
  assert.ok(sessions.length > 0);
  assert.ok(!JSON.stringify(db.oauth).includes(a.tok.refresh_token.split(".")[1]), "jamais le refresh token du hub en clair, seulement son empreinte");
  assert.ok(!JSON.stringify(db.oauth).includes("cgo_at_"), "aucun jeton d'accès sur disque");
});

test("Verrous de démarrage : URL publique, port, annuaires, domaines, production", async () => {
  const fails = async (extra, re) => {
    await assert.rejects(startHub({ upstreamUrl: up.url, env: { ...(await oauthEnv()), ...extra } }), re);
  };
  await fails({ OAUTH_PUBLIC_URL: "" }, /OAUTH_PUBLIC_URL/);
  await fails({ OAUTH_PUBLIC_URL: "http://mcp.example.com" }, /https/);
  await fails({ OAUTH_PUBLIC_URL: "https://mcp.example.com/chemin" }, /sans chemin/);
  await fails({ OIDC_PROVIDERS: "" }, /au moins un annuaire/);
  await fails({ OIDC_ACQUISE_DOMAINS: "" }, /DOMAINS requis/);
  await fails({ OIDC_CHARLOIS_DOMAINS: "" }, /DOMAINS requis.*invités compris/);
  await fails({ OIDC_CHARLOIS_ISSUER: "http://annuaire.example.com/abc/v2.0" }, /http réservé aux annuaires simulés/);
  await fails({ OIDC_CHARLOIS_ISSUER: "https://faux-microsoft.example.com/0e5f8c1a-0000-4000-8000-000000000000/v2.0" }, /login\.microsoftonline\.com/);
  await fails({ OIDC_ACQUISE_ISSUER: "https://accounts.google.example.com" }, /accounts\.google\.com/);
  await fails({ OIDC_CHARLOIS_CLIENT_SECRET: "" }, /CLIENT_SECRET/);
  await fails({ OIDC_CHARLOIS_ISSUER: `${idp.url}/entra/common/oauth2` }, /émetteur Entra attendu/);
  await fails({ APP_ENV: "production", SAGE_URL: up.url, MYREPORT_MCP_URL: `${up.url}/myreport/sse` }, /https exigé en production/);
  // Boucle locale refusée par défaut (OAUTH_LOOPBACK absent)
  const strict = await startHub({ upstreamUrl: up.url, env: { ...(await oauthEnv()), OAUTH_LOOPBACK: "" } });
  try {
    await waitPublic(strict.env.OAUTH_PUBLIC_URL);
    const reg = await fetch(`${strict.env.OAUTH_PUBLIC_URL}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
    assert.equal(reg.status, 400);
  } finally { await strict.stop(); }
  // Sans OAUTH=on : aucun port public, aucune variable OIDC exigée (comportement 1.4 inchangé)
  const plain = await startHub({ upstreamUrl: up.url, env: { OAUTH_PORT: hub.env.OAUTH_PORT } });
  try { assert.doesNotMatch(plain.logs(), /Serveur OAuth/); } finally { await plain.stop(); }
});

// En dernier : épuise le débit de /oauth pour 127.0.0.1 pendant une minute.
test("Pages du navigateur : une connexion en cours par demande, débit borné par adresse", async () => {
  const a = new Assistant(); await auth(a, { serverUrl: mcpUrl });
  const pageRes = await fetch(a.authUrl, manual), html = await pageRes.text(), link = html.match(/href="(\/oauth\/login\/charlois\?req=[\w-]+)"/)[1];
  const cookie = `clevoa_oauth=${cookieOf(pageRes)}`;
  const first = await fetch(pub + link, { headers: { cookie }, ...manual }), second = await fetch(pub + link, { headers: { cookie }, ...manual });
  idp.state.next = "paul";
  const atIdp = await fetch(first.headers.get("location"), manual);
  assert.equal((await fetch(atIdp.headers.get("location"), { headers: { cookie }, ...manual })).status, 400, "la connexion remplacée n'aboutit plus");
  assert.equal(second.status, 302);
  let last; for (let i = 0; i < 70; i++) last = await fetch(pub + link, { headers: { cookie }, ...manual });
  assert.equal(last.status, 429, "plafond de 60 par minute et par adresse");
});
