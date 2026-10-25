// Persistance minimale : un fichier chiffré AES-256-GCM dans le volume /data, déchiffré en mémoire seulement.
// users[key] = { email, sso: { sub, tid, upn, name, at }, assistantAt, salesforce: {tokens}, sagex3: {tokens}, sharepoint, dropbox, myreport }
// La "key" est le secret que l'utilisateur met dans son client MCP. La clé maîtresse vient de ENCRYPTION_KEY.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { keyOk, encrypt, decrypt, pseudonym } from "./crypto.js";

const DIR = process.env.DATA_DIR || "./data";
const FILE = `${DIR}/users.json`;
if (!keyOk) { console.error("[store] ENCRYPTION_KEY absente ou trop courte (32 caractères minimum, ex. openssl rand -hex 32)"); process.exit(1); }
mkdirSync(DIR, { recursive: true });

let db = { users: {} };
try {
  const raw = readFileSync(FILE, "utf8");
  db = JSON.parse(raw.startsWith("enc1:") ? decrypt(raw) : raw); // un ancien fichier en clair est rechiffré à la première écriture
} catch (e) { if (e.code !== "ENOENT") { console.error(`[store] users.json illisible (mauvaise ENCRYPTION_KEY ?) : ${e.message}`); process.exit(1); } }

/** Vrai pour une entrée qui vaut d'être conservée : identité SSO ou au moins un identifiant ; une clé anonyme sans rien n'est jamais persistée. */
const worthKeeping = (u) => !!u.sso || Object.values(u).some((v) => v && typeof v === "object" && (v.access_token || v.apiKey));
function save() {
  const users = Object.fromEntries(Object.entries(db.users).filter(([, u]) => worthKeeping(u)));
  writeFileSync(FILE + ".tmp", encrypt(JSON.stringify({ ...db, users })), { mode: 0o600 });
  renameSync(FILE + ".tmp", FILE); // écriture atomique, jamais en clair sur le disque
}

export const store = {
  // Object.hasOwn : refuse "__proto__" & co (sinon un jeton pourrait être partagé via le prototype).
  get: (key) => (typeof key === "string" && Object.hasOwn(db.users, key) && db.users[key]) || null,
  create() {
    const key = randomBytes(24).toString("base64url");
    db.users[key] = { createdAt: new Date().toISOString() }; // écrit sur disque au premier jeton seulement
    return key;
  },
  setTokens(key, system, tokens, email) {
    const u = store.get(key); if (!u) return;
    u[system] = { ...u[system], ...tokens, updatedAt: new Date().toISOString() };
    if (email && !u.email) u.email = email; // la première identité OAuth fait foi
    save();
  },
  /** Sièges : collaborateurs ayant connecté au moins un outil (jeton OAuth ou identifiant personnel), qu'ils s'en servent ou non. Un simple visiteur du portail ne compte pas. */
  seats: () => Object.values(db.users).filter((u) => Object.values(u).some((v) => v && typeof v === "object" && (v.access_token || v.apiKey))).length,
  clearTokens(key, system) {
    const u = store.get(key); if (!u) return;
    delete u[system]; save();
  },
  // ---- SSO : une identité Entra (oid + locataire) ↔ une clé ----
  findSso: (sub, tid) => Object.keys(db.users).find((k) => db.users[k].sso?.sub === sub && db.users[k].sso?.tid === tid) ?? null,
  setSso(key, { sub, tid, upn, name, email }) {
    const u = store.get(key); if (!u) return;
    u.sso = { sub, tid, upn, name, at: new Date().toISOString() };
    if (email) u.email = email; // l'identité Entra fait foi
    save();
  },
  /** Identifiant de l'installation pour la télémétrie : UUID aléatoire créé au premier appel, conservé dans le fichier chiffré
   *  (il suit donc les sauvegardes et restaurations). Ne dit rien du client ni d'un collaborateur. */
  installationId() {
    if (!db.installation) { db.installation = randomUUID(); save(); }
    return db.installation;
  },
  /** Pseudonyme stable du collaborateur pour l'usage et l'audit (db.js) : son identité SSO si elle existe, sinon sa clé. */
  pseudonym(key) {
    const u = store.get(key);
    return pseudonym(u?.sso ? `sso:${u.sso.tid}:${u.sso.sub}` : `cle:${key}`);
  },
  remove(key) { if (store.get(key)) { delete db.users[key]; save(); } },
  /** Oublie les clés anonymes sans identifiant plus vieilles que maxAgeMs (départs SSO abandonnés) ; rien n'est écrit, elles n'ont jamais été persistées. */
  purge(maxAgeMs) {
    const limit = Date.now() - maxAgeMs;
    for (const [k, u] of Object.entries(db.users)) if (!worthKeeping(u) && Date.parse(u.createdAt) < limit) delete db.users[k];
  },
  /** Jour (AAAA-MM-JJ, pas l'heure) du dernier appel d'un assistant avec cette clé : le portail affiche « Assistant : branché » d'après
   *  ce fait, plus d'après le seul clic sur « Copier ». Écrit au plus une fois par jour et par collaborateur ; une clé anonyme reste en mémoire. */
  assistantSeen(key, day = new Date().toISOString().slice(0, 10)) {
    const u = store.get(key); if (!u || u.assistantAt === day) return;
    u.assistantAt = day;
    if (worthKeeping(u)) save();
  },
  /** Nouvelle clé pour le même collaborateur : l'ancienne est révoquée sur-le-champ (clients MCP et portail), identité et jetons suivent. */
  rotate(key) {
    const u = store.get(key); if (!u) return null;
    const fresh = randomBytes(24).toString("base64url");
    delete u.assistantAt; // aucun assistant ne connaît encore la nouvelle clé
    db.users[fresh] = u; delete db.users[key]; save();
    return fresh;
  },
};
