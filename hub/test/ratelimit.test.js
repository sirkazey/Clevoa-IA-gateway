// Limites de débit (express-rate-limit) : seuls les échecs d'authentification sont comptés (20 par minute et par IP), une clé valide
// n'est jamais freinée, et la supervision garde sa réponse texte avec WWW-Authenticate. Hub à part : ses compteurs ne gênent aucun autre test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startUpstream } from "./helpers/upstream.js";
import { startHub, KEY, connectedUser } from "./helpers/hub.js";

let up, hub;
const TOKEN = "jeton-de-supervision-0123456789";
const mcp = (key) => fetch(`${hub.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
before(async () => { up = await startUpstream(); hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, env: { METRICS_TOKEN: TOKEN } }); });
after(async () => { await hub?.stop(); await up?.stop(); });

test("20 échecs puis 429 (supervision : texte et WWW-Authenticate ; MCP : JSON) ; une clé valide de la même IP passe toujours", async () => {
  for (let i = 0; i < 20; i++) assert.equal((await fetch(`${hub.url}/metrics`, { headers: { Authorization: "Bearer faux" } })).status, 401, `échec ${i + 1}`);
  const m = await fetch(`${hub.url}/metrics`, { headers: { Authorization: "Bearer faux" } });
  assert.equal(m.status, 429); assert.equal(m.headers.get("www-authenticate"), 'Basic realm="supervision"');
  assert.match(m.headers.get("content-type"), /text\/plain/); assert.equal(await m.text(), "jeton de supervision requis\n");
  const k = await mcp("cle-inconnue");
  assert.equal(k.status, 429); assert.match((await k.json()).error, /échecs d'authentification/);
  assert.equal((await mcp(KEY)).status, 200, "clé valide jamais freinée");
  assert.equal((await fetch(`${hub.url}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200, "jeton valide jamais freiné");
});
