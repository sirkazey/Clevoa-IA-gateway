// Résolution des noms pour les appels sortants du hub (fetch, openid-client, proxys MCP) : adresses IPv4 d'abord, puis IPv6, sans doublon.
// Pourquoi : l'image node:24-alpine résout par musl, qui garde au plus 48 adresses par nom en commençant par l'IPv6. Quand le DNS
// renvoie des réponses en double (constaté avec le DNS de Docker Desktop pour login.microsoftonline.com), les 48 places sont prises
// par l'IPv6 et l'IPv4 disparaît ; sans IPv6 dans le réseau Docker (cas par défaut), la connexion échoue en ENETUNREACH.
// Les deux familles sont demandées séparément puis fusionnées : IPv4 d'abord (réseau Docker par défaut), IPv6 ensuite (hôte IPv6 seul).
// Une famille imposée par l'appelant est respectée telle quelle.
import dns from "node:dns";

/** Enveloppe une fonction lookup(host, options, callback) de node:dns. */
export function ipv4First(lookup) {
  return function lookupIpv4First(host, options, callback) {
    if (typeof options === "function") [callback, options] = [options, {}];
    else if (typeof options === "number") options = { family: options };
    options ??= {};
    if (options.family && options.family !== 0) return lookup(host, options, callback);
    const found = { 4: null, 6: null };
    let pending = 2;
    for (const family of [4, 6]) {
      lookup(host, { ...options, family, all: true }, (err, list) => {
        found[family] = err ? [] : list;
        if (--pending) return;
        const seen = new Set();
        const all = [...found[4], ...found[6]].filter((a) => !seen.has(a.address) && seen.add(a.address));
        if (!all.length) return lookup(host, options, callback); // aucune des deux : l'erreur d'origine (ENOTFOUND…), inchangée
        if (options.all) callback(null, all);
        else callback(null, all[0].address, all[0].family);
      });
    }
  };
}

/** Installée une fois, au démarrage du hub et du diagnostic : node:net appelle dns.lookup à chaque connexion. */
export function install() {
  if (dns.lookup.name !== "lookupIpv4First") dns.lookup = ipv4First(dns.lookup);
}
