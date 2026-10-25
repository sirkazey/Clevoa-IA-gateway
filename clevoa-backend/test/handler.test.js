// Backend Clevoa exécuté localement, sans AWS : événements API Gateway simulés, stockage en mémoire, e-mails interceptés, et
// adaptateur DynamoDB vérifié contre un faux client (forme exacte des requêtes UpdateItem, GetItem et Query).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { telemetry, report, validate, compareVersions, memoryStore, dynamoStore, setStore, errorIncidents, nextIncidents, describe, STATE } from "../handler.js";

const ID_A = "3f1c2a4e-8b7d-4c1e-9a2b-5d6e7f8a9b0c";
const ID_B = "9b8a7f6e-5d4c-4b3a-8a1b-0c9d8e7f6a5b";
const PK_A = `charlois#${ID_A}#PRODUCTION`;
const zero = { auth: 0, quota: 0, timeout: 0, unreachable: 0, other: 0, user: 0 };
const st = (calls, errors = {}, extra = {}) => ({ calls, errors: { ...zero, ...errors }, users: 3, authUsers: 0, p50: 120, p95: 900, ...extra });
const ok = { installation: ID_A, version: "1.3.2", env: "PRODUCTION", date: "2026-10-24", connectors: { salesforce: true, sagex3: true, myreport: false }, requests: 42, seats: 3 };
const rc2 = { ...ok, since: "2026-10-24T03:00:00.000Z", stats: {} }; // hub 1.3.2-rc.2 : envoi toutes les 6 h, même sans appel
const ev = (body, key = "cle-charlois") => ({ headers: key ? { "X-Clevoa-Key": key, "content-type": "application/json" } : {}, body: typeof body === "string" ? body : JSON.stringify(body) });
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });
let db, mails;
const publish = async (subject, message) => { mails.push({ subject, message }); };
const send = (body, key) => telemetry(ev(body, key), { publish });

beforeEach(() => {
  process.env.CLEVOA_KEYS = "charlois=cle-charlois, autre=cle-autre, cle-sans-nom, troisieme=cle-troisieme";
  for (const n of ["MIN_VERSION", "LATEST_VERSION", "SILENCE_HOURS", "SILENCE_MAX_DAYS", "RETENTION_DAYS", "ALERT_TOPIC_ARN", "TELEMETRY_TABLE", "ERROR_RATE", "ERROR_MIN_CALLS", "AUTH_MIN_USERS", "SILENCE_HOURS_LEGACY", "ALERT_MAX_PER_HOUR"]) delete process.env[n];
  db = memoryStore(); setStore(db); mails = [];
});

test("Fermé par défaut : CLEVOA_KEYS vide → 503 sans détail, rien n'est enregistré", async () => {
  process.env.CLEVOA_KEYS = "";
  const r = parse(await send(ok));
  assert.equal(r.status, 503); assert.equal(r.body.status, "unavailable"); assert.equal(r.body.error, undefined);
  assert.equal((await db.list()).length, 0);
});

test("Clé absente, inconnue ou sans nom de client → 401, rien n'est enregistré", async () => {
  assert.equal((await send(ok, null)).statusCode, 401);
  assert.equal((await send(ok, "cle-inconnue")).statusCode, 401);
  assert.equal((await send(ok, "cle-charloi")).statusCode, 401, "préfixe d'une clé valide refusé");
  assert.equal((await send(ok, "cle-sans-nom")).statusCode, 401, "entrée sans nom de client ignorée");
  assert.equal((await db.list()).length, 0);
});

test("Envoi valide : état de l'installation et ligne de période persistés, sans la clé ; aucun e-mail", async () => {
  const r = parse(await send({ ...ok, since: "2026-10-24T03:00:00.000Z", stats: { salesforce: st(40) } }));
  assert.equal(r.status, 200); assert.equal(r.body.status, "active"); assert.ok(r.body.recorded);
  const [it] = await db.list();
  assert.equal(it.pk, PK_A); assert.equal(it.sk, STATE);
  assert.deepEqual({ client: it.client, version: it.version, env: it.env, requests: it.requests, seats: it.seats }, { client: "charlois", version: "1.3.2", env: "PRODUCTION", requests: 42, seats: 3 });
  assert.equal(it.firstSeen, it.lastSeen); assert.deepEqual(it.incidents, []);
  assert.ok(it.expiresAt > Date.now() / 1000 + 399 * 86400, "conservation : 400 jours par défaut");
  const h = await db.history(PK_A);
  assert.equal(h.length, 1); assert.equal(h[0].since, "2026-10-24T03:00:00.000Z"); assert.equal(h[0].stats.salesforce.calls, 40);
  assert.ok(!JSON.stringify([it, h]).includes("cle-charlois"), "la clé client n'est jamais stockée");
  assert.equal(mails.length, 0, "aucun e-mail sans incident");
});

test("Envois successifs : un seul état (premier contact conservé), une ligne d'historique par envoi", async () => {
  await send(ok);
  const first = (await db.get(PK_A)).firstSeen;
  await new Promise((r) => setTimeout(r, 5));
  await send({ ...ok, version: "1.3.3", requests: 7 });
  const all = await db.list();
  assert.equal(all.length, 1); assert.equal(all[0].firstSeen, first); assert.notEqual(all[0].lastSeen, first);
  assert.equal(all[0].version, "1.3.3");
  assert.equal((await db.history(PK_A)).length, 2);
});

test("Séparation : même identifiant sous deux clés, ou en production et pré-production = partitions distinctes", async () => {
  await send(ok, "cle-charlois");
  await send({ ...ok, version: "9.9.9" }, "cle-autre");
  await send({ ...ok, env: "PRE-PROD", version: "1.3.3" }, "cle-charlois");
  await send({ ...ok, installation: ID_B }, "cle-troisieme");
  const pks = (await db.list()).map((i) => i.pk).sort();
  assert.deepEqual(pks, [`autre#${ID_A}#PRODUCTION`, `charlois#${ID_A}#PRE-PROD`, PK_A, `troisieme#${ID_B}#PRODUCTION`]);
  assert.equal((await db.get(PK_A)).version, "1.3.2", "ni l'autre client ni la pré-production n'écrasent la production");
});

test("Hub antérieur (sans identifiant ni statistiques) : accepté, une partition par environnement", async () => {
  const { installation, ...legacy } = ok;
  assert.equal((await send({ ...legacy, env: "PRE-PROD" })).statusCode, 200);
  assert.equal((await db.list())[0].pk, "charlois#ancienne#PRE-PROD");
});

test("Payload invalide : JSON, champs, types, bornes, taille, identifiant, statistiques mal formées", async () => {
  const bad = async (body) => (await send(body)).statusCode;
  assert.equal(await bad("{pas du json"), 400);
  for (const b of [{ ...ok, email: "x@y" }, { ...ok, token: "abc" }, { ...ok, installation: "pas-un-uuid" }, { ...ok, version: "1.3" }, { ...ok, env: "AUTRE" },
    { ...ok, date: "24/10/2026" }, { ...ok, requests: -1 }, { ...ok, seats: "7" }, { ...ok, connectors: { a: "oui" } }, { ...ok, connectors: [true] }, [ok],
    { ...ok, since: "hier" }, { ...ok, stats: [] }, { ...ok, stats: { "Pas Valide": st(1) } }, { ...ok, stats: { salesforce: { ...st(1), message: "x" } } },
    { ...ok, stats: { salesforce: st(1, { auth: 5 }) } }, { ...ok, stats: { salesforce: { ...st(1), errors: { ...zero, autre: 0 } } } },
    { ...ok, stats: { salesforce: st(10, {}, { authUsers: 4 }) } }, { ...ok, stats: { salesforce: st(10, {}, { p95: "lent" }) } },
    JSON.parse(`{"version":"1.3.2","connectors":{},"requests":1,"stats":{"__proto__":${JSON.stringify(st(10))}}}`), { ...ok, stats: { constructor: st(10) } },
    { ...ok, connectors: { toString: true } }, { ...ok, version: "1.3.2-www.exemple.com" }, { ...ok, version: "1.3.2-rc.1x" }])
    assert.equal(await bad(b), 400, JSON.stringify(b).slice(0, 80));
  assert.equal((await send(JSON.stringify(ok) + " ".repeat(9000))).statusCode, 413);
  assert.equal((await telemetry({ headers: { "x-clevoa-key": "cle-autre" }, isBase64Encoded: true, body: "A".repeat(40000) })).statusCode, 413, "taille contrôlée avant décodage base64");
  assert.equal((await db.list()).length, 0, "rien n'est enregistré");
  assert.equal(validate({ ...ok, since: "2026-10-24T03:00:00.000Z", stats: { salesforce: st(10), sagex3: st(0) } }), null);
  assert.equal(validate({ ...ok, version: "1.3.2-rc.2" }), null);
});

test("Corps encodé en base64 par API Gateway", async () => {
  const r = await telemetry({ headers: { "x-clevoa-key": "cle-autre" }, isBase64Encoded: true, body: Buffer.from(JSON.stringify(ok)).toString("base64") });
  assert.equal(r.statusCode, 200);
});

test("Versions : minimum et dernière version renvoyés au hub ; comparaison X.Y.Z ; une version ancienne n'envoie aucun e-mail", async () => {
  process.env.MIN_VERSION = "1.3.2"; process.env.LATEST_VERSION = "1.4.0";
  const b = parse(await send({ ...ok, version: "1.3.1" })).body;
  assert.equal(b.minimum, "1.3.2"); assert.equal(b.latest, "1.4.0");
  assert.equal((await report({}, { publish })).outdated.length, 1);
  assert.equal(mails.length, 0, "version ancienne : visible dans la console, pas d'e-mail");
  assert.equal(compareVersions("1.3.1", "1.3.2"), -1); assert.equal(compareVersions("1.10.0", "1.9.9"), 1); assert.equal(compareVersions("1.3.2-rc.1", "1.3.2"), -1);
});

test("Incidents : taux d'erreur du système au-delà de 20 % avec au moins 10 appels ; authentification refusée pour tous ; erreurs d'usage exclues", () => {
  assert.deepEqual(errorIncidents({ sagex3: st(20, { timeout: 5 }) }), ["erreurs:sagex3"], "25 %");
  assert.deepEqual(errorIncidents({ sagex3: st(20, { timeout: 4 }) }), [], "20 % : sous le seuil");
  assert.deepEqual(errorIncidents({ sagex3: st(9, { timeout: 9 }) }), [], "moins de 10 appels : pas de conclusion");
  assert.deepEqual(errorIncidents({ sagex3: st(20, { user: 20 }) }), [], "outils non connectés : erreur d'usage, pas d'incident");
  assert.deepEqual(errorIncidents({ salesforce: st(4, { auth: 4 }, { users: 2, authUsers: 2 }) }), ["auth:salesforce"]);
  assert.deepEqual(errorIncidents({ salesforce: st(4, { auth: 4 }, { users: 1, authUsers: 1 }) }), [], "un seul collaborateur : son jeton, pas l'application");
  assert.deepEqual(errorIncidents({ salesforce: st(4, { auth: 2 }, { users: 3, authUsers: 2 }) }), [], "pas tous les collaborateurs");
  process.env.ERROR_RATE = "0.5"; process.env.ERROR_MIN_CALLS = "4";
  assert.deepEqual(errorIncidents({ sagex3: st(4, { timeout: 2 }) }), [], "seuils configurables");
  assert.match(describe("erreurs:sagex3", { lastStats: { sagex3: st(20, { timeout: 4, unreachable: 2 }) } }), /^Sage X3 : 30 % d'erreurs .*6 sur 20 appels : délai dépassé 4, injoignable 2/);
});

test("E-mail seulement à l'ouverture puis à la fermeture d'un incident, jamais pendant qu'il dure", async () => {
  const errs = { ...ok, stats: { sagex3: st(30, { unreachable: 12 }) } };
  await send(errs);
  assert.equal(mails.length, 1); assert.match(mails[0].subject, /incident chez charlois/);
  assert.match(mails[0].message, /Nouvel incident : Sage X3 : 40 % d'erreurs/); assert.match(mails[0].message, /PRODUCTION · 1\.3\.2/);
  await send(errs); await send(errs);
  assert.equal(mails.length, 1, "incident en cours : aucun nouvel e-mail");
  assert.deepEqual((await db.get(PK_A)).incidents, ["erreurs:sagex3"]);
  await send({ ...ok, stats: { sagex3: st(30, { unreachable: 1 }) } });
  assert.equal(mails.length, 2); assert.match(mails[1].subject, /rétabli chez charlois/); assert.match(mails[1].message, /Rétabli : Sage X3 fonctionne de nouveau/);
  assert.deepEqual((await db.get(PK_A)).incidents, []);
  assert.ok(!mails.some((m) => /cle-charlois/.test(m.message)), "aucune clé dans les e-mails");
});

test("Silence : incident ouvert une fois par le passage horaire après 14 h sans contact, fermé au retour du hub ; perdue sans e-mail après 30 jours", async () => {
  await send(rc2);
  const t0 = Date.parse((await db.get(PK_A)).lastSeen);
  await report({}, { now: t0 + 13 * 3600_000, publish });
  assert.equal(mails.length, 0, "13 h : deux créneaux pas encore manqués");
  const r = await report({}, { now: t0 + 15 * 3600_000, publish });
  assert.equal(r.silent.length, 1); assert.equal(mails.length, 1); assert.match(mails[0].message, /aucun contact depuis/);
  await report({}, { now: t0 + 16 * 3600_000, publish });
  assert.equal(mails.length, 1, "un seul e-mail par silence");
  await send(rc2);
  assert.equal(mails.length, 2); assert.match(mails[1].message, /Rétabli : le hub a repris contact/);
  await db.put({ pk: "autre#x#PRODUCTION", sk: STATE, client: "autre", version: "1.3.1", env: "PRODUCTION", lastSeen: new Date(t0 - 40 * 86400_000).toISOString(), incidents: [] });
  const r2 = await report({}, { now: t0, publish });
  assert.equal(r2.lost.length, 1); assert.equal(mails.length, 2, "installation perdue : listée, sans e-mail");
});

test("Pannes : stockage indisponible → 500 (le hub retentera) ; e-mail en échec → la réception continue", async () => {
  setStore({ async get() { throw Object.assign(new Error("x"), { name: "ServiceUnavailable" }); }, async put() {}, async list() { return []; }, async history() { return []; } });
  assert.equal((await send(ok)).statusCode, 500);
  setStore(db);
  const r = await telemetry(ev({ ...ok, stats: { sagex3: st(30, { other: 20 }) } }), { publish: async () => { throw Object.assign(new Error("x"), { name: "AuthorizationError" }); } });
  assert.equal(r.statusCode, 200, "l'échec de l'e-mail n'empêche pas l'enregistrement");
  assert.deepEqual((await db.get(PK_A)).incidents, ["erreurs:sagex3"]);
  assert.equal(mails.length, 0);
  await send({ ...ok, stats: { sagex3: st(30, { other: 20 }) } });
  assert.equal(mails.length, 1, "e-mail retenté au contact suivant"); assert.match(mails[0].message, /Nouvel incident : Sage X3/);
  await send({ ...ok, stats: { sagex3: st(30, { other: 20 }) } });
  assert.equal(mails.length, 1, "puis plus jamais renvoyé");
  const failing = { async get() { return null; }, async put() { throw Object.assign(new Error("x"), { name: "ServiceUnavailable" }); }, async list() { return []; }, async history() { return []; } };
  setStore(failing);
  assert.equal((await send({ ...ok, installation: ID_B, stats: { sagex3: st(30, { other: 20 }) } })).statusCode, 500);
  setStore(db);
  await send({ ...ok, installation: ID_B, stats: { sagex3: st(30, { other: 20 }) } });
  assert.equal(mails.length, 2, "enregistrement en échec puis renvoi du hub : l'e-mail part à ce moment-là");
});

test("Adaptateur DynamoDB : clé pk + sk, premier contact jamais réécrit, période écrite telle quelle, liste par l'index « etats » et historique paginés, mise à jour conditionnelle, compteur", async () => {
  const sent = [];
  class UpdateItemCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class GetItemCommand { constructor(input) { this.input = input; } }
  const pages = [{ Items: [{ pk: { S: PK_A }, sk: { S: STATE }, version: { S: "1.3.2" }, incidents: { L: [{ S: "silence" }] } }], LastEvaluatedKey: { pk: { S: PK_A }, sk: { S: STATE } } }, { Items: [] }];
  let conditionFails = false;
  const client = { async send(cmd) {
    sent.push(cmd);
    if (cmd instanceof QueryCommand) return cmd.input.IndexName ? pages.shift() : { Items: [{ pk: { S: PK_A }, sk: { S: "P#2026-10-24T09:00:00.000Z" }, requests: { N: "5" } }] };
    if (cmd instanceof GetItemCommand) return { Item: { pk: { S: PK_A }, sk: { S: STATE }, version: { S: "1.3.2" } } };
    if (cmd.input.ConditionExpression && conditionFails) throw Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" });
    if (cmd.input.ReturnValues) return { Attributes: { n: { N: "3" } } };
    return {};
  } };
  const s = dynamoStore("table-test", { client, UpdateItemCommand, QueryCommand, GetItemCommand });
  setStore(s);
  await send({ ...ok, stats: { salesforce: st(10) } });
  const [putPeriod, get, putState] = sent;
  assert.deepEqual(get.input.Key, { pk: { S: PK_A }, sk: { S: STATE } });
  assert.deepEqual(putState.input.Key, { pk: { S: PK_A }, sk: { S: STATE } });
  assert.match(putState.input.UpdateExpression, /#first = if_not_exists\(#first, :now\)$/);
  assert.equal(Object.values(putState.input.ExpressionAttributeNames).filter((n) => n === "firstSeen").length, 1, "firstSeen une seule fois (sinon DynamoDB refuse la requête)");
  assert.ok(!Object.values(putState.input.ExpressionAttributeNames).includes("pk"), "la clé n'est pas réécrite");
  assert.match(putPeriod.input.Key.sk.S, /^P#\d{4}-\d{2}-\d{2}T/); assert.ok(!putPeriod.input.UpdateExpression.includes("if_not_exists"));
  assert.ok(!JSON.stringify(sent).includes("cle-charlois"));
  assert.ok(Object.values(putState.input.ExpressionAttributeNames).includes("etat"), "ligne d'état indexée");
  assert.match(putState.input.ConditionExpression, /^lastSeen = :seen AND attribute_not_exists\(notified\)$/, "état écrit seulement s'il n'a pas changé depuis sa lecture");
  assert.ok(!Object.values(putPeriod.input.ExpressionAttributeNames).includes("etat"), "historique hors de l'index");
  sent.length = 0;
  const all = await s.list();
  assert.equal(sent.length, 2, "deux pages lues, aucun Scan");
  assert.equal(sent[0].input.IndexName, "etats"); assert.equal(sent[0].input.KeyConditionExpression, "etat = :e");
  assert.deepEqual(sent[1].input.ExclusiveStartKey, { pk: { S: PK_A }, sk: { S: STATE } });
  assert.deepEqual(all[0].incidents, ["silence"]);
  assert.equal(await s.claim(PK_A, { lastSeen: "2026-10-24T09:00:00.000Z", notified: "" }, { incidents: ["silence"], notified: "silence" }), true);
  assert.equal(sent.at(-1).input.ConditionExpression, "#seen = :seen AND #told = :told");
  assert.equal(await s.claim(PK_A, { lastSeen: "2026-10-24T09:00:00.000Z" }, { notified: "" }), true);
  assert.equal(sent.at(-1).input.ConditionExpression, "#seen = :seen AND attribute_not_exists(#told)", "état antérieur sans champ notified");
  conditionFails = true;
  assert.equal(await s.claim(PK_A, { lastSeen: "x", notified: "" }, { notified: "" }), false, "condition non remplie : rien d'écrit, pas d'erreur");
  assert.equal(await s.count("charlois#alertes", "H#2026-10-25T06", 1), 3); assert.match(sent.at(-1).input.UpdateExpression, /^ADD #n :one/);
  const h = await s.history(PK_A, "2026-10-01");
  assert.equal(sent.at(-1).input.KeyConditionExpression, "pk = :p AND sk BETWEEN :a AND :b"); assert.equal(sent.at(-1).input.ExpressionAttributeValues[":a"].S, "P#2026-10-01");
  assert.equal(h[0].requests, 5);
});

test("Fermeture sur preuve seulement : une période creuse, trop courte ou sans statistiques laisse l'incident ouvert", async () => {
  const panne = { ...ok, stats: { sagex3: st(40, { unreachable: 20 }) } };
  await send(panne);
  for (const calme of [{ ...ok, stats: {} }, { ...ok, stats: { sagex3: st(3) } }, ok]) {
    await send(calme);
    assert.deepEqual((await db.get(PK_A)).incidents, ["erreurs:sagex3"], JSON.stringify(calme.stats));
  }
  await send(panne);
  assert.equal(mails.length, 1, "une seule panne : un seul e-mail d'ouverture");
  await send({ ...ok, stats: { sagex3: st(40, { unreachable: 2 }) } });
  assert.equal(mails.length, 2); assert.match(mails[1].subject, /rétabli/);
  const conf = { salesforce: true, sagex3: true };
  assert.deepEqual(nextIncidents(["auth:salesforce"], { salesforce: st(5, { auth: 1 }, { users: 2, authUsers: 1 }) }, conf), [], "un collaborateur authentifié : fermé");
  assert.deepEqual(nextIncidents(["auth:salesforce"], { salesforce: st(5, { auth: 5 }, { users: 1, authUsers: 1 }) }, conf), ["auth:salesforce"], "toujours refusé : ouvert");
  assert.deepEqual(nextIncidents(["silence", "erreurs:sagex3"], undefined, conf), ["erreurs:sagex3"], "hub sans statistiques : silence fermé, le reste gardé");
  assert.deepEqual(nextIncidents(["erreurs:sagex3"], {}, { sagex3: false }), [], "connecteur retiré ou passé sur simulateur : incident fermé");
  assert.deepEqual(nextIncidents([], { myreport: st(40, { other: 40 }) }, { myreport: false }), [], "simulateur : aucun incident");
});

test("Hub antérieur à 1.3.2-rc.2 (un envoi par jour) : silence après 50 h, pas après 14 h ; console et backend même règle", async () => {
  await send({ ...ok, version: "1.3.1" });
  const it = await db.get(PK_A), t0 = Date.parse(it.lastSeen);
  assert.equal(it.cadence, 24);
  for (let h = 1; h <= 48; h++) await report({}, { now: t0 + h * 3600_000, publish });
  assert.equal(mails.length, 0, "deux jours sans faux silence");
  await report({}, { now: t0 + 51 * 3600_000, publish });
  assert.equal(mails.length, 1); assert.match(mails[0].message, /aucun contact depuis/);
});

test("Passage horaire : deux passages simultanés n'envoient qu'un e-mail ; un contact du hub entre la lecture et l'écriture l'emporte", async () => {
  await send(rc2);
  const t0 = Date.parse((await db.get(PK_A)).lastSeen);
  await Promise.all([report({}, { now: t0 + 15 * 3600_000, publish }), report({}, { now: t0 + 15 * 3600_000, publish })]);
  assert.equal(mails.length, 1, "un seul e-mail de silence");
  await send(rc2); mails.length = 0;
  const t1 = Date.parse((await db.get(PK_A)).lastSeen);
  const list = db.list.bind(db);
  db.list = async () => { const items = await list(); await send({ ...ok, stats: { sagex3: st(40, { unreachable: 20 }) } }); return items; }; // contact pendant le passage
  await report({}, { now: t1 + 15 * 3600_000, publish });
  db.list = list;
  const it = await db.get(PK_A);
  assert.deepEqual(it.incidents, ["erreurs:sagex3"], "l'état écrit par le contact n'est pas écrasé");
  assert.deepEqual(mails.map((m) => m.subject), ["Clevoa AI Gateway : incident chez charlois"]); assert.ok(!/aucun contact/.test(mails[0].message), "pas de faux silence");
});

test("Plafond d'e-mails : au plus ALERT_MAX_PER_HOUR par client et par heure, le dernier suivi d'un avertissement ; un e-mail en échec est retenté par le passage horaire", async () => {
  process.env.ALERT_MAX_PER_HOUR = "3";
  for (let n = 0; n < 4; n++) {
    await send({ ...ok, stats: { sagex3: st(40, { unreachable: 20 }) } });
    await send({ ...ok, stats: { sagex3: st(40) } });
  }
  assert.deepEqual(mails.map((m) => m.subject.replace(/ chez charlois/, "")), ["Clevoa AI Gateway : incident", "Clevoa AI Gateway : rétabli", "Clevoa AI Gateway : incident", "Clevoa AI Gateway : trop d'alertes"]);
  assert.equal((await send({ ...ok, stats: { sagex3: st(40, { unreachable: 20 }) } }, "cle-autre")).statusCode, 200);
  assert.equal(mails.length, 5, "plafond par client : les autres clients ne sont pas concernés");
  const pending = await db.get(PK_A);
  assert.deepEqual([pending.incidents, pending.notified], [[], "erreurs:sagex3"], "fermeture au-delà du plafond : reportée, pas perdue");
  await report({}, { now: Date.now() + 3600_000, publish });
  assert.match(mails.at(-1).subject, /rétabli chez charlois/, "annoncée l'heure suivante");
  delete process.env.ALERT_MAX_PER_HOUR; setStore((db = memoryStore())); mails.length = 0;
  let down = true;
  const flaky = async (subject, message) => { if (down) throw Object.assign(new Error("x"), { name: "Throttled" }); mails.push({ subject, message }); };
  await telemetry(ev({ ...ok, stats: { sagex3: st(40, { unreachable: 20 }) } }), { publish: flaky });
  const t0 = Date.parse((await db.get(PK_A)).lastSeen);
  assert.equal((await report({}, { now: t0 + 3600_000, publish: flaky })).alertErrors, 1);
  down = false;
  await report({}, { now: t0 + 2 * 3600_000, publish: flaky });
  assert.equal(mails.length, 1, "annoncé au passage suivant"); assert.match(mails[0].message, /Nouvel incident : Sage X3/);
  await report({}, { now: t0 + 3 * 3600_000, publish: flaky });
  assert.equal(mails.length, 1, "une seule fois");
});

test("Même période renvoyée (réponse perdue) : la ligne d'historique est réécrite, pas doublée", async () => {
  const since = "2026-10-24T03:00:00.000Z";
  await send({ ...ok, since, stats: { salesforce: st(10) } });
  await send({ ...ok, since, stats: { salesforce: st(12) } });
  const h = await db.history(PK_A);
  assert.equal(h.length, 1); assert.equal(h[0].sk, `P#${since}`); assert.equal(h[0].stats.salesforce.calls, 12); assert.ok(h[0].at > since);
});

test("Contact du hub pendant que le passage horaire ouvre un silence : l'état est recalculé, le « rétabli » part", async () => {
  await send(rc2);
  const t0 = Date.parse((await db.get(PK_A)).lastSeen);
  const get = db.get.bind(db);
  let once = true;
  db.get = async (pk) => { const prev = await get(pk); if (once) { once = false; await report({}, { now: t0 + 15 * 3600_000, publish }); } return prev; };
  await send(rc2);
  db.get = get;
  assert.deepEqual(mails.map((m) => m.subject.replace(/ chez charlois/, "")), ["Clevoa AI Gateway : incident", "Clevoa AI Gateway : rétabli"]);
  const it = await db.get(PK_A);
  assert.deepEqual([it.incidents, it.notified], [[], ""]);
});

test("Connecteur retiré pendant un incident : fermé avec un e-mail qui le dit", async () => {
  await send({ ...ok, stats: { sagex3: st(40, { unreachable: 20 }) } });
  await send({ ...ok, connectors: { ...ok.connectors, sagex3: false }, stats: {} });
  assert.equal(mails.length, 2); assert.match(mails[1].message, /Sage X3 n'est plus déclaré configuré/);
  assert.deepEqual((await db.get(PK_A)).incidents, []);
});
