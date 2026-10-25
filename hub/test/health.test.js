// État des systèmes (1.4.0) : heures de sonde, sonde HEAD sans identifiant, état calculé à partir des appels réels, route du portail
// /api/status et supervision /metrics (jeton dédié, format Prometheus, aucune identité).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startUpstream } from "./helpers/upstream.js";
import { startHub, connectedUser, KEY, freePort } from "./helpers/hub.js";
import * as health from "../health.js";

let up;
before(async () => { up = await startUpstream(); });
after(async () => { await up?.stop(); });

test("Heures de sonde : du lundi au vendredi, de 7 h à 19 h (heure du serveur)", () => {
  const at = (iso) => health.inProbeHours(new Date(iso));
  assert.equal(at("2026-10-26T10:00:00"), true, "lundi 10 h");
  assert.equal(at("2026-10-30T07:00:00"), true, "vendredi 7 h pile");
  assert.equal(at("2026-10-26T06:59:00"), false, "lundi 6 h 59");
  assert.equal(at("2026-10-26T19:00:00"), false, "lundi 19 h pile");
  assert.equal(at("2026-10-31T10:00:00"), false, "samedi");
  assert.equal(at("2026-11-01T10:00:00"), false, "dimanche");
});

test("Sonde HEAD : toute réponse HTTP vaut « joignable » (401, 405 compris), sans en-tête d'authentification ; refus et délai : injoignable", async () => {
  health.reset();
  const seen = [];
  const srv = createServer((req, res) => { seen.push({ method: req.method, auth: req.headers.authorization }); res.writeHead(405).end(); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const closed = await freePort();
  const base = { apiKey: {}, mock: false };
  try {
    await health.probe({ ...base, id: "a", probeUrl: `http://127.0.0.1:${srv.address().port}/` });
    await health.probe({ ...base, id: "b", probeUrl: `http://127.0.0.1:${closed}/` });
    assert.deepEqual(seen, [{ method: "HEAD", auth: undefined }], "une requête HEAD, sans identifiant");
    assert.equal(health.status({ ...base, id: "a" }).state, "ok");
    const b = health.status({ ...base, id: "b" });
    assert.equal(b.state, "injoignable"); assert.equal(b.probe.reason, "connexion refusée");
    assert.equal(health.probeable({ id: "s", mock: true, probeUrl: "http://x", apiKey: {} }), false, "jamais un simulateur");
    assert.equal(health.probeable({ id: "o", probeUrl: "http://x", oauth: {} }), false, "jamais un système non configuré");
  } finally { srv.close(); }
});

test("État calculé sur les appels de la dernière heure : erreurs, injoignable, lent, inconnu ; erreurs d'usage ignorées", () => {
  health.reset();
  const c = (id) => ({ id, apiKey: {}, mock: false });
  for (let i = 0; i < 10; i++) health.record("err", 100, i < 3 ? Object.assign(new Error("x"), { status: 500 }) : undefined);
  assert.equal(health.status(c("err")).state, "erreurs", "30 % d'erreurs du système");
  for (let i = 0; i < 10; i++) health.record("down", 5000, i < 6 ? new Error("Sage X3 injoignable") : undefined);
  assert.equal(health.status(c("down")).state, "injoignable", "erreurs surtout réseau");
  for (let i = 0; i < 10; i++) health.record("usage", 100, new Error("Non connecté à Sage X3."));
  assert.equal(health.status(c("usage")).state, "ok", "outil non connecté : erreur d'usage, le système va bien");
  for (let i = 0; i < 10; i++) health.record("slow", 15_000);
  const slow = health.status(c("slow"));
  assert.equal(slow.state, "lent"); assert.equal(slow.p95, 15_000); assert.ok(slow.lastOk);
  assert.equal(health.status(c("rien")).state, "inconnu", "aucun appel, aucune sonde récente");
  assert.equal(health.status({ id: "sim", mock: true }).state, "simule");
  assert.equal(health.status(c("err"), Date.now() + 2 * 3600_000).state, "inconnu", "au-delà d'une heure, les appels ne comptent plus");
});

test("Hub : /api/status réservé au collaborateur ; sonde des seuls systèmes réels ; aucun volume ni identité", async () => {
  const hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, env: { PROBE: "always", MYREPORT_MCP_URL: "" } });
  try {
    assert.equal((await fetch(`${hub.url}/api/status`)).status, 401, "sans clé de portail");
    const deadline = Date.now() + 5000;
    while (up.requests("", "HEAD").length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const heads = up.requests("", "HEAD");
    assert.ok(heads.length >= 4, `${heads.length} sondes`);
    assert.ok(heads.every((r) => !r.headers.authorization), "aucun identifiant envoyé");
    const s = await (await fetch(`${hub.url}/api/status`, { headers: { Cookie: `mcp_key=${KEY}` } })).json();
    assert.equal(s.paused, false); assert.match(s.probeHours, /lundi au vendredi/);
    const byId = Object.fromEntries(s.systems.map((x) => [x.id, x]));
    if (process.env.APP_ENV === "production") assert.equal(byId.myreport, undefined, "production : simulateur non exposé");
    else assert.equal(byId.myreport.state, "simule", "simulateur : jamais sondé");
    for (const id of ["salesforce", "sagex3", "sharepoint", "dropbox"]) assert.ok(byId[id].probe?.ok, `${id} sondé et joignable`);
    assert.ok(!/calls|alice|users|seats/.test(JSON.stringify(s)), "ni volume ni identité");
    const me = await (await fetch(`${hub.url}/api/me`, { headers: { Cookie: `mcp_key=${KEY}` } })).json();
    assert.deepEqual(me.systems.map((x) => x.domain), ["commerce", "finance", "documents", "documents", "finance"].slice(0, me.systems.length));
  } finally { await hub.stop(); }
});

test("Hub : domaine d'une application surchargé par CONNECTOR_DOMAINS ; valeur inconnue ignorée", async () => {
  const hub = await startHub({ upstreamUrl: up.url, env: { CONNECTOR_DOMAINS: "sagex3=industrie, dropbox=pirate, __proto__=finance" } });
  try {
    const me = await (await fetch(`${hub.url}/api/me`)).json();
    assert.deepEqual(me.systems.map((x) => x.domain), ["commerce", "industrie", "documents", "documents", "finance"]);
  } finally { await hub.stop(); }
});

test("Supervision /metrics : absente sans METRICS_TOKEN ; jeton exigé ; format Prometheus sans identité ni clé", async () => {
  const off = await startHub({ upstreamUrl: up.url });
  try { assert.equal((await fetch(`${off.url}/metrics`)).status, 404, "désactivée par défaut"); } finally { await off.stop(); }
  const hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, env: { METRICS_TOKEN: "jeton-supervision-0123456789" } });
  try {
    assert.equal((await fetch(`${hub.url}/metrics`)).status, 401);
    assert.equal((await fetch(`${hub.url}/metrics`, { headers: { Authorization: `Bearer ${KEY}` } })).status, 401, "une clé de collaborateur ne suffit pas");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${hub.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
    assert.ok(!(await c.callTool({ name: "sagex3_representations", arguments: {} })).isError, "appel réussi");
    await c.close();
    const r = await fetch(`${hub.url}/metrics`, { headers: { Authorization: "Bearer jeton-supervision-0123456789" } });
    assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /^text\/plain; version=0\.0\.4/);
    const txt = await r.text();
    assert.match(txt, new RegExp(`^clevoa_hub_info\\{version="[^"]+",env="${process.env.APP_ENV === "production" ? "PRODUCTION" : "PRE-PROD"}"\\} 1$`, "m"));
    assert.match(txt, /^clevoa_system_calls_total\{system="sagex3"\} 1$/m);
    assert.match(txt, /^clevoa_system_state\{system="sagex3",state="ok"\} 1$/m);
    assert.match(txt, /^clevoa_hub_seats 1$/m);
    for (const x of [KEY, "alice", "sage-token", "jeton-supervision"]) assert.ok(!txt.includes(x), `rien de ${x}`);
    const cfg = (await (await fetch(`${hub.url}/api/me`, { headers: { Cookie: `mcp_key=${KEY}` } })).json()).config ?? [];
    assert.equal(cfg.find((v) => v.name === "METRICS_TOKEN")?.value, "••••••••", "jeton masqué dans la configuration du portail");
  } finally { await hub.stop(); }
});
