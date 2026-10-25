// Backend Clevoa (AWS Lambda), deux fonctions et aucune dépendance à installer :
// - telemetry : reçoit le POST d'un hub Clevoa AI Gateway (toutes les 6 heures), vérifie la clé client, valide le payload, met à
//   jour l'état de l'installation, ajoute une ligne d'historique pour la période, et ouvre ou ferme les incidents d'erreurs ;
// - report : passage horaire planifié qui ouvre un incident « silence » pour une installation muette, et rend un rapport JSON.
// Un e-mail (sujet SNS ALERT_TOPIC_ARN) part seulement quand un incident s'ouvre ou se ferme chez un client : jamais pour une
// version ancienne ni pour un rapport sans changement.
// Persistance : table DynamoDB si TELEMETRY_TABLE est renseignée (SDK AWS fourni par le runtime Lambda Node 22), mémoire de
// l'instance sinon (tests locaux, aucun accès AWS). Une partition par installation (pk « client#installation#env ») : la ligne
// d'état (sk « ETAT ») et une ligne par période (sk « P#<horodatage> »), expirées RETENTION_DAYS jours après leur écriture.
// La console de suivi (clevoa-console/) lit cette table, en lecture seule.
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_BODY = 8192; // un payload légitime fait environ 1,5 Ko avec les statistiques de cinq connecteurs
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,20})?$/;
const NAME = /^[a-z0-9_-]{1,32}$/;
export const ERROR_TYPES = ["auth", "quota", "timeout", "unreachable", "other", "user"];
export const STATE = "ETAT";
const env = (n, d) => process.env[n] || d;
const num = (n, d) => Number(process.env[n] || d);
const hash = (s) => createHash("sha256").update(s).digest();

/** Clés clients acceptées : CLEVOA_KEYS = « client=clé » séparées par des virgules (nom : lettres minuscules, chiffres, tirets).
 *  Une entrée sans nom est ignorée. Liste vide = AUCUNE clé acceptée. Seul le nom du client est enregistré, jamais la clé. */
function clients() {
  return (process.env.CLEVOA_KEYS || "").split(",").map((e) => e.trim()).filter(Boolean).flatMap((e) => {
    const i = e.indexOf("=");
    const name = e.slice(0, Math.max(i, 0)).trim(), key = e.slice(i + 1).trim();
    if (i <= 0 || !/^[a-z0-9-]{1,40}$/.test(name) || !key) { console.error("[clevoa] entrée de CLEVOA_KEYS ignorée : format client=clé attendu"); return []; }
    return [{ client: name, digest: hash(key) }];
  });
}
/** Client correspondant à la clé présentée (comparaison à temps constant sur les empreintes), ou null. */
function identify(key, list) {
  if (typeof key !== "string" || !key) return null;
  const d = hash(key);
  let found = null;
  for (const c of list) if (timingSafeEqual(c.digest, d)) found = c.client;
  return found;
}

const reply = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const int = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

/** Statistiques d'un connecteur : uniquement des entiers bornés, rien d'autre. */
function validStats(stats) {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return false;
  const names = Object.keys(stats);
  if (names.length > 20 || names.some((n) => !NAME.test(n))) return false;
  return Object.values(stats).every((s) => s && typeof s === "object" && !Array.isArray(s)
    && Object.keys(s).sort().join() === "authUsers,calls,errors,p50,p95,users"
    && int(s.calls, 1e8) && int(s.users, 1e6) && int(s.authUsers, s.users) && int(s.p50, 600_000) && int(s.p95, 600_000)
    && s.errors && typeof s.errors === "object" && !Array.isArray(s.errors) && Object.keys(s.errors).sort().join() === [...ERROR_TYPES].sort().join()
    && ERROR_TYPES.every((t) => int(s.errors[t], s.calls)));
}

/** Valide le payload : champs connus seulement, types et bornes stricts. Renvoie un message d'erreur ou null. */
export function validate(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "payload JSON attendu";
  const allowed = ["installation", "version", "env", "date", "connectors", "requests", "seats", "since", "stats"];
  const extra = Object.keys(p).filter((k) => !allowed.includes(k));
  if (extra.length) return `champs non autorisés : ${extra.join(", ")}`; // garde-fou : rien d'autre ne doit arriver ici
  if (p.installation !== undefined && (typeof p.installation !== "string" || !UUID.test(p.installation))) return "installation : UUID v4 attendu"; // optionnel : hubs antérieurs à 1.3.2
  if (typeof p.version !== "string" || !SEMVER.test(p.version)) return "version : X.Y.Z attendu";
  if (p.env !== undefined && !["PRODUCTION", "PRE-PROD"].includes(p.env)) return "env : PRODUCTION ou PRE-PROD";
  if (p.date !== undefined && (typeof p.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.date))) return "date : AAAA-MM-JJ attendu";
  if (!p.connectors || typeof p.connectors !== "object" || Array.isArray(p.connectors)) return "connectors doit être un objet de booléens";
  const names = Object.keys(p.connectors);
  if (names.length > 20 || names.some((n) => !NAME.test(n)) || Object.values(p.connectors).some((v) => typeof v !== "boolean")) return "connectors doit être un objet de booléens";
  if (!int(p.requests, 1e9)) return "requests doit être un entier positif";
  if (p.seats !== undefined && !int(p.seats, 1e6)) return "seats doit être un entier positif"; // optionnel : hubs antérieurs à 1.2
  if (p.since !== undefined && (typeof p.since !== "string" || p.since.length > 30 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(p.since))) return "since : date ISO attendue"; // optionnels : hubs antérieurs à 1.3.2-rc.2
  if (p.stats !== undefined && !validStats(p.stats)) return "stats : statistiques par connecteur invalides";
  return null;
}

/** Compare deux versions X.Y.Z (une préversion passe avant la version finale). */
export function compareVersions(a, b) {
  const parse = (v) => { const [core, pre] = String(v).split("-"); return [...core.split(".").map(Number), pre ? 0 : 1]; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

// ---------- Incidents ----------
const LABELS = { salesforce: "Salesforce", sagex3: "Sage X3", sharepoint: "SharePoint", dropbox: "Dropbox", myreport: "MyReport" };
const TYPE_LABELS = { auth: "authentification", quota: "quota", timeout: "délai dépassé", unreachable: "injoignable", other: "autre" };
const label = (c) => LABELS[c] ?? c;
const systemErrors = (s) => ERROR_TYPES.filter((t) => t !== "user").reduce((n, t) => n + s.errors[t], 0); // erreurs d'usage exclues

/** Incidents d'erreurs d'une période : taux d'erreur du système au-delà du seuil (avec assez d'appels), ou authentification
 *  refusée pour tous les collaborateurs qui ont utilisé le connecteur (application OAuth ou secret expiré côté client). */
export function errorIncidents(stats = {}) {
  const rate = num("ERROR_RATE", "0.2"), minCalls = num("ERROR_MIN_CALLS", "10"), minUsers = num("AUTH_MIN_USERS", "2");
  const out = [];
  for (const [c, s] of Object.entries(stats)) {
    if (s.authUsers >= minUsers && s.authUsers === s.users) out.push(`auth:${c}`);
    else if (s.calls >= minCalls && systemErrors(s) / s.calls > rate) out.push(`erreurs:${c}`);
  }
  return out.sort();
}

/** Phrase lisible d'un incident, pour l'e-mail et la console. */
export function describe(code, item = {}) {
  if (code === "silence") return `aucun contact depuis le ${item.lastSeen ?? "?"} (hub arrêté, flux sortant bloqué ou clé retirée)`;
  const [kind, c] = code.split(":");
  const s = item.lastStats?.[c];
  if (!s) return `${label(c)} : ${kind === "auth" ? "authentification refusée" : "taux d'erreur élevé"}`;
  if (kind === "auth") return `${label(c)} : authentification refusée pour tous les collaborateurs (${s.authUsers}) : application OAuth, secret ou mot de passe à vérifier chez le client`;
  const detail = ERROR_TYPES.filter((t) => t !== "user" && s.errors[t]).map((t) => `${TYPE_LABELS[t]} ${s.errors[t]}`).join(", ");
  return `${label(c)} : ${Math.round((100 * systemErrors(s)) / s.calls)} % d'erreurs sur la période (${systemErrors(s)} sur ${s.calls} appels : ${detail})`;
}

/** Envoie un e-mail seulement si des incidents s'ouvrent ou se ferment ; une erreur d'envoi n'interrompt jamais la fonction. */
async function notify(item, opened, closed, publish) {
  if (!opened.length && !closed.length) return null;
  const where = `${item.client} · ${item.env ?? "?"} · ${item.version} · installation ${item.installation}`;
  const subject = opened.length ? `Clevoa AI Gateway : incident chez ${item.client}` : `Clevoa AI Gateway : rétabli chez ${item.client}`;
  const back = (c) => (c === "silence" ? "le hub a repris contact" : `${label(c.split(":")[1])} fonctionne de nouveau normalement`);
  const lines = [where, "", ...opened.map((c) => `Nouvel incident : ${describe(c, item)}`), ...closed.map((c) => `Rétabli : ${back(c)}`)];
  console.log("[clevoa] ALERTE", JSON.stringify({ pk: item.pk, opened, closed }));
  if (!process.env.ALERT_TOPIC_ARN && !publish) return null;
  const send = publish ?? (async (subj, message) => {
    const sns = await import("@aws-sdk/client-sns"); // fourni par le runtime Lambda Node 22
    await new sns.SNSClient({}).send(new sns.PublishCommand({ TopicArn: process.env.ALERT_TOPIC_ARN, Subject: subj, Message: message }));
  });
  try { await send(subject, lines.join("\n")); return null; }
  catch (e) { console.error("[clevoa] échec de l'alerte SNS", e.name); return e.name; }
}

// ---------- Persistance ----------
/** Stockage en mémoire de l'instance (tests et usage local) : même interface que DynamoDB. */
export function memoryStore() {
  const items = new Map(); const k = (pk, sk) => `${pk}|${sk}`;
  return {
    async get(pk) { return items.get(k(pk, STATE)) ?? null; },
    async put(item) { const prev = items.get(k(item.pk, item.sk)); items.set(k(item.pk, item.sk), item.sk === STATE ? { ...item, firstSeen: prev?.firstSeen ?? item.firstSeen ?? item.lastSeen } : item); },
    async list() { return [...items.values()].filter((i) => i.sk === STATE); },
    async history(pk, from = "") { return [...items.values()].filter((i) => i.pk === pk && i.sk.startsWith("P#") && i.sk >= `P#${from}`).sort((a, b) => (a.sk < b.sk ? -1 : 1)); },
  };
}

// Conversion minimale vers le format DynamoDB : chaînes, nombres, booléens, tableaux et objets.
const toAttr = (v) => (typeof v === "string" ? { S: v } : typeof v === "number" ? { N: String(v) } : typeof v === "boolean" ? { BOOL: v }
  : v === null || v === undefined ? { NULL: true } : Array.isArray(v) ? { L: v.map(toAttr) } : { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toAttr(x)])) });
export const fromAttr = (a) => ("S" in a ? a.S : "N" in a ? Number(a.N) : "BOOL" in a ? a.BOOL : "NULL" in a ? null : "L" in a ? a.L.map(fromAttr)
  : Object.fromEntries(Object.entries(a.M).map(([k, x]) => [k, fromAttr(x)])));
const fromItem = (it) => fromAttr({ M: it });

/** Stockage DynamoDB (clé pk + sk). La ligne d'état garde son premier contact ; les lignes de période sont écrites une fois.
 *  `cmds` reçoit les classes de commandes du SDK ; la console n'utilise que get, list et history (lecture seule). */
export function dynamoStore(table, { client, UpdateItemCommand, ScanCommand, QueryCommand, GetItemCommand }) {
  const scanAll = async (input) => { const out = []; let ExclusiveStartKey;
    do { const r = await client.send(new ScanCommand({ ...input, ExclusiveStartKey })); for (const it of r.Items || []) out.push(fromItem(it)); ExclusiveStartKey = r.LastEvaluatedKey; } while (ExclusiveStartKey);
    return out; };
  return {
    async get(pk) { const r = await client.send(new GetItemCommand({ TableName: table, Key: { pk: { S: pk }, sk: { S: STATE } } })); return r.Item ? fromItem(r.Item) : null; },
    async put(item) {
      const { pk, sk, firstSeen, ...fields } = item; // firstSeen n'est jamais réécrit : il est posé une fois par if_not_exists
      const names = Object.keys(fields);
      const keepFirst = sk === STATE ? ", #first = if_not_exists(#first, :now)" : "";
      await client.send(new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: pk }, sk: { S: sk } },
        UpdateExpression: `SET ${names.map((n, i) => `#f${i} = :v${i}`).join(", ")}${keepFirst}`,
        ExpressionAttributeNames: { ...Object.fromEntries(names.map((n, i) => [`#f${i}`, n])), ...(keepFirst ? { "#first": "firstSeen" } : {}) },
        ExpressionAttributeValues: { ...Object.fromEntries(names.map((n, i) => [`:v${i}`, toAttr(fields[n])])), ...(keepFirst ? { ":now": { S: firstSeen ?? item.lastSeen } } : {}) },
      }));
    },
    list: () => scanAll({ TableName: table, FilterExpression: "sk = :e", ExpressionAttributeValues: { ":e": { S: STATE } } }),
    async history(pk, from = "") {
      const out = []; let ExclusiveStartKey;
      do {
        const r = await client.send(new QueryCommand({ TableName: table, KeyConditionExpression: "pk = :p AND sk BETWEEN :a AND :b",
          ExpressionAttributeValues: { ":p": { S: pk }, ":a": { S: `P#${from}` }, ":b": { S: "P#~" } }, ExclusiveStartKey }));
        for (const it of r.Items || []) out.push(fromItem(it)); ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
  };
}

let current = null;
/** Stockage courant : injecté par les tests, DynamoDB si TELEMETRY_TABLE est renseignée, mémoire sinon. */
async function store() {
  if (current) return current;
  if (!process.env.TELEMETRY_TABLE) return (current = memoryStore());
  const sdk = await import("@aws-sdk/client-dynamodb"); // fourni par le runtime Lambda Node 22 : rien à empaqueter
  return (current = dynamoStore(process.env.TELEMETRY_TABLE, { client: new sdk.DynamoDBClient({}), UpdateItemCommand: sdk.UpdateItemCommand, ScanCommand: sdk.ScanCommand, QueryCommand: sdk.QueryCommand, GetItemCommand: sdk.GetItemCommand }));
}
export const setStore = (s) => { current = s; };

// ---------- Fonction « telemetry » (POST /api/v1/telemetry) ----------
export async function telemetry(event, { publish } = {}) {
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const list = clients();
  if (!list.length) { console.error("[clevoa] CLEVOA_KEYS vide : aucune clé acceptée"); return reply(503, { status: "unavailable" }); } // fermé par défaut, sans détail pour l'appelant
  const client = identify(headers["x-clevoa-key"], list);
  if (!client) return reply(401, { status: "unauthorized", error: "clé client absente ou inconnue" });

  if ((event.body || "").length > MAX_BODY * 2) return reply(413, { status: "invalid", error: "payload trop volumineux" }); // avant tout décodage
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : event.body || "";
  if (Buffer.byteLength(raw) > MAX_BODY) return reply(413, { status: "invalid", error: "payload trop volumineux" });
  let p;
  try { p = JSON.parse(raw); } catch { return reply(400, { status: "invalid", error: "JSON invalide" }); }
  const err = validate(p);
  if (err) return reply(400, { status: "invalid", error: err });

  const now = new Date(), seen = now.toISOString();
  const expiresAt = Math.floor(now.getTime() / 1000) + num("RETENTION_DAYS", "400") * 86400; // TTL DynamoDB (secondes)
  // Partition « client#installation#environnement » : une autre clé ne peut ni la lire ni l'écraser, et une pré-production
  // restaurée depuis une sauvegarde de production (même identifiant) garde sa propre partition.
  const installation = p.installation ?? "ancienne"; // hubs antérieurs à 1.3.2 : une partition par client et environnement
  const pk = `${client}#${installation}#${p.env ?? "inconnu"}`;
  let db, prev;
  try { db = await store(); prev = await db.get(pk); }
  catch (e) { console.error("[clevoa] échec de lecture", e.name); return reply(500, { status: "error", error: "enregistrement impossible" }); }
  const before = prev?.incidents ?? [];
  // Les statistiques décident des incidents d'erreurs ; un hub sans statistiques (antérieur à 1.3.2-rc.2) garde les siens.
  const errors = p.stats ? errorIncidents(p.stats) : before.filter((c) => c !== "silence");
  const item = {
    pk, sk: STATE, client, installation, version: p.version, env: p.env ?? null, connectors: p.connectors, requests: p.requests,
    seats: p.seats ?? null, reportedDate: p.date ?? null, lastSeen: seen, expiresAt, incidents: errors, lastStats: p.stats ?? null,
  };
  try {
    await db.put(item);
    await db.put({ pk, sk: `P#${seen}`, since: p.since ?? null, version: p.version, requests: p.requests, seats: p.seats ?? null, stats: p.stats ?? null, expiresAt });
  } catch (e) { console.error("[clevoa] échec d'enregistrement", e.name); return reply(500, { status: "error", error: "enregistrement impossible" }); }
  console.log("[clevoa] contact", JSON.stringify({ pk, version: item.version, env: item.env, requests: item.requests, seats: item.seats, incidents: errors }));
  await notify(item, errors.filter((c) => !before.includes(c)), before.filter((c) => !errors.includes(c)), publish); // « silence » se ferme au premier contact

  const body = { status: "active", recorded: seen };
  if (process.env.MIN_VERSION) body.minimum = process.env.MIN_VERSION; // le hub signale dans ses journaux une version sous le minimum
  if (process.env.LATEST_VERSION) body.latest = process.env.LATEST_VERSION;
  return reply(200, body);
}

// ---------- Fonction « report » (planifiée chaque heure) ----------
/** Ouvre l'incident « silence » d'une installation muette depuis SILENCE_HOURS heures (14 par défaut : deux envois de 6 h
 *  manqués) ; au-delà de SILENCE_MAX_DAYS jours (30), l'installation est « perdue » : listée, sans alerte. Les versions sous
 *  MIN_VERSION sont listées sans e-mail. Renvoie le rapport (invocation à la demande : serverless invoke -f report). */
export async function report(_event = {}, { now = Date.now(), publish } = {}) {
  const db = await store();
  const items = await db.list();
  const silenceMs = num("SILENCE_HOURS", "14") * 3600_000, lostMs = num("SILENCE_MAX_DAYS", "30") * 86400_000;
  const min = process.env.MIN_VERSION;
  const age = (i) => now - Date.parse(i.lastSeen);
  const row = (i) => ({ pk: i.pk, client: i.client, env: i.env, version: i.version, lastSeen: i.lastSeen, incidents: i.incidents ?? [] });
  const silent = items.filter((i) => age(i) > silenceMs && age(i) <= lostMs);
  const result = {
    generatedAt: new Date(now).toISOString(), total: items.length,
    silent: silent.map(row), lost: items.filter((i) => age(i) > lostMs).map(row),
    outdated: min ? items.filter((i) => age(i) <= lostMs && compareVersions(i.version, min) < 0).map(row) : [],
    incidents: items.filter((i) => (i.incidents ?? []).length).map(row),
  };
  const errors = [];
  for (const i of silent.filter((x) => !(x.incidents ?? []).includes("silence"))) {
    const updated = { ...i, incidents: [...(i.incidents ?? []), "silence"].sort() };
    await db.put(updated);
    const e = await notify(updated, ["silence"], [], publish);
    if (e) errors.push(e);
  }
  if (errors.length) result.alertErrors = errors;
  console.log("[clevoa] rapport", JSON.stringify({ total: result.total, silent: result.silent.length, lost: result.lost.length, outdated: result.outdated.length, incidents: result.incidents.length }));
  return result;
}
