// Base d'exploitation (hub/db.js, SQLite intégré à Node) : schéma versionné, disponibilité sur 30 jours, compteurs d'usage
// mensuels, journal d'audit chiffré (AUDIT=on), purge, instantané de sauvegarde, résistance à une base illisible ; puis dans le hub
// réel : compteurs et audit à chaque appel d'outil, disponibilité dans /api/status et la supervision, outil d'administration.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startUpstream } from "./helpers/upstream.js";
import { startHub, HUB_DIR, KEY, ENCRYPTION_KEY, connectedUser } from "./helpers/hub.js";

const DIR = mkdtempSync(join(tmpdir(), "hub-db-"));
process.env.DATA_DIR = DIR; process.env.ENCRYPTION_KEY = ENCRYPTION_KEY; process.env.AUDIT = "on";
const db = await import("../db.js"); // après l'environnement : db.js et crypto.js le lisent au chargement
const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
after(() => { db.close(); rmSync(DIR, { recursive: true, force: true }); });

test("Schéma versionné : base créée, migrations appliquées une fois, réouverture sans perte", () => {
  assert.equal(db.open(), true);
  db.count("sagex3", "u1", false, NOW);
  db.close();
  assert.equal(db.open(), true);
  const raw = new DatabaseSync(db.FILE, { readOnly: true });
  assert.equal(raw.prepare("pragma user_version").get().user_version, db.MIGRATIONS.length);
  assert.equal(raw.prepare("pragma journal_mode").get().journal_mode, "wal");
  raw.close();
  assert.equal(db.usage("2026-10").systems[0].calls, 1);
});

test("Disponibilité : part des mesures opérationnel ou lent, une mesure par créneau de 10 minutes, « inconnu » ignoré", () => {
  for (let i = 0; i < 8; i++) db.sample("salesforce", "ok", 300, NOW - i * 600_000);
  db.sample("salesforce", "lent", 12_000, NOW - 8 * 600_000);
  db.sample("salesforce", "injoignable", null, NOW - 9 * 600_000);
  db.sample("salesforce", "inconnu", null, NOW - 10 * 600_000);
  db.sample("salesforce", "ok", 200, NOW - 9 * 600_000 + 5_000); // même créneau : remplace la mesure « injoignable »
  db.sample("salesforce", "erreurs", null, NOW - 40 * DAY);      // hors des 30 jours
  assert.deepEqual(db.availability("salesforce", 30, NOW), { pct: 100, samples: 10, days: 30 });
  db.sample("salesforce", "erreurs", null, NOW - 11 * 600_000);
  assert.deepEqual(db.availability("salesforce", 30, NOW), { pct: 90.9, samples: 11, days: 30 });
  assert.deepEqual(db.availability("dropbox", 30, NOW), { pct: null, samples: 0, days: 30 });
});

test("Usage : appels et erreurs du système par mois, collaborateurs actifs distincts (pseudonymes)", () => {
  db.count("myreport", "u1", false, NOW); db.count("myreport", "u2", true, NOW); db.count("myreport", "u1", false, NOW);
  db.count("myreport", "u3", false, Date.UTC(2026, 8, 30));
  const oct = db.usage("2026-10");
  assert.deepEqual(oct.systems.find((r) => r.system === "myreport"), { system: "myreport", calls: 3, errors: 1 });
  assert.equal(oct.activeUsers, 2);
  assert.equal(db.usage("2026-09").activeUsers, 1);
});

test("Audit : e-mail chiffré au repos, déchiffré pour l'administrateur ; jamais d'argument ni de résultat", () => {
  db.audit({ user: "u1", who: "marie.dupont@charlois.com", system: "sagex3", tool: "sagex3_query", outcome: "ok", ms: 120.4, at: NOW });
  const raw = new DatabaseSync(db.FILE, { readOnly: true }), row = raw.prepare("select * from audit").get(); raw.close();
  assert.match(row.who, /^enc1:/); assert.doesNotMatch(JSON.stringify(row), /charlois/);
  assert.deepEqual(Object.keys(row).sort(), ["at", "ms", "outcome", "system", "tool", "user", "who"]);
  assert.deepEqual(db.auditRows(NOW - DAY, NOW + 1).map((r) => [r.who, r.tool, r.ms]), [["marie.dupont@charlois.com", "sagex3_query", 120]]);
});

test("Purge : historique de plus de 90 jours, usage de plus de 24 mois, audit au-delà d'AUDIT_DAYS", () => {
  db.sample("sagex3", "ok", 1, NOW - 100 * DAY);
  db.count("sagex3", "vieux", false, Date.UTC(2024, 0, 15));
  db.audit({ user: "u9", who: null, system: "sagex3", tool: "sagex3_get", outcome: "ok", ms: 1, at: NOW - 120 * DAY });
  db.purge(NOW);
  const raw = new DatabaseSync(db.FILE, { readOnly: true });
  assert.equal(raw.prepare("select count(*) n from availability where at < ?").get(NOW - 90 * DAY).n, 0);
  assert.equal(raw.prepare("select count(*) n from usage where month = '2024-01'").get().n, 0);
  assert.equal(raw.prepare("select count(*) n from audit where at < ?").get(NOW - 90 * DAY).n, 0);
  assert.equal(raw.prepare("select count(*) n from audit").get().n, 1, "l'audit récent reste");
  raw.close();
});

test("Instantané : fichier SQLite complet et cohérent, publié atomiquement", async () => {
  assert.equal(await db.snapshot(), true);
  assert.equal(readFileSync(db.SNAPSHOT).subarray(0, 16).toString("latin1"), "SQLite format 3\0");
  assert.ok(!existsSync(`${db.SNAPSHOT}.tmp`));
  const copy = new DatabaseSync(db.SNAPSHOT, { readOnly: true });
  assert.equal(copy.prepare("select count(*) n from audit").get().n, 1); copy.close();
});

test("Base illisible : le hub continue sans historique ni compteurs, sans jamais faire échouer un appel", () => {
  db.close();
  const bad = join(DIR, "abime.db"); writeFileSync(bad, "ceci n'est pas une base SQLite".repeat(200));
  assert.equal(db.open(bad), false);
  const torn = join(DIR, "dechiree.db"); writeFileSync(torn, Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4000, 7)])); // en-tête correct, contenu abîmé
  assert.equal(db.open(torn), false);
  assert.equal(db.ready(), false);
  assert.equal(db.count("sagex3", "u1", false), undefined);
  assert.deepEqual(db.availability("sagex3"), { pct: null, samples: 0, days: 30 });
  assert.deepEqual(db.usage("2026-10"), { month: "2026-10", systems: [], activeUsers: 0 });
  db.open(); // retour à la base du test pour la fermeture
});

// ---------- Dans le hub réel ----------
let up, hub;
const TOKEN = "jeton-de-supervision-0123456789";
before(async () => {
  up = await startUpstream();
  // Base pré-remplie : 12 mesures de Sage X3 dont une en erreur, pour l'affichage de la disponibilité.
  const prepare = (dir) => {
    const d = new DatabaseSync(join(dir, "hub.db"));
    d.exec(db.MIGRATIONS[0]); d.exec("pragma user_version = 1"); // base d'une 1.5 déjà en service
    for (let i = 0; i < 12; i++) d.prepare("insert into availability values ('sagex3', ?, ?, 100)").run(Math.floor((Date.now() - i * 600_000) / 600_000) * 600_000, i === 3 ? "erreurs" : "ok");
    d.close();
  };
  hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, env: { AUDIT: "on", METRICS_TOKEN: TOKEN }, prepare });
});
after(async () => { await hub?.stop(); await up?.stop(); });

test("Hub : la base existante est reprise, et la disponibilité apparaît dans /api/status et la supervision", async () => {
  const st = await (await fetch(`${hub.url}/api/status`, { headers: { cookie: `mcp_key=${KEY}` } })).json();
  assert.deepEqual(st.systems.find((s) => s.id === "sagex3").availability, { pct: 91.7, samples: 12, days: 30 });
  const prom = await (await fetch(`${hub.url}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } })).text();
  assert.match(prom, /clevoa_system_availability_30d_ratio\{system="sagex3"\} 0\.917/);
  const prtg = await (await fetch(`${hub.url}/metrics/prtg`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  assert.ok(prtg.prtg.result.some((r) => r.channel === "Sage X3 · disponibilité 30 j" && r.value === 91.7));
});

test("Hub : chaque appel d'outil compte dans l'usage du mois et, avec AUDIT=on, au journal d'audit ; outil d'administration", async () => {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${hub.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
  try { await c.callTool({ name: "sagex3_representations", arguments: {} }); } finally { await c.close(); }
  const env = { ...process.env, DATA_DIR: hub.dataDir, ENCRYPTION_KEY, AUDIT: "on" };
  const usage = execFileSync(process.execPath, [join(HUB_DIR, "admin.js"), "usage"], { env, encoding: "utf8" });
  assert.match(usage, /1 collaborateur\(s\) actif\(s\)/); assert.match(usage, /sagex3\s+1 appels/);
  const audit = execFileSync(process.execPath, [join(HUB_DIR, "admin.js"), "audit"], { env, encoding: "utf8" }).trim().split("\n");
  assert.equal(audit[0], "date;collaborateur;pseudonyme;systeme;outil;resultat;duree_ms");
  assert.match(audit[1], /;alice@example\.com;[\w-]{22};sagex3;sagex3_representations;ok;\d+$/);
  const dispo = execFileSync(process.execPath, [join(HUB_DIR, "admin.js"), "disponibilite"], { env, encoding: "utf8" });
  assert.match(dispo, /sagex3\s+91\.7 %/);
  const prom = await (await fetch(`${hub.url}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } })).text();
  assert.match(prom, /clevoa_usage_month_active_users\{month="\d{4}-\d{2}"\} 1/);
  assert.doesNotMatch(hub.logs(), /alice@example\.com/, "jamais d'identité dans les journaux");
});

test("Hub : base hub.db illisible au démarrage → le hub démarre et sert les outils, le journal le signale", async () => {
  const h = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, prepare: (dir) => writeFileSync(join(dir, "hub.db"), "abîmée".repeat(500)) });
  try {
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
    try { assert.ok(!(await c.callTool({ name: "sagex3_representations", arguments: {} })).isError); } finally { await c.close(); }
    assert.match(h.logs(), /base d'exploitation indisponible/);
    assert.ok(h.logs().indexOf("base d'exploitation indisponible") < h.logs().indexOf("Hub MCP v"), "signalé avant l'annonce du démarrage (vérification de ops/restore.sh)");
  } finally { await h.stop(); }
});
