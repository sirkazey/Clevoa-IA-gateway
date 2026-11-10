// Couche sémantique (1.8, expérimental) : dictionnaire de données servi par l'outil clevoa_dictionnaire. Il décrit les données
// (objets, champs, valeurs, pièges de lecture) et ne définit aucun indicateur : définitions et méthodes vont dans les skills.
// Deux couches : générique (generique.js, dans le dépôt) et propre au client (SEMANTICS_FILE : fichier JSON monté dans le conteneur,
// propriété du client, jamais dans le dépôt). Le fichier est lu et validé au démarrage ; la couche client complète et prime :
// un objet de même identifiant remplace celui de la couche générique. Le chemin du fichier n'est jamais renvoyé à l'assistant.
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { OBJETS, REGLES, SOURCES, NOTE_SAGE } from "./generique.js";

const MAX_FILE = 2 * 1024 * 1024;
const DOCS = ["dropbox", "sharepoint"];

/** Texte comparable : minuscules, sans accents, apostrophes typographiques ramenées à ', espaces réduits. */
export const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ").trim();

// ---------- Format du fichier client (strict : une clé inconnue est une faute de frappe, refusée au démarrage)
const txt = (max = 500) => z.string().trim().min(1).max(max);
const list = (max = 100, item = txt(200)) => z.array(item).max(max);
const champ = z.object({ champ: txt(80).nullable().optional(), sens: txt() }).strict();
const objet = z.object({
  id: z.string().regex(/^[\w.-]{1,80}$/, "identifiant d'objet : lettres, chiffres, _ . - (80 au plus)"),
  systeme: z.enum(["sagex3", "salesforce"]),
  nom: txt(120), synonymes: list(30).optional(), usage: txt().optional(),
  champs: z.array(champ).max(200).optional(), liens: list(30, txt()).optional(), pieges: list(30, txt()).optional(), questions: list(10, txt()).optional(),
}).strict();
const classeur = z.object({
  contenu: txt(300), fichier: txt(200), systeme: z.enum(DOCS), chemin: txt(500), site: txt(200).optional(),
  dependances: list(30, txt(500)).optional(), miseAJour: txt(300).optional(),
}).strict();
export const SCHEMA = z.object({
  version: z.literal(1),
  nom: txt(120).optional(), // libellé de la couche (ex. nom de la société), affiché à l'assistant
  societes: z.array(z.object({ code: txt(40), nom: txt(120), devise: txt(10).optional(),
    sites: z.array(z.object({ code: txt(40), nom: txt(120), role: txt(200).optional() }).strict()).max(200).optional() }).strict()).max(100).optional(),
  champsSpecifiques: z.array(z.object({ objet: txt(80), champ: txt(80), sens: txt() }).strict()).max(500).optional(),
  objets: z.array(objet).max(200).optional(), // objets Salesforce personnalisés, représentations Sage X3 spécifiques
  regles: list(100, txt(1000)).optional(), // règles de lecture des données de l'instance, en phrases
  classeurs: z.array(classeur).max(300).optional(), // carte des classeurs de référence et de leurs liens
}).strict();

/** Erreur de validation lisible : « objets[2].nom : … ». */
const where = (path) => path.reduce((s, p) => (typeof p === "number" ? `${s}[${p}]` : s ? `${s}.${String(p)}` : String(p)), "") || "racine";

/** Lit et valide SEMANTICS_FILE ; lève une erreur au message clair (le démarrage s'arrête). Vide = couche générique seule. */
export function loadClient(file) {
  if (!file) return null;
  if (/\.ya?ml$/i.test(file)) throw new Error("format YAML non pris en charge dans cette version : fournir le fichier en JSON");
  let raw;
  try {
    if (statSync(file).size > MAX_FILE) throw new Error(`fichier de plus de ${MAX_FILE / 1024 / 1024} Mo`);
    raw = readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (e) { throw new Error(e.code === "ENOENT" ? "fichier introuvable (volume monté ?)" : e.code ? `lecture impossible (${e.code})` : e.message); }
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error(`JSON invalide (${e.message})`); }
  const r = SCHEMA.safeParse(data);
  if (!r.success) throw new Error(r.error.issues.slice(0, 5).map((i) => `${where(i.path)} : ${i.message}`).join(" ; "));
  const c = r.data;
  // Référence croisée : un champ spécifique doit viser un objet connu (couche générique ou objets du fichier).
  const ids = new Set([...OBJETS.map((o) => o.id), ...(c.objets ?? []).map((o) => o.id)]);
  const unknown = (c.champsSpecifiques ?? []).map((x, i) => [`champsSpecifiques[${i}].objet`, x.objet]).filter(([, id]) => !ids.has(id));
  if (unknown.length) throw new Error(`objet inconnu : ${unknown.slice(0, 5).map(([p, id]) => `${p} = ${id}`).join(" ; ")} (objets connus : ceux de la couche générique et ceux déclarés dans objets)`);
  return c;
}

/** Dictionnaire fusionné : couche client d'abord (elle prime), puis la couche générique non remplacée. */
export function build(client) {
  const tag = (o, origine) => ({ ...o, origine });
  const cObjets = (client?.objets ?? []).map((o) => tag(o, "client"));
  const objets = [...cObjets, ...OBJETS.filter((o) => !cObjets.some((x) => x.id === o.id)).map((o) => tag(o, "generique"))]
    .map((o) => {
      const extra = (client?.champsSpecifiques ?? []).filter((x) => x.objet === o.id).map((x) => ({ champ: x.champ, sens: x.sens, source: "client" }));
      return extra.length ? { ...o, champs: [...extra, ...(o.champs ?? []).filter((x) => !extra.some((e) => e.champ === x.champ))] } : o;
    });
  return {
    nom: client?.nom ?? null, client: !!client, objets,
    regles: [...(client?.regles ?? []), ...REGLES], // chaîne, ou [systeme, texte] pour une règle propre à un connecteur
    societes: client?.societes ?? [], classeurs: client?.classeurs ?? [],
  };
}

const words = (q) => new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
/** Correspondance : sous-chaîne, ou mot entier pour une requête courte (« CA » ne doit pas trouver « facture »). */
const matcher = (q) => { const n = norm(q), re = n.length <= 3 ? words(n) : null; return (s) => (re ? re.test(norm(s)) : norm(s).includes(n)); };

/**
 * Réponse de l'outil clevoa_dictionnaire.
 * @param g        dictionnaire fusionné (build)
 * @param enabled  identifiants des connecteurs proposés (CONNECTORS_ENABLED, production)
 * @param sage     structure Sage X3 déjà en cache pour ce collaborateur ({ representations, missing, denied, broken }) ou undefined
 */
export function answer(g, { terme, objet } = {}, enabled = [], sage) {
  const on = new Set(enabled);
  const objets = g.objets.filter((o) => on.has(o.systeme));
  const classeurs = g.classeurs.filter((b) => on.has(b.systeme));
  const couche = g.client ? `générique et propre à ${g.nom ?? "l'entreprise"} (la couche propre à l'entreprise prime)` : "générique seulement (aucune couche propre à l'entreprise configurée)";

  // Disponibilité Sage X3 : seulement d'après la structure déjà en cache (aucun appel) ; sinon, renvoi vers sagex3_representations.
  const status = (id) => {
    if (!sage) return undefined;
    if (sage.representations?.includes(id)) return "publiée et lisible";
    if (sage.missing?.includes(id)) return "absente de cette instance (404)";
    if (sage.denied?.includes(id)) return "interdite à ce collaborateur (403)";
    if (sage.broken?.includes(id)) return "en erreur côté Sage";
    return "non vérifiée (hors SAGE_REPRESENTATIONS) : essayer sagex3_describe";
  };
  const withStatus = (o) => (o.systeme === "sagex3" && sage ? { ...o, disponibilite: status(o.id) } : o);
  const sageNote = on.has("sagex3") ? (sage ? NOTE_SAGE : `${NOTE_SAGE} Disponibilité non vérifiée dans cette session : appeler sagex3_representations.`) : undefined;
  const regles = g.regles.filter((r) => typeof r === "string" || on.has(r[0])).map((r) => (typeof r === "string" ? r : r[1]));
  const common = { couche, regles_lecture: regles, ...(sageNote && { note_sage_x3: sageNote }) };

  if (objet) {
    const k = norm(objet);
    const o = objets.find((x) => norm(x.id) === k || norm(x.nom) === k || (x.synonymes ?? []).some((s) => norm(s) === k));
    if (!o) return { objet, resultat: `objet inconnu ou non proposé sur cette instance ; objets disponibles : ${objets.map((x) => x.id).join(", ")}`, ...common };
    return { objet: withStatus(o), sources_des_champs: SOURCES, ...common };
  }
  if (terme) {
    const hit = matcher(terme);
    const o = objets.filter((x) => [x.id, x.nom, ...(x.synonymes ?? []), ...(x.questions ?? [])].some(hit)).map(withStatus);
    const b = classeurs.filter((x) => [x.contenu, x.fichier].some(hit));
    const s = g.societes.filter((x) => [x.code, x.nom, ...(x.sites ?? []).flatMap((y) => [y.code, y.nom])].some(hit));
    if (!o.length && !b.length && !s.length)
      return { terme, resultat: "aucune entrée", objets_connus: objets.map((x) => x.id), ...common };
    return { terme, objets: o, ...(o.length && { sources_des_champs: SOURCES }), ...(b.length && { classeurs: b }), ...(s.length && { societes: s }), ...common };
  }
  return {
    sommaire: "Dictionnaire de données : appeler clevoa_dictionnaire avec terme (ex. « facture client », « commande », « encours autorisé ») ou objet (ex. SINVOICE, Opportunity). Il décrit les données et ne définit aucun indicateur.",
    objets: objets.map((x) => `${x.id} (${x.nom})`),
    ...(classeurs.length && { classeurs: classeurs.map((x) => x.fichier) }),
    ...(g.societes.length && { societes: g.societes.map((x) => `${x.code} (${x.nom})`) }),
    ...common,
  };
}
