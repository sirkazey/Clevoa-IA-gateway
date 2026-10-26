// Base d'exploitation du hub (SQLite intégré à Node, /data/hub.db) : historique de disponibilité des systèmes, compteurs d'usage
// mensuels et journal d'audit (AUDIT=on). Les identités et jetons des collaborateurs restent dans users.json (store.js), inchangé.
// Écritures d'une ligne en journal WAL : jamais de réécriture du fichier entier. Rien d'identifiant en clair : collaborateurs
// pseudonymisés (HMAC), e-mail de l'audit chiffré (crypto.js). Une panne de cette base ne touche jamais les outils : le hub
// continue sans historique ni compteurs, et le dit dans son journal. Instantané cohérent toutes les 6 heures pour la sauvegarde.
import { DatabaseSync, backup } from "node:sqlite";
import { renameSync, rmSync, chmodSync } from "node:fs";
import { encrypt, decrypt } from "./crypto.js";

const DIR = process.env.DATA_DIR || "./data";
export const FILE = `${DIR}/hub.db`, SNAPSHOT = `${DIR}/hub-instantane.db`;
// Journal d'audit : désactivé par défaut, activé par le client après avis de son DPO (on, true, 1 ou oui).
export const AUDIT = /^(on|true|1|oui)$/i.test(process.env.AUDIT || "");
const days = Number(process.env.AUDIT_DAYS || 90);
// Audit actif avec une durée illisible (« 30j », « abc », 0) : la purge ne supprimerait plus rien ou effacerait tout, sans un mot.
// Refus de démarrer, comme pour METRICS_TOKEN. Sans audit, la valeur n'a pas d'effet : le hub démarre.
if (AUDIT && (!Number.isInteger(days) || days < 1)) { console.error(`[db] AUDIT_DAYS invalide (${process.env.AUDIT_DAYS}) : un nombre entier de jours, 1 au moins (défaut 90)`); process.exit(1); }
export const AUDIT_DAYS = Number.isInteger(days) && days >= 1 ? days : 90;
const HISTORY_DAYS = 90, USAGE_MONTHS = 24, SLOT = 10 * 60_000, DAY = 86_400_000;
const UP = ["ok", "lent"], DOWN = ["erreurs", "injoignable"]; // états mesurés ; « inconnu » (aucun appel, vérification en pause) et « simule » ne comptent pas

// Schéma versionné (pragma user_version) : une migration ajoutée en fin de liste, jamais modifiée une fois publiée.
export const MIGRATIONS = [
  `create table availability (system text not null, at integer not null, state text not null, p95 integer, primary key (system, at)) without rowid;
   create table usage (month text not null, system text not null, calls integer not null default 0, errors integer not null default 0, primary key (month, system)) without rowid;
   create table usage_users (month text not null, user text not null, primary key (month, user)) without rowid;
   create table audit (at integer not null, user text not null, who text, system text not null, tool text not null, outcome text not null, ms integer not null);
   create index audit_at on audit (at);`,
];

let db = null, q = null, failures = 0;
/** Exécute une opération sans jamais faire échouer l'appelant (un outil MCP, une mesure, le portail). Une écriture en échec est
 *  comptée (supervision, health()) et journalisée au plus une fois par heure, avec le message de SQLite ; une lecture en échec
 *  rend seulement « rien » (elle ne gonfle pas le compteur des écritures). */
let warnedAt = 0;
function safely(fn, write = true) {
  if (!db) return undefined;
  try { return fn(); } catch (e) {
    if (!write) return undefined;
    failures++;
    if (Date.now() - warnedAt > 3_600_000) { warnedAt = Date.now(); console.error(`[db] écriture impossible dans hub.db (${failures} depuis le démarrage) : ${e.errstr ?? e.code ?? e.message}`); }
    return undefined;
  }
}
/** État de la base pour la supervision : ouverte ou non, écritures en échec depuis le démarrage (un audit promis qui s'arrête se voit). */
export const health = () => ({ up: !!db, failures });
/** Mois AAAA-MM en heure locale (TZ du conteneur, comme la coupure du cache et les heures de vérification) : un appel du 1er à 0 h 30 compte pour ce mois. */
const month = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

/** Ouvre (ou crée) la base et applique les migrations. Échec : le hub démarre quand même, sans historique ni compteurs. */
export function open(file = FILE, { readOnly = false } = {}) {
  try {
    if (readOnly) { db = new DatabaseSync(file, { readOnly: true }); prepare(); return true; } // outil d'administration : aucune écriture, aucune migration
    db = new DatabaseSync(file);
    try { chmodSync(file, 0o600); } catch { /* volume en lecture seule : sans objet */ } // base créée par une version antérieure en 644
    // auto_vacuum avant le passage en WAL : sur une base neuve, SQLite l'ignore une fois l'en-tête écrit. Les pages libérées par la
    // purge sont alors rendues au disque (incremental_vacuum). Base créée sans (1.5.0) : convertie une fois par un VACUUM.
    db.exec("pragma auto_vacuum = incremental");
    if (db.prepare("pragma auto_vacuum").get().auto_vacuum !== 2) db.exec("vacuum");
    // secure_delete : une ligne purgée est effacée du fichier (et donc des instantanés), pas seulement marquée libre.
    db.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 1000; pragma secure_delete = on; pragma journal_size_limit = 8388608;");
    if (db.prepare("pragma quick_check").get().quick_check !== "ok") throw Object.assign(new Error("base corrompue (quick_check)"), { code: "SQLITE_CORRUPT" });
    const from = db.prepare("pragma user_version").get().user_version;
    if (from > MIGRATIONS.length) console.error(`[db] base d'une version plus récente (schéma ${from}, ce hub connaît ${MIGRATIONS.length}) : utilisée telle quelle`);
    for (let i = from; i < MIGRATIONS.length; i++) {
      db.exec("begin");
      try { db.exec(MIGRATIONS[i]); db.exec(`pragma user_version = ${i + 1}`); db.exec("commit"); } catch (e) { db.exec("rollback"); throw e; }
    }
    prepare();
    return true;
  } catch (e) {
    console.error(`[db] base d'exploitation indisponible (${e.errstr ?? e.code ?? e.message}) : le hub fonctionne sans historique, compteurs ni audit`);
    try { db?.close(); } catch { /* déjà fermée */ }
    db = null; q = null;
    return false;
  }
}
function prepare() {
  q = {
    sample: db.prepare("insert or replace into availability (system, at, state, p95) values (?, ?, ?, ?)"),
    availability: db.prepare(`select sum(state in ('${UP.join("','")}')) as up, count(*) as n from availability where system = ? and at >= ? and state in ('${[...UP, ...DOWN].join("','")}')`),
    count: db.prepare("insert into usage (month, system, calls, errors) values (?, ?, 1, ?) on conflict (month, system) do update set calls = calls + 1, errors = errors + excluded.errors"),
    user: db.prepare("insert or ignore into usage_users (month, user) values (?, ?)"),
    usage: db.prepare("select system, calls, errors from usage where month = ? order by system"),
    active: db.prepare("select count(*) as n from usage_users where month = ?"),
    audit: db.prepare("insert into audit (at, user, who, system, tool, outcome, ms) values (?, ?, ?, ?, ?, ?, ?)"),
    auditRows: db.prepare("select at, user, who, system, tool, outcome, ms from audit where at >= ? and at < ? order by at"),
  };
}
export function close() { try { db?.close(); } catch { /* déjà fermée */ } db = null; q = null; }

// ---------- Disponibilité ----------
/** Mesure de l'état d'un système (une par créneau de 10 minutes). */
export const sample = (system, state, p95, at = Date.now()) => safely(() => (UP.includes(state) || DOWN.includes(state)) && q.sample.run(system, Math.floor(at / SLOT) * SLOT, state, p95 ?? null));
/** Disponibilité sur `days` jours : part des mesures « opérationnel » ou « lent » parmi les mesures significatives. */
export function availability(system, days = 30, now = Date.now()) {
  const r = safely(() => q.availability.get(system, now - days * DAY), false);
  return r && r.n ? { pct: Math.round((1000 * r.up) / r.n) / 10, samples: r.n, days } : { pct: null, samples: 0, days };
}

// ---------- Usage ----------
/** Un appel d'outil : compteur du mois du système, et collaborateur actif du mois (pseudonyme). */
export const count = (system, user, failed, at = Date.now()) => safely(() => { q.count.run(month(at), system, failed ? 1 : 0); if (user) q.user.run(month(at), user); });
/** Usage d'un mois (AAAA-MM) : appels et erreurs par système, collaborateurs actifs. */
export function usage(m = month(Date.now())) {
  return safely(() => ({ month: m, systems: q.usage.all(m).map((r) => ({ ...r })), activeUsers: q.active.get(m).n }), false) ?? { month: m, systems: [], activeUsers: 0 };
}

// ---------- Audit ----------
/** Un appel d'outil au journal d'audit (seulement avec AUDIT=on) : jamais les arguments ni le résultat. */
export const audit = ({ user, who, system, tool, outcome, ms, at = Date.now() }) =>
  AUDIT && safely(() => q.audit.run(at, user, who ? encrypt(who) : null, system, tool, outcome, Math.round(ms)));
/** Lignes du journal d'audit entre deux dates, e-mails déchiffrés (outil d'administration). */
export const auditRows = (from, to) => (safely(() => q.auditRows.all(from, to), false) ?? []).map((r) => {
  let who = null;
  try { who = r.who ? decrypt(r.who) : null; } catch { who = "(indéchiffrable)"; } // autre ENCRYPTION_KEY ou ligne abîmée : l'export continue
  return { ...r, who };
});

// ---------- Entretien ----------
/** Purge des données plus anciennes que leur durée de conservation. */
export function purge(now = Date.now()) {
  const oldMonth = month(new Date(new Date(now).setUTCMonth(new Date(now).getUTCMonth() - USAGE_MONTHS)).getTime());
  safely(() => {
    db.prepare("delete from availability where at < ?").run(now - HISTORY_DAYS * DAY);
    db.prepare("delete from usage where month < ?").run(oldMonth);
    db.prepare("delete from usage_users where month < ?").run(oldMonth);
    db.prepare("delete from audit where at < ?").run(now - AUDIT_DAYS * DAY);
    db.exec("pragma incremental_vacuum; pragma wal_checkpoint(truncate)"); // pages libres rendues au disque ; le journal WAL ne garde pas de copie des lignes purgées
  });
}
/** Instantané cohérent de la base (sauvegarde à chaud de SQLite), publié atomiquement pour le conteneur de sauvegarde. */
export async function snapshot(target = SNAPSHOT) {
  if (!db) return false;
  const tmp = `${target}.tmp`;
  try { rmSync(tmp, { force: true }); await backup(db, tmp); chmodSync(tmp, 0o600); renameSync(tmp, target); return true; }
  catch (e) { rmSync(tmp, { force: true }); console.error(`[db] instantané impossible : ${e.code ?? e.message}`); return false; }
}

/** Mesure l'état de chaque système toutes les 10 minutes ; purge chaque jour ; instantané toutes les 6 heures (copié chaque jour par
 *  mcp-backup) : la base entière est recopiée, une fréquence plus haute userait le disque pour rien. */
export function start(connectors, status) {
  if (!open()) return;
  const measure = () => { for (const c of connectors) if (!c.mock) { const s = status(c); sample(c.id, s.state, s.p95); } };
  setTimeout(() => { purge(); snapshot(); }, 60_000).unref(); // premier instantané une minute après le démarrage
  setInterval(purge, DAY).unref();
  setInterval(snapshot, 6 * 3_600_000).unref();
  setInterval(measure, SLOT).unref();
}
