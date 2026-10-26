// Console de suivi Clevoa : un serveur HTTP sans framework, à lancer sur un poste ou un NAS de Clevoa (jamais exposé sur internet).
// Il lit la table DynamoDB de télémétrie en LECTURE SEULE (identifiants IAM limités à Query, GetItem et DescribeTable) et sert une page :
// état de chaque installation, incidents en cours, et historique sur 30 jours (appels, erreurs, latence par connecteur).
// Aucune écriture, aucune commande vers les hubs : la console ne fait que lire ce que les hubs ont envoyé.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { dynamoStore, describe, compareVersions, silenceMs } from "../clevoa-backend/handler.js";
import { demoSource } from "./demo.js";

const PORT = Number(process.env.CONSOLE_PORT || 8090);
const PASSWORD = process.env.CONSOLE_PASSWORD || "";
const SILENCE_HOURS = Number(process.env.SILENCE_HOURS || 14), LOST_DAYS = Number(process.env.SILENCE_MAX_DAYS || 30);
const MIN_VERSION = process.env.MIN_VERSION || "";
const PK = /^[a-z0-9-]{1,40}#[0-9a-z-]{1,40}#(PRODUCTION|PRE-PROD|inconnu)$/;
const PUBLIC = new URL("./public/", import.meta.url).pathname;
const FILES = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/favicon.svg": ["favicon.svg", "image/svg+xml"], "/fonts/outfit-variable-latin.woff2": ["fonts/outfit-variable-latin.woff2", "font/woff2"] };
const HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
};

/** Source de lecture : démonstration, ou DynamoDB réduit à ses trois méthodes de lecture (aucune écriture possible d'ici). */
async function source() {
  if (process.env.CONSOLE_DEMO === "1") return demoSource();
  if (!process.env.TELEMETRY_TABLE) throw new Error("TELEMETRY_TABLE non renseignée (ou CONSOLE_DEMO=1 pour la démonstration)");
  const sdk = await import("@aws-sdk/client-dynamodb");
  const s = dynamoStore(process.env.TELEMETRY_TABLE, { client: new sdk.DynamoDBClient({}), QueryCommand: sdk.QueryCommand, GetItemCommand: sdk.GetItemCommand });
  return { demo: false, list: s.list, get: s.get, history: s.history };
}

/** État lisible d'une installation, d'après la même règle que le backend (silence à 14 h, ou 50 h pour un hub d'avant 1.3.2-rc.2). */
export function status(i, now = Date.now()) {
  const age = now - Date.parse(i.lastSeen);
  if (age > LOST_DAYS * 86400_000) return "perdue";
  if (age > silenceMs(i) || (i.incidents ?? []).includes("silence")) return "silencieuse";
  if ((i.incidents ?? []).length) return "incident";
  return "ok";
}

/** Dernière période envoyée : appels, part d'erreurs du système (erreurs d'usage exclues), pire latence p95 parmi les connecteurs. */
function lastPeriod(stats) {
  const all = Object.values(stats ?? {});
  const calls = all.reduce((n, s) => n + s.calls, 0);
  const errors = all.reduce((n, s) => n + Object.entries(s.errors).filter(([t]) => t !== "user").reduce((m, [, v]) => m + v, 0), 0);
  return { calls, errorRate: calls ? errors / calls : null, p95: all.length ? Math.max(...all.map((s) => s.p95)) : null };
}

export function overview(items, now = Date.now()) {
  return items.map((i) => ({ ...lastPeriod(i.lastStats),
    pk: i.pk, client: i.client, env: i.env, version: i.version, seats: i.seats, lastSeen: i.lastSeen, firstSeen: i.firstSeen,
    status: status(i, now), outdated: !!MIN_VERSION && compareVersions(i.version, MIN_VERSION) < 0,
    incidents: (i.incidents ?? []).map((code) => describe(code, i)), connectors: i.connectors,
  })).sort((a, b) => ["incident", "silencieuse", "ok", "perdue"].indexOf(a.status) - ["incident", "silencieuse", "ok", "perdue"].indexOf(b.status) || a.client.localeCompare(b.client));
}

// ---------- Accès ----------
const failures = new Map(); // ip -> { n, reset } : 10 échecs par minute, puis 429
function authorized(req) {
  if (!PASSWORD) return true;
  const m = (req.headers.authorization || "").match(/^Basic\s+(\S+)$/i);
  const given = Buffer.from(m ? Buffer.from(m[1], "base64").toString().split(":").slice(1).join(":") : "");
  const expected = Buffer.from(PASSWORD);
  // Comparaison à temps constant ; seule la longueur du mot de passe peut se déduire du temps de réponse.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res, code, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(code, { ...HEADERS, "Content-Type": type, ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export function createConsole(src) {
  return createServer((req, res) => handle(src, req, res).catch((e) => { // aucune requête, même mal formée, n'arrête la console
    console.error("[console] erreur", e.name, e.message);
    if (!res.headersSent) send(res, 500, { error: "erreur interne" }); else res.destroy();
  }));
}

async function handle(src, req, res) {
  let url;
  try { url = new URL(req.url, "http://console"); } catch { return send(res, 400, { error: "requête invalide" }); }
  if (req.method !== "GET") return send(res, 405, { error: "lecture seule" });
  if (url.pathname === "/health") return send(res, 200, { ok: true });
  const ip = req.socket.remoteAddress, now = Date.now();
  const f = failures.get(ip);
  if (f && f.reset > now && f.n >= 10) return send(res, 429, { error: "trop d'échecs, réessayez dans une minute" });
  if (failures.size > 1000) for (const [k, v] of failures) if (v.reset < now) failures.delete(k); // purge paresseuse
  if (!authorized(req)) {
    failures.set(ip, f && f.reset > now ? { n: f.n + 1, reset: f.reset } : { n: 1, reset: now + 60_000 });
    return send(res, 401, { error: "mot de passe requis" }, undefined, { "WWW-Authenticate": 'Basic realm="Console Clevoa", charset="UTF-8"' });
  }
  try {
    if (FILES[url.pathname]) { const [file, type] = FILES[url.pathname]; return send(res, 200, readFileSync(PUBLIC + file), type); }
    if (url.pathname === "/api/installations") return send(res, 200, { demo: src.demo, generatedAt: new Date().toISOString(), silenceHours: SILENCE_HOURS, minVersion: MIN_VERSION || null, installations: overview(await src.list()) });
    if (url.pathname === "/api/history") {
      const pk = url.searchParams.get("pk") || "", days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 395);
      if (!PK.test(pk)) return send(res, 400, { error: "installation invalide" });
      const from = new Date(Date.now() - days * 86400_000).toISOString();
      const periods = (await src.history(pk, from)).map((p) => ({ at: p.at ?? p.sk.slice(2), since: p.since, version: p.version, requests: p.requests, seats: p.seats, stats: p.stats ?? {} }));
      return send(res, 200, { pk, days, periods });
    }
    return send(res, 404, { error: "introuvable" });
  } catch (e) {
    console.error("[console] erreur", e.name, e.message);
    return send(res, 502, { error: "lecture de la table impossible : identifiants AWS, région ou nom de table à vérifier" });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = await source();
  if (!PASSWORD && !src.demo) { console.error("[console] CONSOLE_PASSWORD obligatoire (sauf démonstration) : démarrage refusé"); process.exit(1); }
  createConsole(src).listen(PORT, () => console.log(`Console Clevoa sur le port ${PORT}${src.demo ? " · données de démonstration" : ` · table ${process.env.TELEMETRY_TABLE}`}`));
}
