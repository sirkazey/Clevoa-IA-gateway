// SharePoint par openid-client (annuaire Entra précis, ID en majuscules comme le saisissent les administrateurs) : échange du code et
// refresh. Un id_token invalide est refusé ; une panne d'Entra (5xx JSON ou HTML, délai dépassé) ne détruit jamais la connexion du
// collaborateur ; seul un refus explicite (invalid_grant) l'efface. Jamais d'id_token conservé.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startUpstream } from "./helpers/upstream.js";
import { startHub, KEY } from "./helpers/hub.js";

const TENANT = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";
let up, hub;
const noFollow = { redirect: "manual" };
const diag = () => fetch(`${hub.url}/api/test/sharepoint`, { headers: { cookie: `mcp_key=${KEY}` } }).then((r) => r.json());
const sp = () => hub.readUsers()[KEY]?.sharepoint; // sans aucun jeton, le collaborateur n'est plus écrit sur disque
/** Jeton d'accès SharePoint expiré : le prochain appel déclenche un refresh, dont la réponse d'Entra est `mode`. */
function expireWith(mode) {
  up.state.msRefresh = mode;
  up.expire(sp().access_token);
}

before(async () => {
  up = await startUpstream();
  const users = { [KEY]: { createdAt: "2026-01-01T00:00:00.000Z", email: "alice@example.com", sharepoint: { access_token: "ms-token-initial", refresh_token: "ms-refresh-initial" } } };
  // Pré-production forcée : la mire Entra simulée est en http, ce que la production refuse (openid-client sans allowInsecureRequests).
  hub = await startHub({ upstreamUrl: up.url, users, env: { APP_ENV: "preprod", MS_TENANT_ID: TENANT } });
});
after(async () => { await hub?.stop(); await up?.stop(); });

test("Échange du code par openid-client : id_token signé accepté, l'annuaire est trouvé malgré l'ID en majuscules, id_token non conservé", async () => {
  const start = await fetch(`${hub.url}/auth/sharepoint`, { headers: { cookie: `mcp_key=${KEY}` }, ...noFollow });
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cb = await fetch(`${hub.url}/auth/sharepoint/callback?code=alice&state=${state}`, { headers: { cookie: `mcp_key=${KEY}` }, ...noFollow });
  assert.equal(cb.status, 302, await cb.text());
  assert.equal(sp().access_token, "ms-token-alice"); assert.equal(sp().id_token, undefined);
  assert.ok(up.requests(`/ms/${TENANT.toLowerCase()}/v2.0/.well-known/openid-configuration`).length >= 1, "découverte sur l'annuaire en minuscules");
});

test("Échange du code : id_token à la signature falsifiée → 400, rien d'enregistré ; panne d'Entra au jeton → 502", async () => {
  const before = sp().access_token;
  const start = await fetch(`${hub.url}/auth/sharepoint`, { headers: { cookie: `mcp_key=${KEY}` }, ...noFollow });
  const forged = await fetch(`${hub.url}/auth/sharepoint/callback?code=alice:sig&state=${new URL(start.headers.get("location")).searchParams.get("state")}`, { headers: { cookie: `mcp_key=${KEY}` }, ...noFollow });
  assert.equal(forged.status, 400); assert.equal(sp().access_token, before);
  up.failNext("/oauth2/v2.0/token", 503, { error: "temporarily_unavailable" });
  const start2 = await fetch(`${hub.url}/auth/sharepoint`, { headers: { cookie: `mcp_key=${KEY}` }, ...noFollow });
  const down = await fetch(`${hub.url}/auth/sharepoint/callback?code=alice&state=${new URL(start2.headers.get("location")).searchParams.get("state")}`, { headers: { cookie: `mcp_key=${KEY}` }, ...noFollow });
  assert.equal(down.status, 502, await down.text());
});

test("Refresh avec id_token signé : appel réussi, refresh token tourné conservé, id_token jamais conservé", async () => {
  expireWith("idtoken");
  const r = await diag();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(sp().access_token, "ms-token-refreshed"); assert.equal(sp().refresh_token, "ms-refresh-tourne"); assert.equal(sp().id_token, undefined);
});

for (const mode of ["forged", "503json", "503html"]) {
  test(`Refresh « ${mode} » : l'appel échoue, la connexion SharePoint est conservée`, async () => {
    expireWith(mode);
    const kept = sp().refresh_token, r = await diag();
    assert.equal(r.ok, false); assert.equal(sp().refresh_token, kept, "jetons conservés");
    up.state.msRefresh = "plain"; up.reset();
  });
}

test("Refresh sans réponse d'Entra (délai de 10 s dépassé) : l'appel échoue, la connexion est conservée", { timeout: 30_000 }, async () => {
  expireWith("hang");
  const kept = sp().refresh_token, r = await diag();
  assert.equal(r.ok, false); assert.match(r.error, /délai dépassé|indisponible/); assert.equal(sp().refresh_token, kept);
  up.state.msRefresh = "plain"; up.reset();
});

test("Refresh refusé explicitement (invalid_grant) : la connexion est effacée, le portail repasse à « non connecté »", async () => {
  expireWith("invalid_grant");
  const r = await diag();
  assert.equal(r.ok, false); assert.match(r.error, /expirée ou révoquée/);
  assert.equal(sp(), undefined);
});
