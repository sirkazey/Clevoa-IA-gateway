// Backend Clevoa (AWS Lambda), deux fonctions et aucune dépendance à installer :
// - telemetry : reçoit le POST d'un hub Clevoa AI Gateway (toutes les 6 heures), vérifie la clé client, valide le payload, met à
//   jour l'état de l'installation, ajoute une ligne d'historique pour la période, et ouvre ou ferme les incidents d'erreurs ;
// - report : passage horaire planifié qui ouvre un incident « silence » pour une installation muette, renvoie un e-mail qui
//   n'a pas pu partir, et rend un rapport JSON.
// Un e-mail (sujet SNS ALERT_TOPIC_ARN) part seulement quand un incident s'ouvre ou se ferme chez un client : jamais pour une
// version ancienne ni pour un rapport sans changement. L'état retient ce qui a été annoncé (`notified`) : un e-mail en échec
// est retenté, un e-mail réussi n'est jamais renvoyé. Plafond d'e-mails par client et par heure (ALERT_MAX_PER_HOUR).
// Persistance : table DynamoDB si TELEMETRY_TABLE est renseignée (SDK AWS fourni par le runtime Lambda Node 22), mémoire de
// l'instance sinon (tests locaux, aucun accès AWS). Une partition par installation (pk « client#installation#env ») : la ligne
// d'état (sk « ETAT », attribut `etat` indexé par l'index « etats ») et une ligne par période (sk « P#<début de période> »,
// réécrite à l'identique si le hub renvoie la même période), expirées RETENTION_DAYS jours après leur écriture.
// La console de suivi (clevoa-console/) lit cette table, en lecture seule.
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_BODY = 8192; // un payload légitime fait environ 1,5 Ko avec les statistiques de cinq connecteurs
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-(alpha|beta|rc)\.\d{1,3})?$/; // aucun texte libre jusque dans les e-mails
const NAME = /^[a-z0-9_-]{1,32}$/;
const okName = (n) => NAME.test(n) && !(n in Object.prototype); // ni « __proto__ » ni « constructor »
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
  if (names.length > 20 || names.some((n) => !okName(n))) return false;
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
  if (names.length > 20 || names.some((n) => !okName(n)) || Object.values(p.connectors).some((v) => typeof v !== "boolean")) return "connectors doit être un objet de booléens";
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

/** Incidents d'erreurs après une période. Un incident s'ouvre selon errorIncidents ; un incident ouvert ne se ferme que sur
 *  preuve (assez d'appels avec un taux normal, ou un collaborateur sans refus d'authentification). Une période creuse (nuit,
 *  week-end, redémarrage) ou un hub sans statistiques le laisse ouvert : pas d'e-mails qui alternent. « silence » se ferme au contact ;
 *  un connecteur que le hub ne déclare pas configuré (retiré, ou simulateur) n'ouvre aucun incident et ferme le sien. */
export function nextIncidents(before = [], stats, connectors = {}) {
  const gone = (code) => connectors[code.split(":")[1]] !== true; // connecteur retiré ou passé sur simulateur : plus rien à surveiller
  const open = before.filter((c) => c !== "silence" && !gone(c));
  if (!stats) return open;
  const rate = num("ERROR_RATE", "0.2"), minCalls = num("ERROR_MIN_CALLS", "10");
  const healed = (code) => {
    const [kind, c] = code.split(":"), s = stats[c];
    if (!s) return false;
    return kind === "auth" ? s.users > s.authUsers : s.calls >= minCalls && systemErrors(s) / s.calls <= rate;
  };
  return [...new Set([...errorIncidents(stats).filter((c) => !gone(c)), ...open.filter((c) => !healed(c))])].sort();
}

/** Délai de silence d'une installation : SILENCE_HOURS (14 h) pour un hub qui envoie toutes les 6 heures, SILENCE_HOURS_LEGACY
 *  (50 h) pour un hub antérieur à 1.3.2-rc.2, qui n'envoie qu'une fois par jour. Partagé avec la console. */
export const silenceMs = (i) => (i.cadence === 24 ? num("SILENCE_HOURS_LEGACY", "50") : num("SILENCE_HOURS", "14")) * 3600_000;
const codes = (s) => (s ? s.split(",") : []);

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

/** Plafond d'e-mails par client et par heure : une clé divulguée ne peut pas inonder la messagerie de Clevoa. Le dernier e-mail
 *  autorisé est suivi d'un avertissement ; au-delà, l'annonce est reportée (retentée au contact ou au passage suivant). */
async function budget(db, client, now) {
  const max = num("ALERT_MAX_PER_HOUR", "10");
  try {
    const n = await db.count(`${client}#alertes`, `H#${now.toISOString().slice(0, 13)}`, Math.floor(now.getTime() / 1000) + 2 * 86400);
    return n < max ? "ok" : n === max ? "last" : "over";
  } catch (e) { console.error("[clevoa] compteur d'alertes illisible", e.name); return "ok"; }
}

/** Envoie un e-mail seulement si des incidents s'ouvrent ou se ferment. Renvoie vrai si l'annonce est faite (ou volontairement
 *  retenue par le plafond), faux si l'envoi a échoué : l'appelant ne la marque pas comme annoncée et elle sera retentée. */
async function notify(item, opened, closed, { publish, db, now = new Date() } = {}) {
  if (!opened.length && !closed.length) return true;
  const where = `${item.client} · ${item.env ?? "?"} · ${item.version} · installation ${item.installation}`;
  const subject = opened.length ? `Clevoa AI Gateway : incident chez ${item.client}` : `Clevoa AI Gateway : rétabli chez ${item.client}`;
  const back = (c) => (c === "silence" ? "le hub a repris contact"
    : item.connectors?.[c.split(":")[1]] === true ? `${label(c.split(":")[1])} fonctionne de nouveau normalement`
    : `${label(c.split(":")[1])} n'est plus déclaré configuré (connecteur retiré ou simulateur), plus surveillé`);
  const lines = [where, "", ...opened.map((c) => `Nouvel incident : ${describe(c, item)}`), ...closed.map((c) => `Rétabli : ${back(c)}`)];
  console.log("[clevoa] ALERTE", JSON.stringify({ pk: item.pk, opened, closed }));
  if (!process.env.ALERT_TOPIC_ARN && !publish) return true;
  const quota = await budget(db, item.client, now);
  if (quota === "over") { console.warn("[clevoa] e-mail reporté : plafond horaire atteint", JSON.stringify({ pk: item.pk })); return false; }
  const send = publish ?? (async (subj, message) => {
    const sns = await import("@aws-sdk/client-sns"); // fourni par le runtime Lambda Node 22
    await new sns.SNSClient({}).send(new sns.PublishCommand({ TopicArn: process.env.ALERT_TOPIC_ARN, Subject: subj, Message: message }));
  });
  try { await send(subject, lines.join("\n")); }
  catch (e) { console.error("[clevoa] échec de l'alerte SNS", e.name); return false; }
  if (quota === "last") await send(`Clevoa AI Gateway : trop d'alertes chez ${item.client}`, `${num("ALERT_MAX_PER_HOUR", "10")} e-mails d'incident en une heure pour ${item.client} : les suivants sont reportés à l'heure suivante (journaux CloudWatch et console). Volume anormal : retirer la clé du client de CLEVOA_KEYS.`)
    .catch((e) => console.error("[clevoa] échec de l'avertissement SNS", e.name)); // l'incident, lui, est bien annoncé
  return true;
}

// ---------- Persistance ----------
/** Stockage en mémoire de l'instance (tests et usage local) : même interface que DynamoDB. */
export function memoryStore() {
  const items = new Map(); const k = (pk, sk) => `${pk}|${sk}`;
  return {
    async get(pk) { return items.get(k(pk, STATE)) ?? null; },
    async put(item) { const prev = items.get(k(item.pk, item.sk)); items.set(k(item.pk, item.sk), item.sk === STATE ? { ...item, firstSeen: prev?.firstSeen ?? item.firstSeen ?? item.lastSeen } : item); },
    async list() { return [...items.values()].filter((i) => i.sk === STATE); },
    async putState(item, expect, force) {
      const it = items.get(k(item.pk, STATE));
      if (!force && (expect ? !it || it.lastSeen !== expect.lastSeen || it.notified !== expect.notified : !!it)) return false;
      await this.put(item); return true;
    },
    async count(pk, sk) { const it = items.get(k(pk, sk)) ?? { pk, sk, n: 0 }; it.n++; items.set(k(pk, sk), it); return it.n; },
    /** Mise à jour conditionnelle de l'état : seulement si ni un contact ni un autre passage ne l'a changé depuis la lecture. */
    async claim(pk, expect, fields) {
      const it = items.get(k(pk, STATE));
      if (!it || it.lastSeen !== expect.lastSeen || it.notified !== expect.notified) return false;
      items.set(k(pk, STATE), { ...it, ...fields }); return true;
    },
    async history(pk, from = "") { return [...items.values()].filter((i) => i.pk === pk && i.sk.startsWith("P#") && i.sk >= `P#${from}`).sort((a, b) => (a.sk < b.sk ? -1 : 1)); },
  };
}

// Conversion minimale vers le format DynamoDB : chaînes, nombres, booléens, tableaux et objets.
const toAttr = (v) => (typeof v === "string" ? { S: v } : typeof v === "number" ? { N: String(v) } : typeof v === "boolean" ? { BOOL: v }
  : v === null || v === undefined ? { NULL: true } : Array.isArray(v) ? { L: v.map(toAttr) } : { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toAttr(x)])) });
export const fromAttr = (a) => ("S" in a ? a.S : "N" in a ? Number(a.N) : "BOOL" in a ? a.BOOL : "NULL" in a ? null : "L" in a ? a.L.map(fromAttr)
  : Object.fromEntries(Object.entries(a.M).map(([k, x]) => [k, fromAttr(x)])));
const fromItem = (it) => fromAttr({ M: it });

/** Stockage DynamoDB (clé pk + sk). La ligne d'état garde son premier contact ; les lignes d'état sont listées par l'index
 *  creux « etats » (sans lire l'historique). Le second argument reçoit les classes de commandes du SDK ; la console n'utilise
 *  que get, list et history (lecture seule). */
export function dynamoStore(table, { client, UpdateItemCommand, QueryCommand, GetItemCommand }) {
  const queryAll = async (input) => { const out = []; let ExclusiveStartKey;
    do { const r = await client.send(new QueryCommand({ ...input, ExclusiveStartKey })); for (const it of r.Items || []) out.push(fromItem(it)); ExclusiveStartKey = r.LastEvaluatedKey; } while (ExclusiveStartKey);
    return out; };
  const store = {
    async get(pk) { const r = await client.send(new GetItemCommand({ TableName: table, Key: { pk: { S: pk }, sk: { S: STATE } } })); return r.Item ? fromItem(r.Item) : null; },
    /** Écrit une ligne. `condition` (ligne d'état) : expression et valeurs exigées sur la ligne existante. */
    async put(item, condition) {
      const { pk, sk, firstSeen, ...fields } = item; // firstSeen n'est jamais réécrit : il est posé une fois par if_not_exists
      const names = Object.keys(fields);
      const keepFirst = sk === STATE ? ", #first = if_not_exists(#first, :now)" : "";
      await client.send(new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: pk }, sk: { S: sk } },
        UpdateExpression: `SET ${names.map((n, i) => `#f${i} = :v${i}`).join(", ")}${keepFirst}`,
        ExpressionAttributeNames: { ...Object.fromEntries(names.map((n, i) => [`#f${i}`, n])), ...(keepFirst ? { "#first": "firstSeen" } : {}) },
        ExpressionAttributeValues: { ...Object.fromEntries(names.map((n, i) => [`:v${i}`, toAttr(fields[n])])), ...(keepFirst ? { ":now": { S: firstSeen ?? item.lastSeen } } : {}), ...(condition?.values ?? {}) },
        ...(condition ? { ConditionExpression: condition.expression } : {}),
      }));
    },
    async putState(item, expect, force) {
      if (force) { await store.put(item); return true; }
      const told = expect?.notified === undefined ? "attribute_not_exists(notified)" : "notified = :told";
      const condition = expect ? { expression: `lastSeen = :seen AND ${told}`, values: { ":seen": { S: expect.lastSeen }, ...(expect.notified === undefined ? {} : { ":told": { S: expect.notified } }) } }
        : { expression: "attribute_not_exists(pk)", values: {} };
      try { await store.put(item, condition); return true; }
      catch (e) { if (e.name === "ConditionalCheckFailedException") return false; throw e; }
    },
    list: () => queryAll({ TableName: table, IndexName: "etats", KeyConditionExpression: "etat = :e", ExpressionAttributeValues: { ":e": { S: STATE } } }),
    history: (pk, from = "") => queryAll({ TableName: table, KeyConditionExpression: "pk = :p AND sk BETWEEN :a AND :b",
      ExpressionAttributeValues: { ":p": { S: pk }, ":a": { S: `P#${from}` }, ":b": { S: "P#~" } } }),
    async count(pk, sk, expiresAt) {
      const r = await client.send(new UpdateItemCommand({ TableName: table, Key: { pk: { S: pk }, sk: { S: sk } }, UpdateExpression: "ADD #n :one SET expiresAt = :t",
        ExpressionAttributeNames: { "#n": "n" }, ExpressionAttributeValues: { ":one": { N: "1" }, ":t": { N: String(expiresAt) } }, ReturnValues: "UPDATED_NEW" }));
      return Number(r.Attributes.n.N);
    },
    async claim(pk, expect, fields) {
      const names = Object.keys(fields);
      try {
        await client.send(new UpdateItemCommand({
          TableName: table, Key: { pk: { S: pk }, sk: { S: STATE } },
          UpdateExpression: `SET ${names.map((n, i) => `#f${i} = :v${i}`).join(", ")}`,
          ConditionExpression: `#seen = :seen AND ${expect.notified === undefined ? "attribute_not_exists(#told)" : "#told = :told"}`,
          ExpressionAttributeNames: { ...Object.fromEntries(names.map((n, i) => [`#f${i}`, n])), "#seen": "lastSeen", "#told": "notified" },
          ExpressionAttributeValues: { ...Object.fromEntries(names.map((n, i) => [`:v${i}`, toAttr(fields[n])])), ":seen": { S: expect.lastSeen },
            ...(expect.notified === undefined ? {} : { ":told": { S: expect.notified } }) },
        }));
        return true;
      } catch (e) { if (e.name === "ConditionalCheckFailedException") return false; throw e; }
    },
  };
  return store;
}

let current = null;
/** Stockage courant : injecté par les tests, DynamoDB si TELEMETRY_TABLE est renseignée, mémoire sinon. */
async function store() {
  if (current) return current;
  if (!process.env.TELEMETRY_TABLE) return (current = memoryStore());
  const sdk = await import("@aws-sdk/client-dynamodb"); // fourni par le runtime Lambda Node 22 : rien à empaqueter
  return (current = dynamoStore(process.env.TELEMETRY_TABLE, { client: new sdk.DynamoDBClient({}), UpdateItemCommand: sdk.UpdateItemCommand, QueryCommand: sdk.QueryCommand, GetItemCommand: sdk.GetItemCommand }));
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
  let db;
  try {
    db = await store();
    // Clé de période = début de période : un envoi répété (réponse perdue, le hub renvoie la même période) réécrit la même ligne.
    await db.put({ pk, sk: `P#${p.since ?? seen}`, at: seen, since: p.since ?? null, version: p.version, requests: p.requests, seats: p.seats ?? null, stats: p.stats ?? null, expiresAt });
  } catch (e) { console.error("[clevoa] échec d'enregistrement", e.name); return reply(500, { status: "error", error: "enregistrement impossible" }); }
  // État écrit à condition qu'il n'ait pas changé depuis sa lecture (passage horaire simultané) ; sinon relu et recalculé une fois,
  // sans annoncer de nouveau ce qui vient de l'être.
  const sent = new Set();
  let incidents = [], item;
  for (let attempt = 0; ; attempt++) {
    let prev;
    try { prev = await db.get(pk); }
    catch (e) { console.error("[clevoa] échec de lecture", e.name); return reply(500, { status: "error", error: "enregistrement impossible" }); }
    const before = prev?.incidents ?? [];
    const told = prev ? prev.notified ?? before.join(",") : ""; // incidents déjà annoncés par e-mail
    incidents = nextIncidents(before, p.stats, p.connectors);
    item = {
      pk, sk: STATE, etat: STATE, client, installation, version: p.version, env: p.env ?? null, connectors: p.connectors, requests: p.requests,
      seats: p.seats ?? null, reportedDate: p.date ?? null, lastSeen: seen, expiresAt, incidents, lastStats: p.stats ?? null,
      cadence: p.stats ? 6 : 24, // hub antérieur à 1.3.2-rc.2 : un envoi par jour
    };
    const opened = incidents.filter((c) => !codes(told).includes(c) && !sent.has(`+${c}`)), closed = codes(told).filter((c) => !incidents.includes(c) && !sent.has(`-${c}`));
    const announced = await notify(item, opened, closed, { publish, db, now });
    if (announced) { for (const c of opened) sent.add(`+${c}`); for (const c of closed) sent.add(`-${c}`); }
    item.notified = announced ? incidents.join(",") : told; // e-mail en échec : retenté au prochain contact ou au passage horaire
    let written;
    try { written = await db.putState(item, prev ? { lastSeen: prev.lastSeen, notified: prev.notified } : null, attempt > 0); }
    catch (e) { console.error("[clevoa] échec d'enregistrement", e.name); return reply(500, { status: "error", error: "enregistrement impossible" }); }
    if (written) break;
  }
  console.log("[clevoa] contact", JSON.stringify({ pk, version: item.version, env: item.env, requests: item.requests, seats: item.seats, incidents }));

  const body = { status: "active", recorded: seen };
  if (process.env.MIN_VERSION) body.minimum = process.env.MIN_VERSION; // le hub signale dans ses journaux une version sous le minimum
  if (process.env.LATEST_VERSION) body.latest = process.env.LATEST_VERSION;
  return reply(200, body);
}

// ---------- Fonction « report » (planifiée chaque heure) ----------
/** Ouvre l'incident « silence » d'une installation muette (14 h, ou 50 h pour un hub qui n'envoie qu'une fois par jour) ;
 *  au-delà de SILENCE_MAX_DAYS jours (30), l'installation est « perdue » : listée, sans alerte. Renvoie aussi un e-mail qui
 *  n'avait pas pu partir. Chaque changement est une mise à jour conditionnelle : un contact du hub ou un second passage
 *  simultané l'emporte, sans double e-mail ni état écrasé. Les versions sous MIN_VERSION sont listées sans e-mail. */
export async function report(_event = {}, { now = Date.now(), publish } = {}) {
  const db = await store();
  const items = await db.list();
  const lostMs = num("SILENCE_MAX_DAYS", "30") * 86400_000;
  const min = process.env.MIN_VERSION;
  const age = (i) => now - Date.parse(i.lastSeen);
  const row = (i) => ({ pk: i.pk, client: i.client, env: i.env, version: i.version, lastSeen: i.lastSeen, incidents: i.incidents ?? [] });
  const live = items.filter((i) => age(i) <= lostMs);
  const silent = live.filter((i) => age(i) > silenceMs(i));
  const result = {
    generatedAt: new Date(now).toISOString(), total: items.length,
    silent: silent.map(row), lost: items.filter((i) => age(i) > lostMs).map(row),
    outdated: min ? live.filter((i) => compareVersions(i.version, min) < 0).map(row) : [],
    incidents: items.filter((i) => (i.incidents ?? []).length).map(row),
  };
  let failed = 0;
  for (const i of live) {
    const was = i.incidents ?? [], told = i.notified ?? was.join(",");
    const incidents = silent.includes(i) && !was.includes("silence") ? [...was, "silence"].sort() : was;
    const target = incidents.join(",");
    if (target === told && incidents === was) continue;
    if (!(await db.claim(i.pk, { lastSeen: i.lastSeen, notified: i.notified }, { incidents, notified: target }))) continue; // déjà traité ailleurs
    const updated = { ...i, incidents, notified: target };
    if (!(await notify(updated, incidents.filter((c) => !codes(told).includes(c)), codes(told).filter((c) => !incidents.includes(c)), { publish, db, now: new Date(now) }))) {
      failed++;
      await db.claim(i.pk, { lastSeen: i.lastSeen, notified: target }, { notified: told }).catch(() => {}); // retenté au prochain passage
    }
  }
  if (failed) result.alertErrors = failed;
  console.log("[clevoa] rapport", JSON.stringify({ total: result.total, silent: result.silent.length, lost: result.lost.length, outdated: result.outdated.length, incidents: result.incidents.length }));
  return result;
}
