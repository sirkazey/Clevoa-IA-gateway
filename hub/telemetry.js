// Télémétrie Clevoa : un HTTPS POST au démarrage puis toutes les 6 heures (03:00, 09:00, 15:00, 21:00), réduit à des compteurs.
// Payload : identifiant aléatoire de l'installation, version du hub, environnement, état de configuration des connecteurs (booléens),
// compteur brut de requêtes MCP, nombre de sièges, et par connecteur utilisé depuis le dernier envoi : appels, erreurs par type,
// nombre de collaborateurs distincts (un entier), latence médiane et 95e centile. Jamais de donnée utilisateur, de jeton,
// de requête, de résultat ni de message d'erreur. Désactivée si CLEVOA_KEY est vide.
// Ne bloque jamais le hub : délai de 10 s par envoi, trois nouveaux essais espacés après un échec, puis le créneau suivant.
import { randomBytes, createHash } from "node:crypto";
import { VERSION, APP_ENV } from "./version.js";

const URL_ = process.env.CLEVOA_URL || "https://clevoa.fr/api/v1/telemetry";
const KEY = process.env.CLEVOA_KEY || "";
const HOURS = [3, 9, 15, 21];
const TIMEOUT = 10_000;
const MAX_SAMPLES = 2000; // latences gardées par connecteur et par période : au-delà, échantillonnage uniforme
const MAX_MS = 600_000; // latence plafonnée à 10 minutes (borne acceptée par le backend)
export const ERROR_TYPES = ["auth", "quota", "timeout", "unreachable", "other", "user"];
let requests = 0, lastOk = null;
export const count = () => { requests++; };
/** Date du dernier envoi accepté par Clevoa (supervision : /metrics). */
export const lastSuccess = () => lastOk;

// ---------- Statistiques par connecteur ----------
// Collaborateur distinct : empreinte de sa clé MCP avec un sel tiré au démarrage, gardée en mémoire et jamais envoyée.
const SALT = randomBytes(16);
const who = (key) => createHash("sha256").update(SALT).update(String(key)).digest("base64url").slice(0, 16);
let stats = new Map(), since = new Date().toISOString();
// authUsers : collaborateurs refusés en authentification ; okUsers : collaborateurs servis au moins une fois. Seuls les refusés
// jamais servis sur la période comptent (un jeton rafraîchi après un 401 n'est pas une panne d'authentification).
const fresh = () => ({ calls: 0, errors: Object.fromEntries(ERROR_TYPES.map((t) => [t, 0])), users: new Set(), authUsers: new Set(), okUsers: new Set(), lat: [], seen: 0 });

/** Classe une erreur d'outil par type, d'après son statut et la forme du message (jamais transmis). « user » : outil non connecté
 *  ou refusé par la liste blanche, une erreur d'usage qui ne compte pas dans le taux d'erreur du système. */
export function category(e) {
  const s = e?.status, m = String(e?.message || "");
  if (m.startsWith("Non connecté") || /refusé : (absent de la liste blanche|le hub n'exécute)/.test(m)) return "user";
  if (s === 401 || s === 403 || /expirée ou révoquée/.test(m)) return "auth";
  if (s === 429 || /plafond de \d+ appels/.test(m)) return "quota";
  if (s === 504 || e?.name === "TimeoutError" || /pas de réponse en \d+ s/.test(m)) return "timeout";
  if (/injoignable/.test(m) || ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN", "ETIMEDOUT"].includes(s)) return "unreachable";
  return "other";
}

/** Enregistre un appel d'outil : connecteur, clé de l'appelant (empreinte locale), durée, erreur éventuelle. */
export function record(connector, key, ms, error) {
  if (!KEY) return; // télémétrie désactivée : rien ne serait envoyé
  let s = stats.get(connector);
  if (!s) stats.set(connector, (s = fresh()));
  const u = who(key);
  s.calls++; s.users.add(u); s.seen++;
  if (error) { const t = category(error); s.errors[t]++; if (t === "auth") s.authUsers.add(u); } else s.okUsers.add(u);
  const v = Math.min(Math.max(ms, 0), MAX_MS);
  if (s.lat.length < MAX_SAMPLES) s.lat.push(v);
  else { const i = Math.floor(Math.random() * s.seen); if (i < MAX_SAMPLES) s.lat[i] = v; } // échantillon uniforme sur la période
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
/** Résumé envoyable : seulement des nombres, par connecteur utilisé. */
export const summary = (m = stats) => Object.fromEntries([...m].map(([id, s]) => {
  const sorted = [...s.lat].sort((a, b) => a - b);
  return [id, { calls: s.calls, errors: { ...s.errors }, users: s.users.size, authUsers: [...s.authUsers].filter((u) => !s.okUsers.has(u)).length, p50: Math.round(pct(sorted, 50)), p95: Math.round(pct(sorted, 95)) }];
}));

/** Remet dans la période courante les statistiques d'un envoi échoué (rien ne se perd, rien n'est compté deux fois). */
function restore(old) {
  for (const [id, o] of old) {
    const s = stats.get(id) ?? fresh(); stats.set(id, s);
    s.calls += o.calls; s.seen += o.seen; for (const t of ERROR_TYPES) s.errors[t] += o.errors[t];
    for (const u of o.users) s.users.add(u); for (const u of o.authUsers) s.authUsers.add(u); for (const u of o.okUsers) s.okUsers.add(u);
    s.lat = [...o.lat, ...s.lat].slice(0, MAX_SAMPLES);
  }
}

/** Construit le payload à partir des connecteurs (configuré = vrai système joignable, simulateur = faux). */
export const payload = (connectors, seats = 0, installation, m = stats, from = since) => ({
  ...(installation ? { installation } : {}),
  version: VERSION,
  env: APP_ENV,
  date: new Date().toISOString().slice(0, 10),
  connectors: Object.fromEntries(connectors.map((c) => [c.id, !c.mock && !!(c.oauth?.clientId || c.apiKey)])),
  requests,
  seats, // fourni par le hub (store.seats) : le module ne lit jamais le store lui-même
  since: from,
  stats: summary(m),
});

/** Vrai si la version a est strictement inférieure à b (X.Y.Z ; une préversion passe avant la version finale, comme côté Clevoa). */
const older = (a, b) => {
  const parse = (v) => { const [core, pre] = String(v).split("-"); return [...core.split(".").map(Number), pre ? 0 : 1]; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

/** Envoie le payload et ouvre une nouvelle période de statistiques. Renvoie le statut annoncé par Clevoa, ou null en cas d'échec. */
export async function send(connectors, seats = () => 0, installation = () => undefined) {
  if (!KEY) return null;
  const sent = stats, from = since; stats = new Map(); since = new Date().toISOString(); // les appels pendant l'envoi vont à la période suivante
  try {
    const body = payload(connectors, seats(), installation(), sent, from);
    // redirect "error" : la clé et le payload ne partent jamais vers une autre adresse que CLEVOA_URL.
    const r = await fetch(URL_, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", "X-Clevoa-Key": KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
    const data = await r.json().catch(() => ({}));
    if (r.ok) { requests = Math.max(0, requests - body.requests); lastOk = Date.now(); } // les appels comptés pendant l'envoi restent pour le prochain
    else if (r.status === 400 || r.status === 413) console.error(`[telemetry] période refusée par Clevoa (${r.status}) : statistiques abandonnées`); // les renvoyer échouerait de même
    else { restore(sent); since = from; }
    // Rien de la réponse n'est journalisé tel quel : statut court en minuscules, version X.Y.Z stricte, sinon ignorés.
    const status = typeof data.status === "string" && /^[a-z]{1,20}$/.test(data.status) ? data.status : "";
    const minimum = typeof data.minimum === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(data.minimum) ? data.minimum : null;
    console.log(`[telemetry] ${r.status} ${status} (${body.requests} requêtes)`);
    if (r.ok && minimum && older(VERSION, minimum))
      console.warn(`[telemetry] version ${VERSION} inférieure au minimum ${minimum} annoncé par Clevoa : mise à jour à planifier (docs/admin/exploitation.md)`);
    return r.ok ? status || "ok" : null;
  } catch (e) {
    restore(sent); since = from;
    console.error(`[telemetry] échec : ${e.name === "TimeoutError" ? "délai dépassé" : e.message}`);
    return null;
  }
}

const RETRY = [60_000, 300_000, 1_800_000]; // après un échec : 1 min, 5 min, 30 min, puis retour aux créneaux

/** Délai jusqu'au prochain créneau (03:00, 09:00, 15:00, 21:00 en heure locale, recalculé à chaque passage). */
export function nextSlot(now = Date.now()) {
  const d = new Date(now);
  for (let day = 0; day < 2; day++) for (const h of HOURS) {
    const c = new Date(d); c.setDate(d.getDate() + day); c.setHours(h, 0, 0, 0);
    if (c.getTime() > now) return c.getTime() - now;
  }
  return 6 * 3600_000;
}

/** Démarre : envoi immédiat, puis à chaque créneau de 6 heures. Un envoi en échec (Clevoa injoignable) est retenté à 1, 5
 *  puis 30 minutes avant de retomber sur les créneaux. Chaque attente est allongée de 0 à 10 minutes au hasard : les hubs
 *  de tous les clients n'arrivent pas à la même seconde sur le backend (débit et exécutions simultanées plafonnés). */
export function start(connectors, seats = () => 0, installation = () => undefined, spread = () => Math.floor(Math.random() * 600_000)) {
  if (!KEY) return console.log("[telemetry] désactivée (CLEVOA_KEY vide)");
  let failures = 0;
  const tick = async () => {
    failures = (await send(connectors, seats, installation)) ? 0 : failures + 1;
    setTimeout(tick, (failures && failures <= RETRY.length ? RETRY[failures - 1] : nextSlot()) + spread()).unref();
  };
  tick();
}
