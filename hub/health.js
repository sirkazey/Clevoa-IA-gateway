// État des systèmes desservis par le hub, affiché sur le portail et exposé à la supervision (/metrics). Sans aucun identifiant :
// - sonde : une requête HEAD vers l'adresse de chaque système réel, toutes les 10 minutes, du lundi au vendredi de 7 h à 19 h
//   (heure du serveur, TZ). N'importe quelle réponse HTTP, 401, 403 ou 405 compris, prouve que le système est joignable ; un échec
//   DNS, TLS, une connexion refusée ou un délai dépassé le dit injoignable. Aucun en-tête d'authentification, aucune redirection suivie ;
// - appels réels des collaborateurs sur la dernière heure : part d'erreurs du système et temps de réponse.
// Le portail n'affiche qu'un état et un temps de réponse, jamais un volume ni une identité. PROBE=off désactive la sonde,
// PROBE=always la fait tourner à toute heure (essai d'installation).
import { category } from "./telemetry.js";

const EVERY = 10 * 60_000, TIMEOUT = 5_000, WINDOW = 3600_000, FRESH = 25 * 60_000, MAX = 5000;
const SLOW_MS = Number(process.env.SLOW_MS || 10_000); // p95 au-delà duquel un système est « lent »
export const PROBE_HOURS = "du lundi au vendredi, de 7 h à 19 h";
const probes = new Map(); // id -> { at, ok, ms, reason }
const recent = new Map(); // id -> [{ at, ms, type }] sur la dernière heure
const totals = new Map(); // id -> { calls, errors: { type: n } } depuis le démarrage (compteurs Prometheus)

/** Vrai pendant les heures de sonde : lundi à vendredi, 7 h à 19 h, heure locale du serveur. */
export const inProbeHours = (d = new Date()) => d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 7 && d.getHours() < 19;

/** Un système est sondé s'il est réel, configuré et a une adresse : jamais un simulateur. */
export const probeable = (c) => !c.mock && !!c.probeUrl && !!(c.apiKey || c.oauth?.clientId);

/** Enregistre un appel d'outil : durée et type d'erreur (jamais le message). */
export function record(id, ms, error) {
  const type = error ? category(error) : null, now = Date.now();
  const list = recent.get(id) ?? [];
  list.push({ at: now, ms, type });
  while (list.length && (list[0].at < now - WINDOW || list.length > MAX)) list.shift();
  recent.set(id, list);
  const t = totals.get(id) ?? { calls: 0, errors: {} };
  t.calls++; if (type) t.errors[type] = (t.errors[type] ?? 0) + 1;
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

/** Sonde un système : une requête HEAD sans identifiant. */
export async function probe(c) {
  const t0 = Date.now();
  try {
    await fetch(c.probeUrl, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
    probes.set(c.id, { at: t0, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    probes.set(c.id, { at: t0, ok: false, ms: Date.now() - t0, reason: reasonOf(e) });
  }
}

/** Démarre la sonde : un passage immédiat s'il tombe dans les heures de sonde, puis toutes les 10 minutes. */
export function start(connectors) {
  const targets = connectors.filter(probeable);
  if (process.env.PROBE === "off" || !targets.length) return;
  const tick = () => (process.env.PROBE === "always" || inProbeHours() ? Promise.all(targets.map(probe)) : null);
  tick();
  setInterval(tick, EVERY).unref();
}

const p95 = (values) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] : null; };

/** État d'un système : simulé, injoignable, erreurs, lent, ok ou inconnu (aucun appel récent et sonde en pause). */
export function status(c, now = Date.now()) {
  if (c.mock) return { state: "simule" };
  const calls = (recent.get(c.id) ?? []).filter((x) => x.at >= now - WINDOW);
  const ok = calls.filter((x) => !x.type), sys = calls.filter((x) => x.type && x.type !== "user");
  const pr = probes.get(c.id), fresh = pr && pr.at >= now - FRESH;
  const out = { p95: p95(ok.map((x) => x.ms)), lastOk: ok.length ? new Date(ok.at(-1).at).toISOString() : null,
    probe: fresh ? { at: new Date(pr.at).toISOString(), ok: pr.ok, ms: pr.ms, reason: pr.reason } : null };
  if (fresh && !pr.ok) return { state: "injoignable", ...out };
  if (calls.length >= 5 && sys.length / calls.length > 0.2)
    return { state: sys.filter((x) => x.type === "unreachable" || x.type === "timeout").length > sys.length / 2 ? "injoignable" : "erreurs", ...out };
  if (ok.length >= 5 && out.p95 > SLOW_MS) return { state: "lent", ...out };
  return { state: calls.length || fresh ? "ok" : "inconnu", ...out };
}

/** Compteurs depuis le démarrage et dernière sonde, pour /metrics. */
export const counters = (id) => ({ ...(totals.get(id) ?? { calls: 0, errors: {} }), probe: probes.get(id) ?? null });

/** Remise à zéro (tests). */
export const reset = () => { probes.clear(); recent.clear(); totals.clear(); };
