// Résolution des noms (hub/resolve.js) : IPv4 d'abord puis IPv6, sans doublon, quand musl ne rend que de l'IPv6 (48 adresses en
// double, constaté avec le DNS de Docker Desktop pour login.microsoftonline.com) ; famille imposée respectée ; erreur d'origine
// conservée. Retour de connexion en échec réseau : code court au journal, jamais l'URL ni le message.
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { createServer } from "node:http";
import { ipv4First, install } from "../resolve.js";
import { startHub, KEY, freePort } from "./helpers/hub.js";
import { startUpstream } from "./helpers/upstream.js";

const V6 = ["2603:1026:3000:150::8", "2603:1027:1:150::4"];
const V4 = ["40.126.32.74", "20.190.160.3"];
/** Résolveur simulé : en famille 0, comme musl saturé, seulement de l'IPv6 répété jusqu'à 48 adresses. */
function fakeLookup(calls = []) {
  return (host, opts, cb) => {
    calls.push(opts.family);
    if (host === "inconnu.example") return cb(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    const v4 = [...V4, ...V4].map((address) => ({ address, family: 4 })), v6 = Array.from({ length: 48 }, (_, i) => ({ address: V6[i % 2], family: 6 }));
    const list = opts.family === 4 ? v4 : opts.family === 6 ? v6 : v6;
    if (opts.family === 4 && host === "v6seul.example") return cb(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  };
}
const call = (lookup, host, opts) => new Promise((resolve, reject) => lookup(host, opts, (e, a, f) => (e ? reject(e) : resolve(opts.all ? a : [a, f]))));

test("IPv4 d'abord puis IPv6, sans doublon, alors que la résolution système ne rend que de l'IPv6", async () => {
  const lookup = ipv4First(fakeLookup());
  assert.deepEqual((await call(lookup, "login.microsoftonline.com", { all: true, hints: 32 })).map((a) => a.address), [...V4, ...V6]);
  assert.deepEqual(await call(lookup, "login.microsoftonline.com", {}), [V4[0], 4]);
});

test("Hôte IPv6 seul : adresses IPv6 rendues ; famille imposée par l'appelant : inchangée ; nom inconnu : erreur d'origine", async () => {
  const lookup = ipv4First(fakeLookup());
  assert.deepEqual((await call(lookup, "v6seul.example", { all: true })).map((a) => a.address), V6);
  const calls = [];
  await call(ipv4First(fakeLookup(calls)), "login.microsoftonline.com", { family: 6, all: true });
  assert.deepEqual(calls, [6], "une seule résolution, dans la famille demandée");
  await assert.rejects(call(lookup, "inconnu.example", { all: true }), { code: "ENOTFOUND" });
});

test("Installée une seule fois et utilisée par fetch (node:net lit dns.lookup à chaque connexion)", async () => {
  const native = dns.lookup;
  const srv = createServer((req, res) => res.end("ok"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const families = [];
    dns.lookup = function spy(host, opts, cb) { families.push(opts.family); return native.call(dns, host, opts, cb); };
    install(); const once = dns.lookup; install();
    assert.equal(dns.lookup, once, "pas d'enveloppe empilée");
    assert.equal(dns.lookup.name, "lookupIpv4First");
    const r = await fetch(`http://localhost:${srv.address().port}/`);
    assert.equal(await r.text(), "ok", "localhost résolu en 127.0.0.1 (IPv4 d'abord)");
    assert.ok(families.includes(4) && families.includes(6), `familles demandées par fetch : ${families}`);
  } finally { dns.lookup = native; srv.close(); }
});

test("Retour de connexion SharePoint, annuaire injoignable : 502 « réseau » au navigateur, code ECONNREFUSED au journal, sans URL", async () => {
  const up = await startUpstream();
  const closed = await freePort();
  const login = `http://127.0.0.1:${closed}/ms`;
  const hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: { createdAt: "2026-01-01T00:00:00.000Z", email: "alice@example.com" } }, env: { APP_ENV: "preprod", MS_LOGIN_URL: login } });
  try {
    const opts = { headers: { cookie: `mcp_key=${KEY}` }, redirect: "manual" };
    const start = await fetch(`${hub.url}/auth/sharepoint`, opts);
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cb = await fetch(`${hub.url}/auth/sharepoint/callback?code=alice&state=${state}`, opts);
    assert.equal(cb.status, 502);
    assert.match(await cb.text(), /Échec de la connexion SharePoint \(réseau\)/);
    const line = hub.logs().split("\n").find((l) => l.includes("[oauth] sharepoint : échec de l'échange de jeton"));
    assert.equal(line?.trim(), "[oauth] sharepoint : échec de l'échange de jeton (ECONNREFUSED)");
    assert.ok(!hub.logs().includes(String(closed)), "ni l'adresse ni le port de l'annuaire au journal");
  } finally { await hub.stop(); await up.stop(); }
});
