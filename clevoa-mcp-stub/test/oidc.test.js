// Prototype « connexion en un clic » sur le bouchon : le vrai hub (OAUTH=on) et les trois annuaires simulés du bouchon, tels que
// docker-compose.proto.yml les assemble. Le client OAuth du SDK MCP joue Claude ; le navigateur choisit son compte sur la mire.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { startHub, freePort } from "../../hub/test/helpers/hub.js";

const STUB = new URL("../server.js", import.meta.url).pathname;
const REDIRECT = "http://localhost:9999/callback", manual = { redirect: "manual" };
let stub, stubUrl, hub, pub;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Assistant {
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() { return { client_name: "Claude (bouchon)", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" }; }
  clientInformation() { return this.info; } saveClientInformation(i) { this.info = i; }
  tokens() { return this.tok; } saveTokens(t) { this.tok = t; }
  redirectToAuthorization(u) { this.authUrl = u; }
  saveCodeVerifier(v) { this.verifier = v; } codeVerifier() { return this.verifier; }
}
/** Clic « Continuer avec <annuaire> » puis choix du compte sur la mire du bouchon ; renvoie la réponse du retour au hub. */
async function login(a, dir, email) {
  const page = await fetch(a.authUrl, manual), html = await page.text();
  const cookie = `clevoa_oauth=${page.headers.get("set-cookie").match(/clevoa_oauth=([\w-]+)/)[1]}`;
  const toIdp = await fetch(pub + html.match(new RegExp(`href="(/oauth/login/${dir}\\?req=[\\w-]+)"`))[1], { headers: { cookie }, ...manual });
  const mire = await (await fetch(toIdp.headers.get("location"))).text();
  const pick = [...mire.matchAll(/href="(\/oidc\/[^"]+\/approve\?[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")).find((l) => l.includes(encodeURIComponent(email)));
  assert.ok(pick, `${email} proposé sur la mire ${dir}`);
  const back = await fetch(stubUrl + pick, manual);
  return fetch(back.headers.get("location"), { headers: { cookie }, ...manual });
}
async function connect(dir, email) {
  const a = new Assistant();
  assert.equal(await auth(a, { serverUrl: `${pub}/mcp` }), "REDIRECT");
  const cb = await login(a, dir, email);
  assert.equal(cb.status, 302, await cb.text());
  assert.equal(await auth(a, { serverUrl: `${pub}/mcp`, authorizationCode: new URL(cb.headers.get("location")).searchParams.get("code") }), "AUTHORIZED");
  return a;
}

before(async () => {
  const port = await freePort();
  stubUrl = `http://127.0.0.1:${port}`;
  stub = spawn(process.execPath, [STUB], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(stubUrl + "/")).ok) break; } catch { /* démarrage */ } await sleep(50); }
  const op = await freePort(), dir = (d) => `${stubUrl}/oidc/${d}/v2.0`;
  hub = await startHub({ upstreamUrl: stubUrl, env: {
    APP_ENV: "preprod", SAGE_URL: "", MYREPORT_MCP_URL: "", OAUTH: "on", OAUTH_PORT: String(op), OAUTH_PUBLIC_URL: `http://127.0.0.1:${op}`, OAUTH_REVALIDATE_MIN: "0",
    OIDC_PROVIDERS: "charlois,oakwood,acquise",
    OIDC_CHARLOIS_ISSUER: dir("charlois"), OIDC_CHARLOIS_KIND: "entra", OIDC_CHARLOIS_CLIENT_ID: "hub", OIDC_CHARLOIS_CLIENT_SECRET: "s", OIDC_CHARLOIS_LABEL: "Microsoft (Charlois)",
    OIDC_OAKWOOD_ISSUER: dir("oakwood"), OIDC_OAKWOOD_KIND: "entra", OIDC_OAKWOOD_CLIENT_ID: "hub", OIDC_OAKWOOD_CLIENT_SECRET: "s", OIDC_OAKWOOD_LABEL: "Microsoft (Oakwood Cooperage)",
    OIDC_ACQUISE_ISSUER: dir("acquise"), OIDC_ACQUISE_KIND: "google", OIDC_ACQUISE_CLIENT_ID: "hub", OIDC_ACQUISE_CLIENT_SECRET: "s", OIDC_ACQUISE_LABEL: "Google (société acquise)", OIDC_ACQUISE_DOMAINS: "acquise.example",
  } });
  pub = hub.env.OAUTH_PUBLIC_URL;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${pub}/health`)).ok) break; } catch { /* démarrage */ } await sleep(50); }
});
after(async () => { await hub?.stop(); stub?.kill(); });

test("Trois annuaires du bouchon : Marie (Entra Charlois), Jack (Entra Oakwood) et Léa (Google) se connectent et appellent un outil", async () => {
  for (const [dir, email] of [["charlois", "marie.dupont@charlois.com"], ["oakwood", "jack.reed@oakwoodcooperage.com"], ["acquise", "lea.bernard@acquise.example"]]) {
    const a = await connect(dir, email), c = new Client({ name: "claude", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${pub}/mcp`), { authProvider: a }));
    try {
      const r = await c.callTool({ name: "sagex3_representations", arguments: {} });
      assert.ok(!r.isError, `${email} : ${JSON.stringify(r)}`);
    } finally { await c.close(); }
  }
  const ids = Object.values(hub.readUsers()).filter((u) => u.sso).map((u) => u.sso.tid);
  assert.deepEqual([...new Set(ids)].sort(), ["charlois", "oakwood", `${stubUrl}/oidc/acquise/v2.0`].sort());
});

test("Compte Google personnel refusé ; compte désactivé dans l'annuaire coupé au renouvellement suivant", async () => {
  const perso = new Assistant(); await auth(perso, { serverUrl: `${pub}/mcp` });
  const refused = await login(perso, "acquise", "quelquun@gmail.com");
  assert.equal(refused.status, 403);
  const a = await connect("charlois", "paul.martin@charlois.com");
  const admin = (action) => fetch(`${stubUrl}/oidc/_admin/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "paul.martin@charlois.com" }) });
  assert.equal((await admin("disable")).status, 200);
  try {
    await sleep(5);
    const r = await fetch(`${pub}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.tok.refresh_token, client_id: a.info.client_id, client_secret: a.info.client_secret }) });
    assert.equal(r.status, 400); assert.equal((await r.json()).error, "invalid_grant");
  } finally { await admin("enable"); }
});
