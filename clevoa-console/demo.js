// Données de démonstration (CONSOLE_DEMO=1) : trois installations fictives sur 30 jours, au format exact de la table DynamoDB,
// pour essayer la console et la tester sans compte AWS. La page affiche un bandeau « démonstration » quand elles sont servies.
import { STATE } from "../clevoa-backend/handler.js";

const zero = () => ({ auth: 0, quota: 0, timeout: 0, unreachable: 0, other: 0, user: 0 });
/** Générateur pseudo-aléatoire déterministe : la démonstration est identique d'un lancement à l'autre. */
function rng(seed) { let x = seed; return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648); }

function installation({ client, id, env, version, seats, connectors, base, now, rand, incident, silentHours = 0 }) {
  const pk = `${client}#${id}#${env}`, periods = [];
  const last = now - silentHours * 3600_000;
  for (let i = 30 * 4; i >= 0; i--) {
    const t = last - i * 6 * 3600_000;
    if (t > last) continue;
    const day = new Date(t).getUTCDay(), hour = new Date(t).getUTCHours();
    const busy = (day === 0 || day === 6 ? 0.15 : 1) * (hour >= 6 && hour <= 18 ? 1 : 0.2);
    const stats = {};
    for (const [c, w] of Object.entries(connectors)) {
      const calls = Math.round(base * w * busy * (0.7 + rand() * 0.6));
      if (!calls) continue;
      const errors = zero();
      errors.user = Math.round(calls * 0.02 * rand());
      errors.timeout = Math.round(calls * 0.01 * rand());
      if (incident && c === incident.connector && t >= now - incident.hours * 3600_000) errors[incident.type] = Math.round(calls * incident.rate);
      const users = Math.max(1, Math.min(seats, Math.round(seats * busy * (0.5 + rand() * 0.5))));
      const p50 = Math.round({ salesforce: 380, sagex3: 620, sharepoint: 290, dropbox: 340, myreport: 900 }[c] * (0.85 + rand() * 0.3));
      stats[c] = { calls, errors, users, authUsers: 0, p50, p95: Math.round(p50 * (2.2 + rand())) };
    }
    const requests = Object.values(stats).reduce((n, s) => n + s.calls, 0);
    periods.push({ pk, sk: `P#${new Date(t).toISOString()}`, since: new Date(t - 6 * 3600_000).toISOString(), version, requests, seats, stats });
  }
  const lastStats = periods.at(-1)?.stats ?? {};
  const incidents = [];
  if (incident) incidents.push(`erreurs:${incident.connector}`);
  if (silentHours > 14) incidents.push("silence");
  const state = { pk, sk: STATE, client, installation: id, env, version, seats, requests: periods.at(-1)?.requests ?? 0,
    connectors: Object.fromEntries(Object.keys(connectors).map((c) => [c, true])), lastSeen: new Date(last).toISOString(),
    firstSeen: periods[0]?.sk.slice(2), incidents, lastStats };
  return { state, periods };
}

/** Source de démonstration : même interface de lecture que le stockage DynamoDB du backend (list, get, history). */
export function demoSource(now = Date.now()) {
  const rand = rng(20261025);
  const all = [
    installation({ client: "charlois", id: "5d2c7a1e-90b4-4f6e-8a3d-2b1c0e9f7a64", env: "PRODUCTION", version: "1.3.2-rc.2", seats: 23, base: 60, now, rand,
      connectors: { salesforce: 1, sagex3: 1.4, sharepoint: 0.6, myreport: 0.3 }, incident: { connector: "sagex3", type: "unreachable", rate: 0.35, hours: 10 } }),
    installation({ client: "charlois-preprod", id: "67fd7c7b-73c4-4506-bd49-051fa600d04f", env: "PRE-PROD", version: "1.3.2-rc.2", seats: 4, base: 10, now, rand,
      connectors: { salesforce: 1, sagex3: 1, sharepoint: 1, dropbox: 1, myreport: 1 } }),
    installation({ client: "client-exemple", id: "0c8e3f52-7d41-4b9a-9e2f-6a5b4c3d2e1f", env: "PRODUCTION", version: "1.3.1", seats: 9, base: 25, now, rand,
      connectors: { salesforce: 1, sharepoint: 0.8 }, silentHours: 26 }),
  ];
  return {
    demo: true,
    async list() { return all.map((a) => a.state); },
    async get(pk) { return all.find((a) => a.state.pk === pk)?.state ?? null; },
    async history(pk, from = "") { return (all.find((a) => a.state.pk === pk)?.periods ?? []).filter((p) => p.sk >= `P#${from}`); },
  };
}
