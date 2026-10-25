// Outil d'administration, lancé dans le conteneur par l'administrateur (aucune route HTTP, rien d'exposé) :
//   docker exec mcp-hub-prod node admin.js disponibilite [--jours 30]
//   docker exec mcp-hub-prod node admin.js usage [--mois AAAA-MM]
//   docker exec mcp-hub-prod node admin.js audit [--depuis AAAA-MM-JJ] [--jusqua AAAA-MM-JJ] [--collaborateur <e-mail>] > audit.csv
// Lecture seule sur /data/hub.db (ouverture en lecture seule : ni écriture, ni migration). L'audit n'existe qu'avec AUDIT=on ; ses
// e-mails sont déchiffrés ici (ENCRYPTION_KEY du conteneur). Le CSV neutralise les formules de tableur.
import { existsSync } from "node:fs";
import { keyOk } from "./crypto.js";
import * as db from "./db.js";

const [cmd, ...rest] = process.argv.slice(2);
const fail = (m) => { console.error(m); process.exit(1); };
/** Valeur de l'option --name ; option présente sans valeur (« --collaborateur "" » d'un script) : refus, jamais « tout ». */
const arg = (name, def) => {
  const i = rest.indexOf(`--${name}`); if (i < 0) return def;
  const v = rest[i + 1]; if (!v || v.startsWith("--")) fail(`Option --${name} sans valeur.`);
  return v;
};
const SYSTEMS = ["salesforce", "sagex3", "sharepoint", "dropbox", "myreport"];

if (!["disponibilite", "usage", "audit"].includes(cmd)) fail("Commandes : disponibilite [--jours 30] · usage [--mois AAAA-MM] · audit [--depuis AAAA-MM-JJ] [--jusqua AAAA-MM-JJ] [--collaborateur e-mail]");
if (!keyOk) fail("ENCRYPTION_KEY absente : lancer la commande dans le conteneur du hub (docker exec).");
if (!existsSync(db.FILE)) fail(`Base d'exploitation absente (${db.FILE}) : le hub n'a pas encore démarré en 1.5 ou plus.`);
if (!db.open(db.FILE, { readOnly: true })) fail("Base d'exploitation illisible : voir le journal du hub.");

if (cmd === "disponibilite") {
  const days = Number(arg("jours", 30));
  if (!Number.isInteger(days) || days < 1) fail("--jours : un nombre entier de jours, 1 au moins.");
  console.log(`Disponibilité sur ${days} jours (part des mesures « opérationnel » ou « lent », une mesure toutes les 10 minutes)`);
  for (const s of SYSTEMS) { const a = db.availability(s, days); console.log(`${s.padEnd(12)} ${a.pct == null ? "pas de mesure" : `${String(a.pct).padStart(5)} %  (${a.samples} mesures)`}`); }
} else if (cmd === "usage") {
  const m = arg("mois", undefined);
  if (m !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) fail("--mois : AAAA-MM, ex. 2026-09.");
  const u = db.usage(m);
  console.log(`Usage de ${u.month} : ${u.activeUsers} collaborateur(s) actif(s)`);
  for (const r of u.systems) console.log(`${r.system.padEnd(12)} ${String(r.calls).padStart(8)} appels  ${String(r.errors).padStart(6)} erreurs système`);
} else {
  if (!db.AUDIT) console.error("Avertissement : AUDIT n'est pas activé (AUDIT=on) ; seules d'éventuelles lignes antérieures sont lues.");
  // Dates en heure locale (TZ du conteneur) : --depuis 2026-10-01 commence le 1er octobre à 0 h, --jusqua inclut toute la journée.
  const day = (s, next = 0) => {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/), d = m && new Date(+m[1], +m[2] - 1, +m[3] + next);
    if (!m || new Date(+m[1], +m[2] - 1, +m[3]).getDate() !== +m[3]) fail(`Date invalide : ${s} (AAAA-MM-JJ)`); // 2026-02-30 refusé
    return d.getTime();
  };
  const from = arg("depuis") ? day(arg("depuis")) : Date.now() - db.AUDIT_DAYS * 86_400_000, to = arg("jusqua") ? day(arg("jusqua"), 1) : Date.now() + 1;
  const p2 = (n) => String(Math.abs(n)).padStart(2, "0");
  const stamp = (t) => { const d = new Date(t), o = -d.getTimezoneOffset(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${o < 0 ? "-" : "+"}${p2(Math.trunc(o / 60))}:${p2(o % 60)}`; };
  const who = arg("collaborateur", "").toLowerCase();
  // Une valeur qui commence par = + - @ (ou tabulation, retour chariot) serait exécutée comme formule par un tableur : préfixée d'une apostrophe.
  const csv = (v) => { const s = /^[=+\-@\t\r]/.test(String(v)) ? `'${v}` : String(v); return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  console.log("date;collaborateur;pseudonyme;systeme;outil;resultat;duree_ms");
  for (const r of db.auditRows(from, to)) if (!who || (r.who || "").toLowerCase() === who) console.log([stamp(r.at), r.who ?? "", r.user, r.system, r.tool, r.outcome, r.ms].map(csv).join(";"));
}
db.close();
