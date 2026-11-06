// Accès en ligne, inscription automatique (CIMD, 1.8, expérimental) : l'assistant se présente par l'adresse de son document, sans
// secret ; le hub vérifie le document (liste blanche, SSRF, cache), reçoit le code d'Entra sur /oauth/callback et réémet le sien.
// Documents et Entra simulés par le bouchon ; aucun réseau réel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { startUpstream } from "./helpers/upstream.js";
import { startHub, freePort } from "./helpers/hub.js";
import * as cimd from "../cimd.js";

const CLIENT = "online-client-id", SECRET = "online-client-secret-0123456789";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback", CHATGPT = "https://chatgpt.com/connector_platform_oauth_redirect";
const noFollow = { redirect: "manual" };
let up, hub, base, ids;

before(async () => {
  up = await startUpstream();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  ids = Object.fromEntries(["claude", "chatgpt", "big", "redirect", "autre", "secret", "down"].map((n) => [n, `${up.url}/cimd/${n}`]));
  hub = await startHub({ upstreamUrl: up.url, env: { APP_ENV: "preprod", SSO_MODE: "mock", ONLINE: "on", ONLINE_PORT: String(port), ONLINE_URL: base,
    ONLINE_CLIENT_ID: CLIENT, ONLINE_CLIENT_SECRET: SECRET, ONLINE_REDIRECT_URIS: `${CLAUDE},${CHATGPT}`,
    ONLINE_CIMD_CLIENTS: Object.values(ids).join(","), ONLINE_CIMD_ALLOW_LOOPBACK: "1" } });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* port public pas encore ouvert */ } await new Promise((r) => setTimeout(r, 50)); }
});
after(async () => { await hub?.stop(); await up?.stop?.(); });

const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
const authorize = (o) => fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", redirect_uri: CLAUDE, code_challenge: "x".repeat(43),
  code_challenge_method: "S256", state: "etat-assistant", scope: "mcp", resource: `${base}/mcp`, ...o })}`, noFollow);
const token = (body, headers = {}) => fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
const logged = async (re) => { for (const end = Date.now() + 2000; !re.test(hub.logs()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 50)); return hub.logs(); };

/** Parcours complet jusqu'au retour vers l'assistant : /authorize → Entra (Marie se connecte) → /oauth/callback → assistant. */
async function connect({ client_id, redirect_uri = CLAUDE, who = "marie" }) {
  const { verifier, challenge } = pkce();
  const a = await authorize({ client_id, redirect_uri, code_challenge: challenge });
  assert.equal(a.status, 302, await a.clone().text());
  const entra = new URL(a.headers.get("location"));
  const cookie = a.headers.get("set-cookie").split(";")[0];
  entra.searchParams.set("mock_user", who);
  const cb = new URL((await fetch(entra, noFollow)).headers.get("location"));
  const back = await fetch(cb, { headers: { cookie }, ...noFollow });
  assert.equal(back.status, 302, await back.clone().text());
  return { entra, cb, cookie, back: new URL(back.headers.get("location")), verifier, challenge };
}

test("Métadonnées : CIMD annoncé, iss dans la réponse d'autorisation (RFC 9207), méthode « none » proposée, toujours sans DCR", async () => {
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.ok(as.token_endpoint_auth_methods_supported.includes("none"), "Claude n'utilise CIMD que si « none » est proposé");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.registration_endpoint, undefined);
  assert.equal(as.issuer, `${base}/`);
});

test("Client CIMD de la liste blanche : Entra renvoie au hub, le hub réémet son code, /token sans secret client (PKCE) rend les jetons d'Entra", async () => {
  up.reset();
  const { entra, cb, back, verifier, challenge } = await connect({ client_id: ids.claude });
  assert.equal(entra.searchParams.get("client_id"), CLIENT, "Entra ne voit que l'inscription du hub");
  assert.equal(entra.searchParams.get("redirect_uri"), `${base}/oauth/callback`, "seule adresse de retour à enregistrer dans Entra");
  assert.equal(entra.searchParams.get("code_challenge"), challenge, "défi PKCE de l'assistant transmis à Entra");
  assert.notEqual(entra.searchParams.get("state"), "etat-assistant");
  assert.equal(entra.searchParams.get("scope"), `api://${CLIENT}/mcp offline_access`);
  assert.equal(back.origin + back.pathname, CLAUDE);
  assert.equal(back.searchParams.get("state"), "etat-assistant");
  assert.equal(back.searchParams.get("iss"), `${base}/`);
  const code = back.searchParams.get("code");
  assert.ok(code && code !== cb.searchParams.get("code"), "le code d'Entra ne sort jamais du hub");
  const t = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE, client_id: ids.claude, resource: `${base}/mcp` });
  assert.equal(t.status, 200, await t.clone().text());
  assert.equal((await t.json()).access_token, "ms-token-marie");
  const sent = new URLSearchParams(up.requests("/ms/common/oauth2/v2.0/token", "POST")[0].body);
  assert.equal(sent.get("client_id"), CLIENT);
  assert.equal(sent.get("client_secret"), SECRET, "le hub ajoute lui-même son secret");
  assert.equal(sent.get("redirect_uri"), `${base}/oauth/callback`);
  assert.equal(sent.get("code_verifier"), verifier, "PKCE vérifié aussi par Entra");
  assert.equal(up.requests("/cimd/claude").length, 1, "document lu une fois (autorisation et échange : cache)");
  const again = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE, client_id: ids.claude });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error, "invalid_grant", "code à usage unique");
  assert.ok(!hub.logs().includes(code), "aucun code au journal");
});

test("/token d'un client CIMD : mauvais code_verifier, autre client ou autre adresse de retour refusés sans appel à Entra", async () => {
  for (const [why, over] of [["code_verifier", { code_verifier: pkce().verifier }], ["autre client", { client_id: ids.chatgpt }], ["redirect_uri", { redirect_uri: CHATGPT }]]) {
    const { back, verifier } = await connect({ client_id: ids.claude });
    up.reset();
    const r = await token({ grant_type: "authorization_code", code: back.searchParams.get("code"), code_verifier: verifier, redirect_uri: CLAUDE, client_id: ids.claude, ...over });
    assert.equal(r.status, 400, why);
    assert.equal((await r.json()).error, "invalid_grant", why);
    assert.equal(up.requests("/ms/common/oauth2/v2.0/token").length, 0, why);
  }
});

test("Renouvellement par un client CIMD, sans secret : le hub présente son inscription à Entra", async () => {
  up.reset();
  up.state.msRefresh = "plain";
  const r = await token({ grant_type: "refresh_token", refresh_token: "ms-refresh-marie", client_id: ids.claude });
  assert.equal(r.status, 200, await r.clone().text());
  const sent = new URLSearchParams(up.requests("/ms/common/oauth2/v2.0/token", "POST")[0].body);
  assert.equal(sent.get("client_id"), CLIENT);
  assert.equal(sent.get("client_secret"), SECRET);
});

test("Document en cache selon Cache-Control : max-age=300 lu une fois, no-store relu à chaque demande", async () => {
  await authorize({ client_id: ids.claude });
  up.reset();
  await authorize({ client_id: ids.claude }); await authorize({ client_id: ids.claude });
  assert.equal(up.requests("/cimd/claude").length, 0);
  for (let i = 0; i < 2; i++) assert.equal((await authorize({ client_id: ids.chatgpt, redirect_uri: CHATGPT })).status, 302);
  assert.equal(up.requests("/cimd/chatgpt").length, 2, "ChatGPT (méthode préférée private_key_jwt) admis en client public");
});

test("Refus : client hors liste (sans aucune requête sortante), adresse de retour hors document ou inconnue du hub, document invalide", async () => {
  up.reset();
  for (const id of [`${up.url}/cimd/inconnu`, "https://claude.ai/oauth/claude-code-client-metadata", `${ids.claude}?x=1`]) {
    const r = await authorize({ client_id: id });
    assert.equal(r.status, 400, id);
    assert.equal((await r.json()).error, "invalid_client", id);
  }
  assert.equal(up.requests("/cimd/inconnu").length, 0, "adresse hors liste jamais récupérée (SSRF)");
  for (const [id, redirect] of [[ids.claude, "https://evil.example/callback"], [ids.claude, CHATGPT], [ids.chatgpt, CLAUDE]]) {
    const r = await authorize({ client_id: id, redirect_uri: redirect });
    assert.equal(r.status, 400, `${id} → ${redirect}`);
    assert.equal(r.headers.get("location"), null, "jamais de redirection vers une adresse non vérifiée");
  }
  for (const [n, why] of [["big", /trop gros/], ["redirect", /302 \(redirection non suivie\)/], ["autre", /client_id du document différent/], ["secret", /secret partagé interdit/]]) {
    const r = await authorize({ client_id: ids[n] });
    assert.equal(r.status, 400, n);
    assert.equal((await r.json()).error, "invalid_client", n);
    assert.match(await logged(why), why);
  }
  assert.equal(up.requests("/cimd/claude").length, 0, "redirection du document non suivie");
  const down = await authorize({ client_id: ids.down });
  assert.equal(down.status, 500, "indisponibilité passagère : erreur serveur, l'assistant réessaiera");
  await authorize({ client_id: ids.down });
  assert.equal(up.requests("/cimd/down").length, 2, "erreur jamais mise en cache");
});

test("Client préenregistré toujours accepté avec CIMD actif : même retour par le hub, secret exigé à l'échange", async () => {
  const { back, verifier } = await connect({ client_id: CLIENT });
  const code = back.searchParams.get("code");
  const without = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE, client_id: CLIENT });
  assert.equal(without.status, 400);
  assert.equal((await without.json()).error, "invalid_client");
  const ok = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE },
    { Authorization: `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}` });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await ok.json()).access_token, "ms-token-marie");
});

test("/oauth/callback : connexion inconnue, autre navigateur (sans le témoin) et refus d'Entra", async () => {
  assert.equal((await fetch(`${base}/oauth/callback?code=issued-1&state=inconnu`, noFollow)).status, 400);
  const a = await authorize({ client_id: ids.claude, code_challenge: pkce().challenge });
  const entra = new URL(a.headers.get("location"));
  const cookie = a.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i); assert.match(cookie, /Path=\/oauth\/callback/);
  const stolen = await fetch(`${base}/oauth/callback?code=issued-x&state=${entra.searchParams.get("state")}`, noFollow);
  assert.equal(stolen.status, 400, "le retour doit venir du navigateur qui a commencé la connexion");
  assert.match(await logged(/navigateur différent/), /navigateur différent/);
  // Refus d'Entra (compte non affecté) : l'erreur repart vers l'assistant, avec son state et iss, sans le détail d'Entra.
  const b = await authorize({ client_id: ids.claude });
  const tx = new URL(b.headers.get("location")).searchParams.get("state");
  const r = await fetch(`${base}/oauth/callback?error=access_denied&error_description=AADSTS50105&state=${tx}`, { headers: { cookie: b.headers.get("set-cookie").split(";")[0] }, ...noFollow });
  const back = new URL(r.headers.get("location"));
  assert.equal(back.origin + back.pathname, CLAUDE);
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("error_description"), null);
  assert.equal(back.searchParams.get("state"), "etat-assistant");
  assert.equal(back.searchParams.get("iss"), `${base}/`);
  const t = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: ids.claude, redirect_uri: CLAUDE, code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s", resource: "https://autre.example/mcp" })}`, noFollow);
  assert.equal(new URL(t.headers.get("location")).searchParams.get("iss"), `${base}/`, "iss aussi sur les erreurs renvoyées par le SDK");
});

test("Verrous de démarrage CIMD : adresse non https ou non canonique, boucle locale en production", async () => {
  const env = { ONLINE: "on", ONLINE_URL: "https://mcp.exemple.fr", ONLINE_CLIENT_ID: CLIENT, ONLINE_CLIENT_SECRET: SECRET, SSO_MODE: "mock", APP_ENV: "preprod" };
  const cases = [
    [{ ONLINE_CIMD_CLIENTS: "http://claude.example/cimd" }, /https seulement/],
    [{ ONLINE_CIMD_CLIENTS: "https://claude.example/" }, /chemin requis/],
    [{ ONLINE_CIMD_CLIENTS: "https://claude.example/a/../b" }, /non canonique/],
    [{ ONLINE_CIMD_CLIENTS: "https://claude.example/doc#x" }, /fragment/],
    [{ ONLINE_CIMD_CLIENTS: `${up.url}/cimd/claude` }, /https seulement/],
    [{ APP_ENV: "production", SSO_MODE: "entra", MS_LOGIN_URL: "", MS_TENANT_ID: "11111111-2222-3333-4444-555555555555", ONLINE_CIMD_CLIENTS: "on", ONLINE_CIMD_ALLOW_LOOPBACK: "1" }, /interdit en production/],
  ];
  for (const [over, err] of cases) await assert.rejects(startHub({ upstreamUrl: up.url, env: { ...env, ONLINE_PORT: String(await freePort()), ...over } }), err, JSON.stringify(over));
});

// ---- Module cimd.js seul : protections SSRF, taille, délai, cache ----

test("SSRF : https seulement, ni IP réservée ni nom qui y mène, ni redirection ; taille et délai bornés", async () => {
  for (const url of ["https://10.0.0.1/doc", "https://169.254.169.254/latest/meta-data", "https://[::1]/doc", "https://192.168.1.10/doc", "https://localhost/doc"]) {
    await assert.rejects(cimd.fetchDocument(url), (e) => e instanceof cimd.Refused && /réservée/.test(e.message), url);
  }
  await assert.rejects(cimd.fetchDocument(`${up.url}/cimd/claude`), (e) => e instanceof cimd.Refused && /https seulement/.test(e.message), "http refusé hors exception de développement");
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.ok(cimd.isReserved(ip), ip);
  for (const ip of ["160.79.104.10", "104.18.32.47", "2606:4700::6812:20"]) assert.ok(!cimd.isReserved(ip), ip);
  // Serveur local : document sans Content-Length au-delà de 5 Ko, redirection, absence de réponse.
  const srv = createServer((req, res) => {
    if (req.url === "/chunks") { res.writeHead(200, { "Content-Type": "application/json" }); for (let i = 0; i < 8; i++) res.write("x".repeat(1024)); return res.end(); }
    if (req.url === "/move") { res.writeHead(301, { Location: "http://169.254.169.254/" }); return res.end(); }
    if (req.url === "/hang") return; // jamais de réponse
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(cimd.fetchDocument(`${local}/chunks`, { loopback: true }), (e) => e instanceof cimd.Refused && /trop gros/.test(e.message));
    await assert.rejects(cimd.fetchDocument(`${local}/move`, { loopback: true }), (e) => e instanceof cimd.Refused && /redirection non suivie/.test(e.message));
    const t0 = Date.now();
    await assert.rejects(cimd.fetchDocument(`${local}/hang`, { loopback: true, timeoutMs: 300 }), (e) => !(e instanceof cimd.Refused) && /délai/.test(e.message));
    assert.ok(Date.now() - t0 < 2000);
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
});

test("Liste blanche, adresses canoniques, valeurs par défaut (Claude et ChatGPT, pas Claude Code) et durée de cache", () => {
  assert.deepEqual(cimd.parseClients(""), []);
  assert.deepEqual(cimd.parseClients("0"), []);
  assert.deepEqual(cimd.parseClients("on"), ["https://claude.ai/oauth/mcp-oauth-client-metadata", "https://chatgpt.com/oauth/client.json"]);
  assert.deepEqual(cimd.parseClients(" https://a.example/x , https://a.example/x,https://b.example/y"), ["https://a.example/x", "https://b.example/y"]);
  for (const id of Object.keys(cimd.KNOWN)) assert.equal(cimd.checkId(id), null, id);
  assert.match(cimd.checkId("https://user:pw@a.example/x"), /identifiants/);
  assert.match(cimd.checkId("https://A.example/x"), /non canonique/);
  assert.match(cimd.checkId("https://a.example:443/x"), /non canonique/);
  assert.match(cimd.checkId("https://a.example/x?y=1"), /paramètres/);
  assert.equal(cimd.ttlOf("public, max-age=300"), 300);
  assert.equal(cimd.ttlOf("max-age=999999"), 3600, "plafond d'une heure");
  assert.equal(cimd.ttlOf(""), 300);
  assert.equal(cimd.ttlOf("no-store"), 0);
  const c = cimd.toClient("https://claude.ai/oauth/mcp-oauth-client-metadata", { client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata", client_name: "Claude",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost/callback"], token_endpoint_auth_method: "none" });
  assert.deepEqual(c.redirect_uris, ["https://claude.ai/api/mcp/auth_callback"], "adresse connue retenue sans configuration ; boucle locale écartée");
  assert.equal(c.token_endpoint_auth_method, "none");
  assert.equal(c.client_secret, undefined);
});

test("Registre : document relu après expiration du cache, refus définitif = client inconnu, panne = exception non mise en cache", async () => {
  let t = 0, calls = 0, mode = "ok";
  const id = "https://a.example/doc", logs = [];
  const reg = cimd.createRegistry({ clients: [id], redirects: ["https://a.example/cb"], now: () => t, log: (m) => logs.push(m), fetch: async () => {
    calls++;
    if (mode === "down") throw new Error("statut 503");
    return { body: mode === "bad" ? "{" : JSON.stringify({ client_id: id, client_name: "A", redirect_uris: ["https://a.example/cb"] }), cacheControl: "max-age=60" };
  } });
  assert.equal(await reg.getClient("https://b.example/doc"), undefined);
  assert.equal(calls, 0);
  const [x, y] = await Promise.all([reg.getClient(id), reg.getClient(id)]);
  assert.deepEqual(x, y);
  assert.equal(calls, 1, "une seule récupération à la fois");
  t = 59_000; await reg.getClient(id); assert.equal(calls, 1);
  t = 61_000; mode = "down";
  await assert.rejects(reg.getClient(id));
  await assert.rejects(reg.getClient(id));
  assert.equal(calls, 3, "panne non mise en cache");
  mode = "bad";
  assert.equal(await reg.getClient(id), undefined);
  assert.match(logs.join("\n"), /JSON illisible/);
  const once = cimd.onceMap({ ttlMs: 1000, max: 2, now: () => t });
  once.put("a", 1); once.put("b", 2); once.put("c", 3);
  assert.equal(once.size, 2, "plafond mémoire");
  assert.equal(once.take("c"), 3); assert.equal(once.take("c"), undefined, "usage unique");
  t += 2000; assert.equal(once.take("b"), undefined, "expiré");
});
