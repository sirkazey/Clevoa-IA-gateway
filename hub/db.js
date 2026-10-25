// Base d'exploitation du hub (SQLite intégré à Node, /data/hub.db) : historique de disponibilité des systèmes, compteurs d'usage
// mensuels et journal d'audit (AUDIT=on). Les identités et jetons des collaborateurs restent dans users.json (store.js), inchangé.
// Écritures d'une ligne en journal WAL : jamais de réécriture du fichier entier. Rien d'identifiant en clair : collaborateurs
// pseudonymisés (HMAC), e-mail de l'audit chiffré (crypto.js). Une panne de cette base ne touche jamais les outils : le hub
// continue sans historique ni compteurs, et le dit dans son journal. Instantané cohérent chaque heure pour la sauvegarde.
import { DatabaseSync, backup } from "node:sqlite";
import { renameSync, rmSync } from "node:fs";
import { encrypt, decrypt } from "./crypto.js";

const DIR = process.env.DATA_DIR || "./data";
export const FILE = `${DIR}/hub.db`, SNAPSHOT = `${DIR}/hub-instantane.db`;
export const AUDIT = process.env.AUDIT === "on"; // journal d'audit : désactivé par défaut, activé par le client après avis de son DPO
export const AUDIT_DAYS = Number(process.env.AUDIT_DAYS || 90);
const HISTORY_DAYS = 90, USAGE_MONTHS = 24, SLOT = 10 * 60_000, DAY = 86_400_000;
const UP = ["ok", "lent"], DOWN = ["erreurs", "injoignable"]; // états mesurés ; « inconnu » (aucun appel, vérification en pause) et « simule » ne comptent pas

// Schéma versionné (pragma user_version) : une migration ajoutée en fin de liste, jamais modifiée une fois publiée.
export const MIGRATIONS = [
  `create table availability (system text not null, at integer not null, state text not null, p95 integer, primary key (system, at)) without rowid;
   create table usage (month text not null, system text not null, calls integer not null default 0, errors integer not null default 0, primary key (month, system)) without rowid;
   create table usage_users (month text not null, user text not null, primary key (month, user)) without rowid;
   create table audit (at integer not null, user text not null, who text, system text not null, tool text not null, outcome text not null, ms integer not null);
   create index audit_at on audit (at);`,
  // Prototype « un clic » (proto/oauth-tunnel, jamais fusionné tel quel) : clients inscrits et sessions du serveur OAuth du hub,
  // contenu chiffré (secret client, refresh token de l'annuaire) ; empreintes seulement pour les jetons du hub.
  `create table oauth_clients (id text primary key, data text not null) without rowid;
   create table oauth_sessions (sid text primary key, data text not null, exp integer not null) without rowid;`,
];

let db = null, q = null, warned = false;
/** Exécute une écriture sans jamais faire échouer l'appelant (un outil MCP, une mesure) : erreur journalisée une fois. */
function safely(fn) {
  if (!db) return undefined;
  try { return fn(); } catch (e) { if (!warned) { warned = true; console.error(`[db] écriture impossible dans hub.db : ${e.code ?? e.message}`); } return undefined; }
}
const month = (at) => new Date(at).toISOString().slice(0, 7);

/** Ouvre (ou crée) la base et applique les migrations. Échec : le hub démarre quand même, sans historique ni compteurs. */
export function open(file = FILE) {
  try {
    db = new DatabaseSync(file);
    db.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 5000;");
    if (db.prepare("pragma quick_check").get().quick_check !== "ok") throw Object.assign(new Error("base corrompue (quick_check)"), { code: "SQLITE_CORRUPT" });
    const from = db.prepare("pragma user_version").get().user_version;
    for (let i = from; i < MIGRATIONS.length; i++) {
      db.exec("begin");
      try { db.exec(MIGRATIONS[i]); db.exec(`pragma user_version = ${i + 1}`); db.exec("commit"); } catch (e) { db.exec("rollback"); throw e; }
    }
    q = {
      sample: db.prepare("insert or replace into availability (system, at, state, p95) values (?, ?, ?, ?)"),
      availability: db.prepare(`select sum(state in ('${UP.join("','")}')) as up, count(*) as n from availability where system = ? and at >= ? and state in ('${[...UP, ...DOWN].join("','")}')`),
      count: db.prepare("insert into usage (month, system, calls, errors) values (?, ?, 1, ?) on conflict (month, system) do update set calls = calls + 1, errors = errors + excluded.errors"),
      user: db.prepare("insert or ignore into usage_users (month, user) values (?, ?)"),
      usage: db.prepare("select system, calls, errors from usage where month = ? order by system"),
      active: db.prepare("select count(*) as n from usage_users where month = ?"),
      audit: db.prepare("insert into audit (at, user, who, system, tool, outcome, ms) values (?, ?, ?, ?, ?, ?, ?)"),
      auditRows: db.prepare("select at, user, who, system, tool, outcome, ms from audit where at >= ? and at < ? order by at"),
      clients: db.prepare("select id, data from oauth_clients"),
      sessions: db.prepare("select sid, data from oauth_sessions"),
      putClient: db.prepare("insert or replace into oauth_clients (id, data) values (?, ?)"),
      dropClient: db.prepare("delete from oauth_clients where id = ?"),
      putSession: db.prepare("insert or replace into oauth_sessions (sid, data, exp) values (?, ?, ?)"),
      dropSession: db.prepare("delete from oauth_sessions where sid = ?"),
    };
    return true;
  } catch (e) {
    console.error(`[db] base d'exploitation indisponible (${e.code ?? e.message}) : le hub fonctionne sans historique, compteurs ni audit`);
    try { db?.close(); } catch { /* déjà fermée */ }
    db = null; q = null;
    return false;
  }
}
export const ready = () => !!db;
export function close() { try { db?.close(); } catch { /* déjà fermée */ } db = null; q = null; }

// ---------- Disponibilité ----------
/** Mesure de l'état d'un système (une par créneau de 10 minutes). */
export const sample = (system, state, p95, at = Date.now()) => safely(() => (UP.includes(state) || DOWN.includes(state)) && q.sample.run(system, Math.floor(at / SLOT) * SLOT, state, p95 ?? null));
/** Disponibilité sur `days` jours : part des mesures « opérationnel » ou « lent » parmi les mesures significatives. */
export function availability(system, days = 30, now = Date.now()) {
  const r = safely(() => q.availability.get(system, now - days * DAY));
  return r && r.n ? { pct: Math.round((1000 * r.up) / r.n) / 10, samples: r.n, days } : { pct: null, samples: 0, days };
}

// ---------- Usage ----------
/** Un appel d'outil : compteur du mois du système, et collaborateur actif du mois (pseudonyme). */
export const count = (system, user, failed, at = Date.now()) => safely(() => { q.count.run(month(at), system, failed ? 1 : 0); if (user) q.user.run(month(at), user); });
/** Usage d'un mois (AAAA-MM) : appels et erreurs par système, collaborateurs actifs. */
export function usage(m = month(Date.now())) {
  return safely(() => ({ month: m, systems: q.usage.all(m).map((r) => ({ ...r })), activeUsers: q.active.get(m).n })) ?? { month: m, systems: [], activeUsers: 0 };
}

// ---------- Audit ----------
/** Un appel d'outil au journal d'audit (seulement avec AUDIT=on) : jamais les arguments ni le résultat. */
export const audit = ({ user, who, system, tool, outcome, ms, at = Date.now() }) =>
  AUDIT && safely(() => q.audit.run(at, user, who ? encrypt(who) : null, system, tool, outcome, Math.round(ms)));
/** Lignes du journal d'audit entre deux dates, e-mails déchiffrés (outil d'administration). */
export const auditRows = (from, to) => (safely(() => q.auditRows.all(from, to)) ?? []).map((r) => ({ ...r, who: r.who ? decrypt(r.who) : null }));

// ---------- Serveur OAuth du hub (prototype « un clic ») ----------
/** Clients et sessions enregistrés, déchiffrés ; null si la base est indisponible (le serveur OAuth tient alors en mémoire seulement). */
export function oauthLoad() {
  if (!db) return null;
  const read = (rows, k) => Object.fromEntries(rows.map((r) => [r[k], JSON.parse(decrypt(r.data))]));
  try { return { clients: read(q.clients.all(), "id"), sessions: read(q.sessions.all(), "sid") }; }
  catch (e) { console.error(`[db] sessions OAuth illisibles (${e.code ?? e.message}) : reconnexion des assistants nécessaire`); return { clients: {}, sessions: {} }; }
}
/** Écrit (ou supprime, `c` absent) un client inscrit : une ligne, jamais tout le fichier. */
export const oauthClient = (id, c) => safely(() => (c ? q.putClient.run(id, encrypt(JSON.stringify(c))) : q.dropClient.run(id)));
/** Écrit (ou supprime, `s` absent) une session. */
export const oauthSession = (sid, s) => safely(() => (s ? q.putSession.run(sid, encrypt(JSON.stringify(s)), s.exp) : q.dropSession.run(sid)));

// ---------- Entretien ----------
/** Purge des données plus anciennes que leur durée de conservation. */
export function purge(now = Date.now()) {
  const oldMonth = month(new Date(new Date(now).setUTCMonth(new Date(now).getUTCMonth() - USAGE_MONTHS)).getTime());
  safely(() => {
    db.prepare("delete from availability where at < ?").run(now - HISTORY_DAYS * DAY);
    db.prepare("delete from usage where month < ?").run(oldMonth);
    db.prepare("delete from usage_users where month < ?").run(oldMonth);
    db.prepare("delete from audit where at < ?").run(now - AUDIT_DAYS * DAY);
    db.prepare("delete from oauth_sessions where exp < ?").run(now);
  });
}
/** Instantané cohérent de la base (sauvegarde à chaud de SQLite), publié atomiquement pour le conteneur de sauvegarde. */
export async function snapshot(target = SNAPSHOT) {
  if (!db) return false;
  const tmp = `${target}.tmp`;
  try { rmSync(tmp, { force: true }); await backup(db, tmp); renameSync(tmp, target); return true; }
  catch (e) { rmSync(tmp, { force: true }); console.error(`[db] instantané impossible : ${e.code ?? e.message}`); return false; }
}

/** Mesure l'état de chaque système toutes les 10 minutes ; purge chaque jour ; instantané chaque heure (copié par mcp-backup). */
export function start(connectors, status) {
  if (!open()) return;
  const measure = () => { for (const c of connectors) if (!c.mock) { const s = status(c); sample(c.id, s.state, s.p95); } };
  setTimeout(() => { purge(); snapshot(); }, 60_000).unref(); // premier instantané une minute après le démarrage
  setInterval(purge, DAY).unref();
  setInterval(snapshot, 3_600_000).unref();
  setInterval(measure, SLOT).unref();
}
