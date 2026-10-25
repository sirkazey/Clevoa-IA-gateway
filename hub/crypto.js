// Chiffrement au repos et pseudonymes, partagés par users.json (store.js), la base d'exploitation (db.js) et l'outil
// d'administration (admin.js). AES-256-GCM avec une clé maîtresse dérivée d'ENCRYPTION_KEY ; aucun effet de bord à l'import.
import { randomBytes, createHash, createHmac, createCipheriv, createDecipheriv } from "node:crypto";

const SECRET = process.env.ENCRYPTION_KEY || "";
/** Vrai si ENCRYPTION_KEY est utilisable (32 caractères au moins, ex. openssl rand -hex 32). */
export const keyOk = SECRET.length >= 32;
const MASTER = createHash("sha256").update(SECRET).digest(); // 32 octets = AES-256

/** Chiffre un texte : "enc1:<iv>:<tag>:<données>" en base64. IV aléatoire à chaque écriture. */
export function encrypt(text) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", MASTER, iv, { authTagLength: 16 });
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return ["enc1", iv, c.getAuthTag(), data].map((p, i) => (i ? p.toString("base64") : p)).join(":");
}
export function decrypt(blob) {
  const [, iv, tag, data] = blob.split(":").map((p, i) => (i ? Buffer.from(p, "base64") : p));
  const d = createDecipheriv("aes-256-gcm", MASTER, iv, { authTagLength: 16 }); d.setAuthTag(tag); // tag de 16 octets exigé : un tag tronqué est refusé
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

/** Pseudonyme stable et non réversible (HMAC avec la clé maîtresse) : compter ou relier des appels sans exposer une identité. */
export const pseudonym = (text) => createHmac("sha256", MASTER).update(`pseudonyme:${text}`).digest("base64url").slice(0, 22);
