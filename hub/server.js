// Hub MCP central : identifie l'utilisateur (clé perso), expose les outils des connecteurs en SSE
// (/sse + /messages) et en Streamable HTTP (/mcp), sert le portail kiosque, les flux OAuth et le diagnostic.
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { store } from "./store.js";
import { oauthRouter, withToken, hasCredential, keyCookie, PUBLIC_URL } from "./oauth.js";
import * as sso from "./sso.js";
import { cachedSchema } from "./cache.js";
import * as salesforce from "./connectors/salesforce.js";
import * as sagex3 from "./connectors/sagex3.js";
import * as sharepoint from "./connectors/sharepoint.js";
import * as dropbox from "./connectors/dropbox.js";
import * as myreport from "./connectors/myreport.js";
import * as telemetry from "./telemetry.js";
import * as health from "./health.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { rateLimit } from "express-rate-limit"; // déjà fourni par le SDK MCP (même version) ; utilisé pour les routes de supervision
import { VERSION, APP_ENV, IS_PROD } from "./version.js";

const PORT = process.env.PORT || 8080;
const debug = process.env.LOG_LEVEL === "debug" ? (...a) => console.log("[debug]", ...a) : () => {};
// Verrou production : l'URL publique doit être en https (cookie Secure, callbacks OAuth), sauf test local.
if (IS_PROD && !/^https:|^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(PUBLIC_URL)) { console.error(`[prod] PUBLIC_URL doit être en https : ${PUBLIC_URL}`); process.exit(1); }
// En production, un connecteur sans configuration (simulateur) n'est pas exposé : jamais de données inventées en prod.
const CONNECTORS = [salesforce, sagex3, sharepoint, dropbox, myreport].filter((c) => !(IS_PROD && c.mock));
// Multi-client : nom sous lequel le serveur MCP s'annonce aux assistants (clé du bloc mcpServers du portail) et libellé de
// l'instance affiché sur le portail. Le nom sert de clé JSON côté client : lettres, chiffres, tirets et soulignés seulement.
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(process.env.MCP_SERVER_NAME || "") ? process.env.MCP_SERVER_NAME : "clevoa-gateway";
const INSTANCE_LABEL = (process.env.INSTANCE_LABEL || "").trim().slice(0, 80);
// Domaine de chaque application sur le portail (classement) : celui du connecteur, ou CONNECTOR_DOMAINS="sagex3=industrie,…".
const DOMAINS = ["commerce", "finance", "industrie", "documents", "rh", "autre"];
const domainOverride = Object.fromEntries((process.env.CONNECTOR_DOMAINS || "").split(",").map((e) => e.split("=").map((x) => x.trim())).filter(([id, d]) => id && DOMAINS.includes(d)));
const domainOf = (c) => (Object.hasOwn(domainOverride, c.id) ? domainOverride[c.id] : DOMAINS.includes(c.domain) ? c.domain : "autre");
const byId = Object.assign(Object.create(null), Object.fromEntries(CONNECTORS.map((c) => [c.id, c]))); // sans prototype : « constructor », « __proto__ »… ne désignent aucun système
// Variables visibles dans le portail : toutes celles des connecteurs et du hub présentes dans l'environnement (jamais la valeur des secrets).
const ENV = Object.keys(process.env).filter((n) => /^(PUBLIC_URL|APP_ENV|LOG_LEVEL|TRUST_PROXY|ENCRYPTION_KEY|SSO_MODE|MCP_SERVER_NAME|INSTANCE_LABEL|SF_|SAGE_|MS_|SP_|GRAPH_URL|DROPBOX_|MYREPORT_|CLEVOA_|PROBE$|SLOW_MS$|METRICS_TOKEN$|CONNECTOR_DOMAINS$)/.test(n)).sort();
const masked = (n) => (/SECRET|CLEVOA_KEY|ENCRYPTION_KEY|METRICS_TOKEN/.test(n) ? "••••••••" : process.env[n]); // CLEVOA_KEY est une clé de licence, masquée comme les secrets

// ---------- Limitation de débit (mémoire, par adresse IP) ----------
// Protège le diagnostic, les jetons et les échecs d'authentification contre la force brute. Fenêtre fixe simple.
const buckets = new Map(); // "règle:ip" -> { n, reset }
function hit(rule, ip, max, windowMs = 60_000) {
  const id = `${rule}:${ip}`, now = Date.now();
  let b = buckets.get(id);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(id, b); }
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k); // purge paresseuse
  return ++b.n > max;
}
const limit = (rule, max) => (req, res, next) => hit(rule, req.ip, max) ? res.status(429).json({ error: "Trop de requêtes, réessayez dans une minute." }) : next();

// ---------- Identité ----------
// Cookie "mcp_key" pour le portail ; en-tête "Authorization: Bearer <clé>" UNIQUEMENT pour les clients MCP
// (jamais dans l'URL : les journaux des reverse-proxys conserveraient la clé en clair).
const cookieKey = (req) => req.headers.cookie?.match(/(?:^|;\s*)mcp_key=([^;]+)/)?.[1];
const mcpKey = (req) => req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
// Avec le SSO, une clé n'est utilisable qu'une fois liée à une identité Entra (une clé temporaire de navigateur ne l'est pas).
const user = (key) => { const u = store.get(key); return u && (!sso.MODE || u.sso) ? u : null; };
const requireKey = (read) => (req, res, next) => {
  req.key = read(req);
  if (user(req.key)) return next(); // une clé valide n'est jamais freinée par les échecs d'autres clients de la même IP
  if (hit("auth-fail", req.ip, 20)) return res.status(429).json({ error: "Trop d'échecs d'authentification, réessayez dans une minute." });
  res.status(401).json({ error: "Clé MCP inconnue ou absente : utilisez l'en-tête Authorization: Bearer <clé> obtenue sur le portail." });
};
const portalUser = requireKey(cookieKey);
const mcpUser = [requireKey(mcpKey), (req, _res, next) => { store.assistantSeen(req.key); next(); }]; // tout appel MCP authentifié : l'assistant est branché
// Les POST du portail changent l'état du collaborateur : un navigateur qui annonce une autre origine (formulaire d'un site frère sous le
// même domaine, que SameSite=Lax laisse passer) est refusé. Les clients MCP n'appellent pas ces routes.
const ORIGIN = new URL(PUBLIC_URL).origin;
const sameOrigin = (req, res, next) => (req.headers.origin && req.headers.origin !== ORIGIN ? res.status(403).json({ error: "Origine refusée" }) : next());

/** Exécute un outil/ping d'un connecteur avec le jeton de l'utilisateur et sa structure en cache.
 *  Un connecteur peut plafonner ses appels sortants (maxPerMinute, tous utilisateurs confondus) pour ménager un système de production. */
const capped = (c, key) => c.maxPerMinute && hasCredential(store.get(key)?.[c.id]) && hit(`upstream:${c.id}`, "*", c.maxPerMinute); // 1 appel d'outil ou de diagnostic = 1 unité
const call = (c, key, fn) => {
  if (capped(c, key)) throw new Error(`${c.label} : plafond de ${c.maxPerMinute} appels par minute atteint, réessayez dans un instant.`);
  return withToken(c, key, (tok) => fn(tok, () => cachedSchema(key, c.id, () => c.schema(tok))));
};

// ---------- Serveur MCP (un par connexion, lié à la clé de l'utilisateur) ----------
/** Ligne de provenance jointe à chaque résultat : système, et dossier pour Sage X3. */
const provenance = (c) => `Source : ${c.label}${c.source ? ` · ${c.source()}` : ""}`;
const INSTRUCTIONS = [
  "Outils en LECTURE SEULE sur Salesforce, Sage X3, SharePoint, Dropbox et MyReport avec les droits de l'utilisateur connecté.",
  "Chaque résultat se termine par une ligne « Source : … » (système, dossier Sage X3, sandbox ou production Salesforce) : toujours la citer dans la réponse, pour que l'utilisateur sache d'où vient chaque donnée.",
  "Question sur un client, un fournisseur, une commande ou une facture sans nommer le système : interroger Sage X3 ET Salesforce, puis dire ce que chacun renvoie.",
  "Salesforce : salesforce_tools puis salesforce_call (serveur MCP officiel SObject Reads). Sage X3 : sagex3_describe puis sagex3_query ; les montants sont dans la devise de l'ERP.",
  "Documents : sharepoint_search / sharepoint_read, dropbox_tools puis dropbox_call. Analyses MyReport : myreport_tools puis myreport_call.",
].join(" ");

function buildServer(key) {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  for (const c of CONNECTORS) for (const t of c.tools) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.input, annotations: { readOnlyHint: true } }, async (args) => {
      telemetry.count();
      const t0 = Date.now();
      try {
        const out = await call(c, key, (tok, schema) => t.run(tok, args, schema));
        telemetry.record(c.id, key, Date.now() - t0); // nombres seulement : appel, durée, empreinte locale de l'appelant
        health.record(c.id, Date.now() - t0, undefined, key);
        debug(`${t.name} ok ${Date.now() - t0} ms`); // jamais les arguments ni les résultats
        const body = out?.$content ? out.$content : [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }]; // $content : contenu MCP relayé tel quel (image, resource)
        return { content: [...body, { type: "text", text: provenance(c) }] }; // traçabilité : d'où vient chaque donnée
      } catch (e) {
        telemetry.record(c.id, key, Date.now() - t0, e); // type d'erreur seulement, jamais le message
        health.record(c.id, Date.now() - t0, e, key);
        debug(`${t.name} erreur ${Date.now() - t0} ms : ${e.status ?? "erreur"}`); // jamais le message (il peut citer une clé demandée)
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    });
  }
  return server;
}

// ---------- HTTP ----------
const app = express();
app.disable("x-powered-by"); // pas d'annonce « Express » dans les réponses
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1)); // adresse IP réelle derrière un reverse-proxy (1 saut)
// En-têtes de sécurité HTTP (signalés par ZAP). Le portail est un fichier unique avec scripts et styles en ligne, d'où 'unsafe-inline' ;
// aucune ressource externe, jamais d'iframe, pas de capteur. Le proxy MCP (/mcp, /sse) n'en est pas affecté.
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};
app.use((_req, res, next) => { res.set(SECURITY_HEADERS); next(); });
app.use(express.json({ limit: "1mb" }));
app.use(express.static(new URL("./public", import.meta.url).pathname));
app.use("/auth", limit("oauth", 60)); // départs et retours OAuth bornés par IP (le départ SSO est ouvert aux anonymes : clés temporaires, états en attente)
app.use(oauthRouter(sso.MODE ? [...CONNECTORS, sso.connector] : CONNECTORS, cookieKey));

// Portail : état de l'utilisateur (crée la clé au premier passage, sauf SSO : identité requise, le portail redirige vers /auth/sso) + configuration masquée.
app.get("/api/me", limit("me", 60), (req, res) => {
  let key = cookieKey(req);
  if (!user(key)) {
    if (sso.MODE) return res.json({ version: VERSION, env: APP_ENV, instance: INSTANCE_LABEL, sso: sso.MODE, email: null, key: null, systems: [] });
    key = store.create();
    res.setHeader("Set-Cookie", keyCookie(key));
  }
  const u = store.get(key);
  res.json({
    version: VERSION,
    env: APP_ENV,
    instance: INSTANCE_LABEL,
    serverName: SERVER_NAME,
    sso: sso.MODE || undefined,
    email: u.email || null,
    key,
    assistantAt: u.assistantAt || null, // dernier jour où un assistant a utilisé la clé
    mcpUrl: `${PUBLIC_URL}/mcp`,
    systems: CONNECTORS.map((c) => ({
      id: c.id, label: c.label, domain: domainOf(c), mock: !!c.mock, oauth: !!c.oauth, configured: !!c.oauth?.clientId,
      connected: hasCredential(u[c.id]), method: u[c.id]?.apiKey ? "apikey" : u[c.id]?.access_token ? "oauth" : null,
      apiKey: c.apiKey && !c.mock ? c.apiKey : undefined, // le portail propose la saisie d'un jeton personnel
    })),
    // Configuration visible en local (Docker Desktop) ou une fois l'utilisateur connecté à un système ; jamais aux anonymes d'un hub public.
    config: !PUBLIC_URL.startsWith("https") || CONNECTORS.some((c) => hasCredential(u[c.id]))
      ? ENV.map((n) => ({ name: n, value: process.env[n] ? masked(n) : null })) : undefined,
  });
});
// Nouvelle clé pour le même collaborateur : l'ancienne cesse de fonctionner immédiatement (révocation d'un client MCP compromis).
app.post("/api/key/rotate", limit("portal", 30), sameOrigin, portalUser, (req, res) => {
  const fresh = store.rotate(req.key);
  res.setHeader("Set-Cookie", keyCookie(fresh)); res.json({ key: fresh });
});
// Fin de session du portail : cookie effacé, la clé reste valide pour les clients MCP. Avec le SSO, le portail enchaîne sur la déconnexion
// Microsoft (`next`) : sans elle, sur un poste partagé, le suivant retrouverait la clé du précédent d'un clic.
app.post("/api/logout", limit("portal", 30), sameOrigin, portalUser, (_req, res) => {
  res.setHeader("Set-Cookie", "mcp_key=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ next: sso.MODE ? sso.logoutUrl : "/" });
});
app.post("/api/disconnect/:system", limit("portal", 30), sameOrigin, portalUser, (req, res) => {
  if (!byId[req.params.system]) return res.sendStatus(404);
  store.clearTokens(req.key, req.params.system); res.sendStatus(204);
});
// Jeton personnel (clé d'API Syracuse, jeton MyReport…) saisi par l'utilisateur : remplace son entrée pour ce système.
app.post("/api/:system/apikey", limit("portal", 30), sameOrigin, portalUser, (req, res) => {
  const c = byId[req.params.system];
  if (!c?.apiKey) return res.sendStatus(404);
  const apiKey = String(req.body?.apiKey || "").trim(), login = String(req.body?.login || "").trim();
  if (!apiKey) return res.status(400).json({ error: "Jeton vide" });
  store.clearTokens(req.key, c.id);
  store.setTokens(req.key, c.id, { apiKey, ...(login ? { login } : {}) });
  res.sendStatus(204);
});
// Diagnostic : un appel minimal au système avec le jeton de l'utilisateur (ou le simulateur).
app.get("/api/test/:system", limit("diag", 20), portalUser, async (req, res) => {
  const c = byId[req.params.system];
  if (!c) return res.sendStatus(404);
  if (capped(c, req.key)) return res.json({ ok: false, error: `${c.label} : plafond de ${c.maxPerMinute} appels par minute atteint, réessayez dans un instant.` });
  try { res.json({ ok: true, ...(await withToken(c, req.key, (tok) => c.ping(tok, () => c.schema(tok)))) }); } // structure relue, pas le cache
  catch (e) { res.json({ ok: false, error: e.message.slice(0, 300) }); }
});

// État des systèmes pour le portail : un état et un temps de réponse par système, jamais un volume ni une identité. Réservé, comme la
// configuration, à un collaborateur identifié (SSO) ou ayant connecté au moins un système : pas à un visiteur d'un hub public.
app.get("/api/status", limit("status", 60), portalUser, (req, res) => {
  const u = store.get(req.key);
  if (!sso.MODE && !CONNECTORS.some((c) => hasCredential(u[c.id]))) return res.status(403).json({ error: "Connectez d'abord une application." });
  const mode = health.probeMode(), probing = mode !== "off" && CONNECTORS.some(health.probeable);
  res.json({ probeHours: health.probeHours(), paused: probing && mode !== "always" && !health.inProbeHours(), probe: probing,
    systems: CONNECTORS.map((c) => ({ id: c.id, ...health.status(c) })) });
});

// Supervision : /metrics au format texte Prometheus (Zabbix, Centreon, Prometheus, Grafana…) et /metrics/prtg au format JSON du
// capteur PRTG « HTTP Data Advanced ». Jeton METRICS_TOKEN distinct des clés des collaborateurs, en Bearer ou en mot de passe
// d'une authentification HTTP (identifiant libre). Sans jeton configuré, les routes n'existent pas. Aucune identité, clé ni donnée métier.
const METRICS_TOKEN = process.env.METRICS_TOKEN || "";
// Jeton court = devinable par essais depuis plusieurs adresses : refusé au démarrage (openssl rand -hex 24).
if (METRICS_TOKEN && METRICS_TOKEN.length < 24) { console.error("[metrics] METRICS_TOKEN trop court : 24 caractères au moins (openssl rand -hex 24)"); process.exit(1); }
const metricsAuth = (req) => {
  const h = req.headers.authorization || "";
  const basic = h.match(/^Basic\s+(\S+)$/i)?.[1];
  return basic ? Buffer.from(basic, "base64").toString().split(":").slice(1).join(":") : mcpKey(req) ?? "";
};
const sameToken = (given) => timingSafeEqual(createHash("sha256").update(String(given)).digest(), createHash("sha256").update(METRICS_TOKEN).digest());
const STATES = ["ok", "lent", "erreurs", "injoignable", "inconnu", "simule"];
const promLabel = (v) => String(v).replace(/[\\"\n]/g, "_");
/** Vrai si la requête est refusée (réponse déjà envoyée) : route absente sans jeton configuré, 401 ou 429 sinon. */
const metricsDenied = (req, res) => {
  if (!METRICS_TOKEN) { res.sendStatus(404); return true; }
  if (sameToken(metricsAuth(req))) return false;
  res.status(hit("auth-fail", req.ip, 20) ? 429 : 401).set("WWW-Authenticate", 'Basic realm="supervision"').type("text/plain").send("jeton de supervision requis\n");
  return true;
};
// PRTG : un canal « Santé » par système (0 bon, 1 avertissement si lent, 2 erreur si en erreurs ou injoignable ; seuils posés
// par le hub), joignabilité, temps de réponse p95, appels et erreurs du système (mode différence : par intervalle de PRTG).
// 30 relevés par minute et par adresse IP pour les deux routes de supervision (PRTG relève toutes les 1 à 5 minutes).
const metricsLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Trop de requêtes, réessayez dans une minute." } });
app.get("/metrics/prtg", metricsLimit, (req, res) => {
  if (metricsDenied(req, res)) return;
  const result = [], bad = [];
  for (const c of CONNECTORS) {
    const s = health.status(c), n = health.counters(c.id);
    if (s.state === "simule") continue;
    const level = s.state === "lent" ? 1 : ["erreurs", "injoignable"].includes(s.state) ? 2 : 0;
    if (level) bad.push(`${c.label} : ${s.state}${s.probe?.reason ? ` (${s.probe.reason})` : ""}`);
    result.push({ channel: `${c.label} · santé`, value: level, unit: "Custom", customunit: "", limitmode: 1, limitmaxwarning: 0.5, limitmaxerror: 1.5,
      limitwarningmsg: `${c.label} lent`, limiterrormsg: `${c.label} en erreurs ou injoignable` });
    if (n.probe && n.probe.at >= Date.now() - 25 * 60_000) result.push({ channel: `${c.label} · joignable`, value: n.probe.ok ? 1 : 0, unit: "Custom", customunit: "", limitmode: 1, limitminerror: 0.5, limiterrormsg: `${c.label} injoignable` });
    if (s.p95 != null) result.push({ channel: `${c.label} · p95`, value: s.p95, unit: "TimeResponse" });
    result.push({ channel: `${c.label} · appels`, value: n.calls, unit: "Count", mode: "Difference" });
    result.push({ channel: `${c.label} · erreurs système`, value: n.sys, unit: "Count", mode: "Difference" });
  }
  result.push({ channel: "Hub · sièges", value: store.seats(), unit: "Count" });
  result.push({ channel: "Hub · mémoire", value: process.memoryUsage().rss, unit: "BytesMemory" });
  result.push({ channel: "Hub · durée de fonctionnement", value: Math.round(process.uptime()), unit: "TimeSeconds" });
  res.json({ prtg: { result, text: bad.length ? bad.join(" · ") : `Clevoa AI Gateway ${VERSION} : systèmes opérationnels` } });
});
app.get("/metrics", metricsLimit, (req, res) => {
  if (metricsDenied(req, res)) return;
  const m = [], g = (name, help, type = "gauge") => m.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  g("clevoa_hub_info", "Version et environnement du hub");
  m.push(`clevoa_hub_info{version="${promLabel(VERSION)}",env="${promLabel(APP_ENV)}"} 1`);
  g("clevoa_hub_uptime_seconds", "Durée depuis le démarrage"); m.push(`clevoa_hub_uptime_seconds ${Math.round(process.uptime())}`);
  g("clevoa_hub_memory_rss_bytes", "Mémoire résidente"); m.push(`clevoa_hub_memory_rss_bytes ${process.memoryUsage().rss}`);
  g("clevoa_hub_seats", "Collaborateurs ayant connecté au moins un système"); m.push(`clevoa_hub_seats ${store.seats()}`);
  const sent = telemetry.lastSuccess();
  g("clevoa_telemetry_last_success_timestamp_seconds", "Dernier envoi de télémétrie accepté par Clevoa (0 : aucun)"); m.push(`clevoa_telemetry_last_success_timestamp_seconds ${sent ? Math.round(sent / 1000) : 0}`);
  const rows = CONNECTORS.map((c) => ({ c, s: health.status(c), n: health.counters(c.id) }));
  g("clevoa_system_state", "État du système (1 pour l'état courant)");
  for (const { c, s } of rows) for (const st of STATES) m.push(`clevoa_system_state{system="${promLabel(c.id)}",state="${st}"} ${s.state === st ? 1 : 0}`);
  // Sonde de moins de 25 minutes seulement : hors des heures de vérification, une sonde ancienne ne maintient pas une alerte.
  const freshProbe = (n) => n.probe && n.probe.at >= Date.now() - 25 * 60_000;
  g("clevoa_system_up", "Sonde HEAD de moins de 25 minutes : 1 joignable, 0 injoignable (absente sinon)");
  for (const { c, n } of rows) if (freshProbe(n)) m.push(`clevoa_system_up{system="${promLabel(c.id)}"} ${n.probe.ok ? 1 : 0}`);
  g("clevoa_system_probe_seconds", "Durée de la sonde HEAD de moins de 25 minutes");
  for (const { c, n } of rows) if (freshProbe(n)) m.push(`clevoa_system_probe_seconds{system="${promLabel(c.id)}"} ${(n.probe.ms / 1000).toFixed(3)}`);
  g("clevoa_system_calls_total", "Appels d'outils depuis le démarrage", "counter");
  for (const { c, n } of rows) m.push(`clevoa_system_calls_total{system="${promLabel(c.id)}"} ${n.calls}`);
  g("clevoa_system_errors_total", "Erreurs d'outils par type depuis le démarrage", "counter");
  for (const { c, n } of rows) for (const t of telemetry.ERROR_TYPES) m.push(`clevoa_system_errors_total{system="${promLabel(c.id)}",type="${t}"} ${n.errors[t] ?? 0}`);
  g("clevoa_system_latency_p95_seconds", "Temps de réponse p95 des appels réussis de la dernière heure");
  for (const { c, s } of rows) if (s.p95 != null) m.push(`clevoa_system_latency_p95_seconds{system="${promLabel(c.id)}"} ${(s.p95 / 1000).toFixed(3)}`);
  res.type("text/plain; version=0.0.4; charset=utf-8").send(m.join("\n") + "\n");
});

// Transport SSE (standard historique) : GET /sse ouvre le flux, POST /messages?sessionId= reçoit les requêtes.
const sseSessions = new Map(); // sessionId -> { transport, key } : une session n'est utilisable qu'avec la clé qui l'a ouverte
app.get("/sse", mcpUser, async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseSessions.set(transport.sessionId, { transport, key: req.key });
  res.on("close", () => sseSessions.delete(transport.sessionId));
  await buildServer(req.key).connect(transport);
});
app.post("/messages", mcpUser, async (req, res) => {
  const s = sseSessions.get(String(req.query.sessionId ?? ""));
  if (!s) return res.status(404).json({ error: "Session SSE inconnue" });
  if (s.key !== req.key) return res.status(403).json({ error: "Session SSE ouverte par une autre clé" });
  await s.transport.handlePostMessage(req, res, req.body);
});

// Transport Streamable HTTP (sans état) : un serveur jetable par requête.
app.post("/mcp", mcpUser, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer(req.key);
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.all("/mcp", (_req, res) => res.status(405).json({ error: "Utilisez POST (mode sans état)." }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Hub MCP v${VERSION} · ENV: ${APP_ENV} · ${PUBLIC_URL} (port ${PORT})${sagex3.mock ? " · Sage X3 simulé" : ""}${myreport.mock ? " · MyReport simulé" : ""}${sso.MODE ? ` · SSO ${sso.MODE}` : ""}${process.env.LOG_LEVEL === "debug" ? " · logs détaillés" : ""}`);
  telemetry.start(CONNECTORS, store.seats, store.installationId);
  health.start(CONNECTORS);
});
