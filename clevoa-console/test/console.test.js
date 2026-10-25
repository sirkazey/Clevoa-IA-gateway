// Console de suivi, sans AWS : source de démonstration, page et API servies, état des installations, mot de passe, lecture seule.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { demoSource } from "../demo.js";

process.env.CONSOLE_PASSWORD = "mot-de-passe-de-test";
const { createConsole, status } = await import("../server.js");
let server, url;
const auth = { Authorization: `Basic ${Buffer.from("clevoa:mot-de-passe-de-test").toString("base64")}` };
before(async () => { server = createConsole(demoSource()); await new Promise((r) => server.listen(0, "127.0.0.1", r)); url = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

test("Mot de passe exigé : 401 sans ou avec un mauvais mot de passe, page servie avec le bon ; /health ouvert", async () => {
  assert.equal((await fetch(`${url}/`)).status, 401);
  assert.equal((await fetch(`${url}/api/installations`, { headers: { Authorization: `Basic ${Buffer.from("x:faux").toString("base64")}` } })).status, 401);
  const r = await fetch(`${url}/`, { headers: auth });
  assert.equal(r.status, 200); assert.match(await r.text(), /Console de suivi des installations/);
  assert.match(r.headers.get("content-security-policy"), /default-src 'self'/); assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal((await fetch(`${url}/health`)).status, 200);
});

test("Lecture seule : toute méthode autre que GET est refusée ; la source n'expose aucune écriture", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal((await fetch(`${url}/api/installations`, { method, headers: auth })).status, 405, method);
  const src = demoSource();
  assert.deepEqual(Object.keys(src).sort(), ["demo", "get", "history", "list"]);
});

test("Installations : état (incident, silencieuse, ok), incidents en clair, dernière période, sans aucune clé", async () => {
  const d = await (await fetch(`${url}/api/installations`, { headers: auth })).json();
  assert.equal(d.demo, true);
  assert.deepEqual(d.installations.map((i) => [i.client, i.status]), [["charlois", "incident"], ["client-exemple", "silencieuse"], ["charlois-preprod", "ok"]], "incidents en tête");
  const c = d.installations[0];
  assert.match(c.incidents[0], /^Sage X3 : \d+ % d'erreurs/); assert.ok(c.calls > 0); assert.ok(c.p95 > 0);
  assert.ok(!/cle-|password|mot-de-passe/i.test(JSON.stringify(d)));
});

test("Historique : 30 jours de périodes de 6 h ; installation invalide refusée", async () => {
  const pk = "charlois#5d2c7a1e-90b4-4f6e-8a3d-2b1c0e9f7a64#PRODUCTION";
  const d = await (await fetch(`${url}/api/history?pk=${encodeURIComponent(pk)}&days=30`, { headers: auth })).json();
  assert.ok(d.periods.length >= 110 && d.periods.length <= 121, `${d.periods.length} périodes`);
  assert.ok(d.periods.every((p) => p.stats && typeof p.at === "string"));
  for (const bad of ["", "pas une clé", "a#b", "../etc#x#PRODUCTION"]) assert.equal((await fetch(`${url}/api/history?pk=${encodeURIComponent(bad)}`, { headers: auth })).status, 400, bad);
  assert.equal((await fetch(`${url}/inconnu`, { headers: auth })).status, 404);
});

test("État : même règle que le backend (silence au-delà de 14 h, perdue au-delà de 30 jours)", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  assert.equal(status({ lastSeen: "2026-10-25T09:00:00Z", incidents: [] }, now), "ok");
  assert.equal(status({ lastSeen: "2026-10-25T09:00:00Z", incidents: ["erreurs:sagex3"] }, now), "incident");
  assert.equal(status({ lastSeen: "2026-10-24T20:00:00Z", incidents: [] }, now), "silencieuse");
  assert.equal(status({ lastSeen: "2026-09-01T00:00:00Z", incidents: [] }, now), "perdue");
});

test("Échecs répétés du mot de passe : 429 après 10 essais en une minute", async () => {
  const bad = { Authorization: `Basic ${Buffer.from("x:faux").toString("base64")}` };
  for (let i = 0; i < 10; i++) await fetch(`${url}/api/installations`, { headers: bad });
  assert.equal((await fetch(`${url}/api/installations`, { headers: bad })).status, 429);
});
