// Outil d'administration, lancé dans le conteneur par l'administrateur (aucune route HTTP, rien d'exposé) :
//   docker exec mcp-hub-prod node admin.js disponibilite [--jours 30]
//   docker exec mcp-hub-prod node admin.js usage [--mois AAAA-MM]
//   docker exec mcp-hub-prod node admin.js audit [--depuis AAAA-MM-JJ] [--jusqua AAAA-MM-JJ] [--collaborateur <e-mail>] > audit.csv
// Lecture seule sur /data/hub.db. L'audit n'existe qu'avec AUDIT=on ; ses e-mails sont déchiffrés ici (ENCRYPTION_KEY du conteneur).
import { existsSync } from "node:fs";
import { keyOk } from "./crypto.js";
import * as db from "./db.js";

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name, def) => { const i = rest.indexOf(`--${name}`); return i >= 0 && rest[i + 1] ? rest[i + 1] : def; };
const fail = (m) => { console.error(m); process.exit(1); };
const SYSTEMS = ["salesforce", "sagex3", "sharepoint", "dropbox", "myreport"];

if (!["disponibilite", "usage", "audit"].includes(cmd)) fail("Commandes : disponibilite [--jours 30] · usage [--mois AAAA-MM] · audit [--depuis AAAA-MM-JJ] [--jusqua AAAA-MM-JJ] [--collaborateur e-mail]");
if (!keyOk) fail("ENCRYPTION_KEY absente : lancer la commande dans le conteneur du hub (docker exec).");
if (!existsSync(db.FILE)) fail(`Base d'exploitation absente (${db.FILE}) : le hub n'a pas encore démarré en 1.5 ou plus.`);
if (!db.open()) fail("Base d'exploitation illisible : voir le journal du hub.");

if (cmd === "disponibilite") {
  const days = Number(arg("jours", 30));
  console.log(`Disponibilité sur ${days} jours (part des mesures « opérationnel » ou « lent », une mesure toutes les 10 minutes)`);
  for (const s of SYSTEMS) { const a = db.availability(s, days); console.log(`${s.padEnd(12)} ${a.pct == null ? "pas de mesure" : `${String(a.pct).padStart(5)} %  (${a.samples} mesures)`}`); }
} else if (cmd === "usage") {
  const u = db.usage(arg("mois", undefined));
  console.log(`Usage de ${u.month} : ${u.activeUsers} collaborateur(s) actif(s)`);
  for (const r of u.systems) console.log(`${r.system.padEnd(12)} ${String(r.calls).padStart(8)} appels  ${String(r.errors).padStart(6)} erreurs système`);
} else {
  if (!db.AUDIT) console.error("Avertissement : AUDIT n'est pas activé (AUDIT=on) ; seules d'éventuelles lignes antérieures sont lues.");
  const day = (s, def) => { const t = s ? Date.parse(`${s}T00:00:00Z`) : def; if (Number.isNaN(t)) fail(`Date invalide : ${s} (AAAA-MM-JJ)`); return t; };
  const from = day(arg("depuis"), Date.now() - db.AUDIT_DAYS * 86_400_000), to = day(arg("jusqua"), Date.now()) + (arg("jusqua") ? 86_400_000 : 1);
  const who = arg("collaborateur", "").toLowerCase();
  const csv = (v) => (/[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  console.log("date;collaborateur;pseudonyme;systeme;outil;resultat;duree_ms");
  for (const r of db.auditRows(from, to)) if (!who || (r.who || "").toLowerCase() === who) console.log([new Date(r.at).toISOString(), r.who ?? "", r.user, r.system, r.tool, r.outcome, r.ms].map(csv).join(";"));
}
db.close();
