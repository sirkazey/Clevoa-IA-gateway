// Inscription automatique des assistants (CIMD : Client ID Metadata Documents, MCP 2025-11-25, draft-ietf-oauth-client-id-
// metadata-document), 1.8, expérimental. L'assistant se présente par une adresse https (son client_id) qui sert un document JSON :
// nom, adresses de retour, méthode d'authentification. Le hub n'accepte que les adresses de sa liste blanche, récupère le document
// sans jamais suivre de redirection ni joindre une adresse réservée (SSRF), le met en cache, et en tire un client PUBLIC (PKCE, sans
// secret). Aucun secret n'est confié à l'assistant ; le hub présente à Entra sa propre inscription (online.js).
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";

/** Documents publiés par les assistants, relevés le 06/11/2026, et la seule adresse de retour admise pour chacun. Claude Code
 *  (https://claude.ai/oauth/claude-code-client-metadata) est exclu : retour en boucle locale, usurpable par tout programme local. */
export const KNOWN = {
  "https://claude.ai/oauth/mcp-oauth-client-metadata": ["https://claude.ai/api/mcp/auth_callback"],
  "https://chatgpt.com/oauth/client.json": ["https://chatgpt.com/connector_platform_oauth_redirect"],
};
export const MAX_BYTES = 5 * 1024; // taille de lecture recommandée par le brouillon (§ 10.11)
const TIMEOUT_MS = 5000, DEFAULT_TTL = 300, MAX_TTL = 3600; // secondes ; Claude et ChatGPT annoncent max-age=300

/** Refus définitif (document absent, invalide, adresse interdite) : invalid_client. Les autres erreurs sont passagères. */
export class Refused extends Error {}

// Adresses réservées (RFC 6890 et suivantes) : jamais jointes, même si le DNS d'un nom de la liste blanche y mène.
const reserved = new BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) reserved.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) reserved.addSubnet(a, p, "ipv6");
/** Adresse IP réservée (privée, boucle locale, lien local, documentation, multidiffusion…) ou illisible. */
export function isReserved(ip) {
  const v = isIP(ip);
  if (v === 0) return true;
  const mapped = v === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); // IPv4 encapsulée : jugée comme IPv4 (BlockList ne mêle pas les deux)
  return mapped ? isReserved(mapped[1]) : reserved.check(ip, v === 4 ? "ipv4" : "ipv6");
}

/** Boucle locale en http : tolérée seulement pour les tests et un poste de développement (ONLINE_CIMD_ALLOW_LOOPBACK=1, refusé en
 *  production par online.js), comme le permet le brouillon (§ 10.7). */
const devLoopback = (u, loopback) => loopback && u.protocol === "http:" && u.hostname === "127.0.0.1";

/** Adresse de client_id conforme au brouillon (§ 3) : https, chemin autre que « / », ni identifiants, ni fragment, ni paramètres,
 *  ni segment « . » ou « .. », sous forme canonique (comparaison par simple égalité de chaînes). Renvoie le motif du refus, ou null. */
export function checkId(id, { loopback = false } = {}) {
  let u;
  try { u = new URL(id); } catch { return "adresse illisible"; }
  if (u.protocol !== "https:" && !devLoopback(u, loopback)) return "https seulement";
  if (u.username || u.password) return "identifiants interdits dans l'adresse";
  if (u.pathname === "/" || !u.pathname) return "chemin requis";
  if (u.search || id.includes("?")) return "paramètres interdits";
  if (id.includes("#")) return "fragment interdit";
  if (u.href !== id) return "adresse non canonique (segment . ou .., casse, port par défaut)";
  return null;
}

/** ONLINE_CIMD_CLIENTS : vide, 0 ou off = désactivé ; on ou 1 = Claude et ChatGPT (KNOWN) ; sinon la liste des adresses. */
export function parseClients(value = "") {
  const v = value.trim();
  if (["", "0", "off"].includes(v.toLowerCase())) return [];
  if (["1", "on"].includes(v.toLowerCase())) return Object.keys(KNOWN);
  return [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** GET du document : ni redirection suivie, ni cookie, ni adresse réservée (vérifiée sur chaque adresse résolue, au moment même de la
 *  connexion : pas de fenêtre de « DNS rebinding »), délai total et taille bornés. */
export function fetchDocument(id, { loopback = false, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(id), local = devLoopback(u, loopback);
    if (u.protocol !== "https:" && !local) return reject(new Refused("https seulement"));
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isReserved(host) && !local) return reject(new Refused("adresse IP réservée"));
    const lookup = (hostname, opts, cb) => dnsLookup(hostname, { ...opts, all: true }, (err, list) => {
      if (err) return cb(err);
      if (!list.length || list.some((a) => isReserved(a.address))) return cb(new Refused(`${hostname} mène à une adresse IP réservée`));
      return opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
    });
    const req = (local ? http : https).request(u, { method: "GET", lookup, headers: { Accept: "application/json", "User-Agent": "Clevoa-AI-Gateway" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        const s = res.statusCode;
        return finish(s >= 500 || s === 429 ? new Error(`statut ${s}`) : new Refused(`statut ${s}${s >= 300 && s < 400 ? " (redirection non suivie)" : ""}`));
      }
      if (Number(res.headers["content-length"]) > maxBytes) { res.destroy(); return finish(new Refused(`document trop gros (plus de ${maxBytes} octets)`)); }
      const parts = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(); finish(new Refused(`document trop gros (plus de ${maxBytes} octets)`)); } else parts.push(c);
      });
      res.on("end", () => finish(null, { body: Buffer.concat(parts).toString("utf8"), cacheControl: String(res.headers["cache-control"] || "") }));
      res.on("error", (e) => finish(e));
    });
    const timer = setTimeout(() => { req.destroy(); finish(new Error(`délai de ${timeoutMs} ms dépassé`)); }, timeoutMs);
    let done = false;
    function finish(err, value) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    }
    req.on("error", (e) => finish(e));
    req.end();
  });
}

/** Durée de cache (s) : en-têtes HTTP respectés (no-store, no-cache, max-age), plafonnés à une heure ; 5 min sans indication. */
export function ttlOf(cacheControl) {
  if (/\b(no-store|no-cache)\b/i.test(cacheControl)) return 0;
  const m = /\bmax-age=(\d+)/i.exec(cacheControl);
  return m ? Math.min(Number(m[1]), MAX_TTL) : DEFAULT_TTL;
}

/** Client OAuth tiré du document, ou Refused. Adresses de retour retenues : celles du document qui sont aussi connues du hub
 *  (KNOWN pour cet assistant, ou ONLINE_REDIRECT_URIS). Client toujours public : ni secret, ni méthode à secret partagé (§ 4.1). */
export function toClient(id, doc, redirects = []) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Refused("document JSON attendu");
  if (doc.client_id !== id) throw new Refused("client_id du document différent de son adresse");
  if (typeof doc.client_name !== "string" || !doc.client_name.trim()) throw new Refused("client_name absent");
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || doc.redirect_uris.some((r) => typeof r !== "string")) throw new Refused("redirect_uris absent ou invalide");
  if ("client_secret" in doc || "client_secret_expires_at" in doc || /^client_secret_/.test(doc.token_endpoint_auth_method || "")) throw new Refused("secret partagé interdit dans un document CIMD");
  if (doc.grant_types !== undefined && !(Array.isArray(doc.grant_types) && doc.grant_types.includes("authorization_code"))) throw new Refused("grant_types sans authorization_code");
  if (doc.response_types !== undefined && !(Array.isArray(doc.response_types) && doc.response_types.includes("code"))) throw new Refused("response_types sans code");
  const known = new Set([...(KNOWN[id] ?? []), ...redirects]);
  return { client_id: id, client_name: doc.client_name.slice(0, 100), redirect_uris: doc.redirect_uris.filter((r) => known.has(r)),
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
}

/** Registre des clients CIMD : liste blanche stricte (égalité de chaînes), document mis en cache, une seule récupération à la fois
 *  par adresse. Ni erreur ni document invalide en cache (§ 6.2). getClient : client, undefined (refus définitif) ou exception
 *  (indisponibilité passagère : l'assistant pourra réessayer). */
export function createRegistry({ clients = [], redirects = [], loopback = false, log = (m) => console.error(m), now = Date.now, fetch = fetchDocument } = {}) {
  const allowed = new Set(clients), cache = new Map(), inflight = new Map();
  async function load(id) {
    try {
      const { body, cacheControl } = await fetch(id, { loopback });
      let doc;
      try { doc = JSON.parse(body); } catch { throw new Refused("JSON illisible"); }
      const client = toClient(id, doc, redirects), ttl = ttlOf(cacheControl);
      if (ttl > 0) cache.set(id, { client, until: now() + ttl * 1000 }); else cache.delete(id);
      return client;
    } catch (e) {
      cache.delete(id);
      if (e instanceof Refused) { log(`[online] document CIMD refusé (${id}) : ${e.message}`); return undefined; }
      log(`[online] document CIMD indisponible (${id}) : ${e.message}`);
      throw e;
    }
  }
  return {
    allowed: (id) => allowed.has(id),
    async getClient(id) {
      if (!allowed.has(id)) return undefined;
      const hit = cache.get(id);
      if (hit && hit.until > now()) return hit.client;
      if (!inflight.has(id)) inflight.set(id, load(id).finally(() => inflight.delete(id)));
      return inflight.get(id);
    },
  };
}

/** Table à usage unique et à durée de vie bornée (autorisations en cours, codes du hub), plafonnée en mémoire : au-delà de `max`,
 *  les plus anciennes entrées tombent. Perdue au redémarrage : le collaborateur relance la connexion. */
export function onceMap({ ttlMs, max = 5000, now = Date.now }) {
  const m = new Map();
  return {
    put(k, v) {
      if (m.size >= max) for (const [key, e] of m) { if (e.until <= now() || m.size >= max) m.delete(key); else break; }
      m.set(k, { v, until: now() + ttlMs });
    },
    take(k) {
      const e = m.get(k);
      m.delete(k);
      return e && e.until > now() ? e.v : undefined;
    },
    get size() { return m.size; },
  };
}
