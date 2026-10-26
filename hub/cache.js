// Mini-cache en mémoire de la STRUCTURE des tables, par utilisateur et par système.
// Il expire chaque nuit à CUTOFF h et se recharge à la demande avec le jeton de l'appelant :
// pas de compte technique, chacun voit la structure selon ses propres droits.
// Les données métier ne sont jamais mises en cache.
const CUTOFF = 3; // heure locale du conteneur (TZ)
const mem = new Map(); // "key:system" -> { at, data } ; data : la promesse du chargement, partagée par les appels simultanés

const lastCutoff = () => { const d = new Date(); d.setHours(CUTOFF, 0, 0, 0); if (d > Date.now()) d.setDate(d.getDate() - 1); return d; };

/** Renvoie la structure en cache si elle date d'après la dernière coupure nocturne, sinon la recharge via `load()`. Un chargement en
 *  échec n'est pas gardé ; les entrées d'avant la coupure (clés régénérées ou supprimées comprises) sont retirées au passage. */
export function cachedSchema(key, system, load) {
  const id = `${key}:${system}`, hit = mem.get(id), cutoff = lastCutoff();
  if (hit && hit.at > cutoff) return hit.data;
  for (const [k, v] of mem) if (v.at <= cutoff) mem.delete(k);
  const entry = { at: new Date(), data: Promise.resolve().then(load) };
  mem.set(id, entry);
  entry.data.catch(() => { if (mem.get(id) === entry) mem.delete(id); });
  return entry.data;
}
/** Oublie la structure d'un collaborateur pour un système : déconnexion, autre compte, nouvel identifiant. */
export const forget = (key, system) => { mem.delete(`${key}:${system}`); };
