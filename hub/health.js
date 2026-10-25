// État des systèmes desservis par le hub, affiché sur le portail et exposé à la supervision (/metrics). Sans aucun identifiant :
// - sonde : une requête HEAD vers l'adresse de chaque système réel, toutes les 10 minutes, du lundi au vendredi de 7 h à 19 h
//   (heure du serveur, TZ). N'importe quelle réponse HTTP, 401, 403 ou 405 compris, prouve que le système est joignable ; un échec
//   DNS, TLS, une connexion refusée ou un délai dépassé le dit injoignable. Aucun en-tête d'authentification, aucune redirection suivie ;
// - appels réels des collaborateurs sur la dernière heure : part d'erreurs du système et temps de réponse.
// Le portail n'affiche qu'un état et un temps de réponse, jamais un volume, une heure d'appel ni une identité. PROBE=off (ou
// false, 0) désactive la sonde, PROBE=always la fait tourner à toute heure (essai d'installation).
// Une erreur ne compte contre le système que si elle vient du système : refus d'authentification et requêtes refusées (4xx) sont
// le fait d'un collaborateur (jeton expiré, droits, filtre invalide), et il faut au moins deux collaborateurs touchés.
import { randomBytes, createHash } from "node:crypto";
import { category } from "./telemetry.js";

const EVERY = 10 * 60_000, TIMEOUT = 5_000, WINDOW = 3600_000, FRESH = 25 * 60_000, MAX = 5000;
const SLOW_MS = Number(process.env.SLOW_MS) > 0 ? Number(process.env.SLOW_MS) : 10_000; // p95 au-delà duquel un système est « lent »
const HOURS_LABEL = "du lundi au vendredi, de 7 h à 19 h";
/** Libellé des heures de vérification selon PROBE. */
export const probeHours = () => (probeMode() === "always" ? "en continu" : probeMode() === "off" ? "désactivée" : HOURS_LABEL);
const MIN_CALLS = 5; // en dessous, ni taux d'erreur ni temps de réponse : trop peu pour conclure, et trop proche d'un individu
const SALT = randomBytes(16);
const who = (key) => createHash("sha256").update(SALT).update(String(key ?? "")).digest("base64url").slice(0, 12); // en mémoire seulement
/** Mode de la sonde : « off », « always » ou « hours » (défaut), d'après PROBE. */
export const probeMode = () => { const v = String(process.env.PROBE || "").trim().toLowerCase(); return ["off", "false", "0", "non", "no"].includes(v) ? "off" : v === "always" ? "always" : "hours"; };
const probes = new Map(); // id -> { at, ok, ms, reason }
const recent = new Map(); // id -> [{ at, ms, type }] sur la dernière heure
const totals = new Map(); // id -> { calls, errors: { type: n } } depuis le démarrage (compteurs Prometheus)

/** Vrai pendant les heures de sonde : lundi à vendredi, 7 h à 19 h, heure locale du serveur. */
export const inProbeHours = (d = new Date()) => d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 7 && d.getHours() < 19;

/** Un système est sondé s'il est réel, configuré et a une adresse : jamais un simulateur. */
export const probeable = (c) => !c.mock && !!c.probeUrl && !!(c.apiKey || c.oauth?.clientId);

/** Erreur imputable au système (et non au collaborateur) : ni erreur d'usage, ni refus d'authentification, ni requête refusée (4xx
 *  hors 429), ni plafond d'appels du hub lui-même (l'appel n'a pas atteint le système). */
/** Erreur imputable au système (ni au collaborateur, ni à son jeton, ni au plafond du hub) : même définition pour le portail, la
 *  supervision et les compteurs d'usage (db.js). */
export const systemFault = (type, e) => !!type && type !== "user" && type !== "auth" && !(type === "other" && e?.status >= 400 && e?.status < 500)
  && !(type === "quota" && /plafond de \d+ appels/.test(String(e?.message)));

/** Enregistre un appel d'outil : durée, type d'erreur (jamais le message), empreinte locale de l'appelant (jamais exposée). */
export function record(id, ms, error, key) {
  const type = error ? category(error) : null, now = Date.now();
  const list = recent.get(id) ?? [];
  list.push({ at: now, ms, type, sys: systemFault(type, error), who: who(key) });
  while (list.length && (list[0].at < now - WINDOW || list.length > MAX)) list.shift();
  recent.set(id, list);
  const t = totals.get(id) ?? { calls: 0, errors: {}, sys: 0 };
  t.calls++; if (type) t.errors[type] = (t.errors[type] ?? 0) + 1; if (systemFault(type, error)) t.sys++;
  totals.set(id, t);
}

const reasonOf = (e) => {
  const code = e?.cause?.code ?? e?.code ?? "";
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "délai dépassé";
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return "nom introuvable (DNS)";
  if (/ECONNREFUSED/.test(code)) return "connexion refusée";
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code)) return "certificat refusé";
  return "injoignable";
};

/** Sonde un système : une requête HEAD sans identifiant vers la racine de son adresse (jamais le chemin MCP lui-même, qu'un
 *  serveur SSE pourrait garder ouvert). */
export async function probe(c) {
  const t0 = Date.now();
  try {
    await fetch(new URL(c.probeUrl).origin + "/", { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
    probes.set(c.id, { at: t0, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    probes.set(c.id, { at: t0, ok: false, ms: Date.now() - t0, reason: reasonOf(e) });
  }
}

/** Démarre la sonde : un passage immédiat s'il tombe dans les heures de sonde, puis toutes les 10 minutes. */
export function start(connectors) {
  const targets = connectors.filter(probeable);
  const mode = probeMode();
  if (process.env.PROBE && !["off", "always", "hours"].includes(String(process.env.PROBE).trim().toLowerCase()) && mode === "hours") console.warn("[health] PROBE inconnu : vérification aux heures ouvrées");
  if (mode === "off" || !targets.length) return;
  const tick = () => (mode === "always" || inProbeHours() ? Promise.all(targets.map(probe)) : null);
  tick();
  setInterval(tick, EVERY).unref();
}

const p95 = (values) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.ceil(0.95 * s.length) - 1)] : null; };

/** État d'un système : simulé, injoignable, erreurs, lent, ok ou inconnu (aucun appel récent et sonde en pause). Jamais l'heure
 *  d'un appel ni un volume : sur un système à un seul utilisateur, ce serait suivre son activité. */
export function status(c, now = Date.now()) {
  if (c.mock) return { state: "simule" };
  const calls = (recent.get(c.id) ?? []).filter((x) => x.at >= now - WINDOW && x.type !== "user"); // erreurs d'usage : ni au numérateur ni au dénominateur
  const ok = calls.filter((x) => !x.type), sys = calls.filter((x) => x.sys);
  const pr = probes.get(c.id), fresh = pr && pr.at >= now - FRESH;
  const out = { p95: ok.length >= MIN_CALLS ? p95(ok.map((x) => x.ms)) : null,
    probe: fresh ? { at: new Date(pr.at).toISOString(), ok: pr.ok, ms: pr.ms, reason: pr.reason } : null };
  if (fresh && !pr.ok && !ok.some((x) => x.at > pr.at)) return { state: "injoignable", ...out }; // un appel réussi depuis la sonde l'emporte
  if (calls.length >= MIN_CALLS && sys.length / calls.length > 0.2 && new Set(sys.map((x) => x.who)).size >= 2)
    return { state: sys.filter((x) => x.type === "unreachable" || x.type === "timeout").length > sys.length / 2 ? "injoignable" : "erreurs", ...out };
  if (out.p95 != null && out.p95 > SLOW_MS) return { state: "lent", ...out };
  return { state: calls.length || fresh ? "ok" : "inconnu", ...out };
}

/** Compteurs depuis le démarrage et dernière sonde, pour /metrics. */
export const counters = (id) => ({ ...(totals.get(id) ?? { calls: 0, errors: {}, sys: 0 }), probe: probes.get(id) ?? null });

/** Remise à zéro (tests). */
export const reset = () => { probes.clear(); recent.clear(); totals.clear(); };
