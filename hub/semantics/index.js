// Couche sémantique (1.8, expérimental) : glossaire métier servi par l'outil clevoa_glossaire.
// Deux couches : générique (generique.js, dans le dépôt) et propre au client (SEMANTICS_FILE : fichier JSON monté dans le conteneur,
// propriété du client, jamais dans le dépôt). Le fichier est lu et validé au démarrage ; la couche client complète et prime :
// un terme ou un objet de même nom remplace celui de la couche générique. Le chemin du fichier n'est jamais renvoyé à l'assistant.
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { OBJETS, TERMES, REGLES, SOURCES, NOTE_SAGE } from "./generique.js";

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
const terme = z.object({
  terme: txt(120), synonymes: list(30).optional(), definition: txt(1000),
  objets: list(20, txt(80)).optional(), faitFoi: txt(80).optional(), filtres: txt(1000).optional(), pieges: list(20, txt()).optional(),
}).strict();
const classeur = z.object({
  indicateur: txt(120), fichier: txt(200), systeme: z.enum(DOCS), chemin: txt(500), site: txt(200).optional(),
  dependances: list(30, txt(500)).optional(), miseAJour: txt(300).optional(),
}).strict();
export const SCHEMA = z.object({
  version: z.literal(1),
  nom: txt(120).optional(), // libellé de la couche (ex. nom de la société), affiché à l'assistant
  vocabulaire: z.array(terme).max(500).optional(),
  societes: z.array(z.object({ code: txt(40), nom: txt(120), devise: txt(10).optional(),
    sites: z.array(z.object({ code: txt(40), nom: txt(120), role: txt(200).optional() }).strict()).max(200).optional() }).strict()).max(100).optional(),
  champsSpecifiques: z.array(z.object({ objet: txt(80), champ: txt(80), sens: txt() }).strict()).max(500).optional(),
  objets: z.array(objet).max(200).optional(), // objets Salesforce personnalisés, représentations Sage X3 spécifiques
  regles: list(100, txt(1000)).optional(),
  indicateurs: z.array(z.object({ nom: txt(120), synonymes: list(30).optional(), definition: txt(1000), calcul: txt(1000).optional(),
    objets: list(20, txt(80)).optional(), classeur: txt(120).optional() }).strict()).max(300).optional(),
  classeurs: z.array(classeur).max(300).optional(),
}).strict();

/** Erreur de validation lisible : « vocabulaire[2].definition : … ». */
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
  // Références croisées : un objet cité doit exister (couche générique ou objets du fichier), un indicateur doit trouver son classeur.
  const ids = new Set([...OBJETS.map((o) => o.id), ...(c.objets ?? []).map((o) => o.id)]);
  const unknown = [
    ...(c.champsSpecifiques ?? []).map((x, i) => [`champsSpecifiques[${i}].objet`, x.objet]),
    ...(c.vocabulaire ?? []).flatMap((t, i) => [...(t.objets ?? []).map((o) => [`vocabulaire[${i}].objets`, o]), ...(t.faitFoi ? [[`vocabulaire[${i}].faitFoi`, t.faitFoi]] : [])]),
    ...(c.indicateurs ?? []).flatMap((t, i) => (t.objets ?? []).map((o) => [`indicateurs[${i}].objets`, o])),
  ].filter(([, id]) => !ids.has(id));
  if (unknown.length) throw new Error(`objet inconnu : ${unknown.slice(0, 5).map(([p, id]) => `${p} = ${id}`).join(" ; ")} (objets connus : ceux de la couche générique et ceux déclarés dans objets)`);
  const books = new Set((c.classeurs ?? []).map((b) => norm(b.indicateur)));
  const orphan = (c.indicateurs ?? []).map((t, i) => [i, t.classeur]).filter(([, b]) => b && !books.has(norm(b)));
  if (orphan.length) throw new Error(`classeur inconnu : ${orphan.map(([i, b]) => `indicateurs[${i}].classeur = ${b}`).join(" ; ")} (doit reprendre l'indicateur d'une entrée de classeurs)`);
  return c;
}

/** Glossaire fusionné : couche client d'abord (elle prime), puis la couche générique non remplacée. */
export function build(client) {
  const tag = (o, origine) => ({ ...o, origine });
  const cObjets = (client?.objets ?? []).map((o) => tag(o, "client"));
  const objets = [...cObjets, ...OBJETS.filter((o) => !cObjets.some((x) => x.id === o.id)).map((o) => tag(o, "generique"))]
    .map((o) => {
      const extra = (client?.champsSpecifiques ?? []).filter((x) => x.objet === o.id).map((x) => ({ champ: x.champ, sens: x.sens, source: "client" }));
      return extra.length ? { ...o, champs: [...extra, ...(o.champs ?? []).filter((x) => !extra.some((e) => e.champ === x.champ))] } : o;
    });
  const cTermes = (client?.vocabulaire ?? []).map((t) => tag(t, "client"));
  const termes = [...cTermes, ...TERMES.filter((t) => !cTermes.some((x) => norm(x.terme) === norm(t.terme))).map((t) => tag(t, "generique"))];
  return {
    nom: client?.nom ?? null, client: !!client, objets, termes,
    regles: [...(client?.regles ?? []), ...REGLES], // chaîne, ou [systeme, texte] pour une règle propre à un connecteur
    societes: client?.societes ?? [], indicateurs: client?.indicateurs ?? [], classeurs: client?.classeurs ?? [],
  };
}

const words = (q) => new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
/** Correspondance : sous-chaîne, ou mot entier pour une requête courte (« CA » ne doit pas trouver « facture »). */
const matcher = (q) => { const n = norm(q), re = n.length <= 3 ? words(n) : null; return (s) => (re ? re.test(norm(s)) : norm(s).includes(n)); };

/**
 * Réponse de l'outil clevoa_glossaire.
 * @param g        glossaire fusionné (build)
 * @param enabled  identifiants des connecteurs proposés (CONNECTORS_ENABLED, production)
 * @param sage     structure Sage X3 déjà en cache pour ce collaborateur ({ representations, missing, denied, broken }) ou undefined
 */
export function answer(g, { terme, objet } = {}, enabled = [], sage) {
  const on = new Set(enabled);
  const objets = g.objets.filter((o) => on.has(o.systeme));
  const visible = new Set(objets.map((o) => o.id));
  // Un terme reste s'il cite au moins un objet proposé, ou s'il n'en cite aucun (vocabulaire maison sans objet).
  const termes = g.termes.filter((t) => !t.objets?.length || t.objets.some((id) => visible.has(id)))
    .map((t) => ({ ...t, objets: (t.objets ?? []).filter((id) => visible.has(id)) }))
    .map((t) => (t.faitFoi && !visible.has(t.faitFoi) ? { ...t, faitFoi: undefined, note: "l'objet qui fait foi n'est pas proposé sur cette instance" } : t));
  const classeurs = g.classeurs.filter((b) => on.has(b.systeme));
  const indicateurs = g.indicateurs.map((i) => ({ ...i, ...(i.objets && { objets: i.objets.filter((id) => visible.has(id)) }) }));
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
  const common = { couche, regles_prudence: regles, ...(sageNote && { note_sage_x3: sageNote }) };

  if (objet) {
    const k = norm(objet);
    const o = objets.find((x) => norm(x.id) === k || norm(x.nom) === k || (x.synonymes ?? []).some((s) => norm(s) === k));
    if (!o) return { objet, resultat: `objet inconnu ou non proposé sur cette instance ; objets disponibles : ${objets.map((x) => x.id).join(", ")}`, ...common };
    return { objet: withStatus(o), sources_des_champs: SOURCES, termes: termes.filter((t) => t.objets.includes(o.id)).map((t) => ({ terme: t.terme, definition: t.definition, faitFoi: t.faitFoi })), ...common };
  }
  if (terme) {
    const hit = matcher(terme);
    const t = termes.filter((x) => [x.terme, ...(x.synonymes ?? [])].some(hit));
    const o = objets.filter((x) => [x.id, x.nom, ...(x.synonymes ?? []), ...(x.questions ?? [])].some(hit));
    const i = indicateurs.filter((x) => [x.nom, ...(x.synonymes ?? [])].some(hit));
    const b = classeurs.filter((x) => [x.indicateur, x.fichier].some(hit) || i.some((y) => y.classeur && norm(y.classeur) === norm(x.indicateur)));
    const s = g.societes.filter((x) => [x.code, x.nom, ...(x.sites ?? []).flatMap((y) => [y.code, y.nom])].some(hit));
    if (!t.length && !o.length && !i.length && !b.length && !s.length)
      return { terme, resultat: "aucune entrée", termes_connus: termes.map((x) => x.terme), ...(g.indicateurs.length && { indicateurs_connus: g.indicateurs.map((x) => x.nom) }), ...common };
    // Objet qui fait foi d'un terme trouvé : joint en entier, même si son nom ne correspond pas à la recherche.
    const foi = t.map((x) => x.faitFoi).filter(Boolean);
    const objs = [...o, ...objets.filter((x) => foi.includes(x.id) && !o.includes(x))].map(withStatus);
    return { terme, termes: t, objets: objs, ...(objs.length && { sources_des_champs: SOURCES }), ...(i.length && { indicateurs: i }), ...(b.length && { classeurs: b }), ...(s.length && { societes: s }), ...common };
  }
  return {
    sommaire: "Glossaire métier : appeler clevoa_glossaire avec terme (ex. « CA », « carnet de commandes ») ou objet (ex. SINVOICE, Opportunity).",
    termes: termes.map((x) => x.terme),
    objets: objets.map((x) => `${x.id} (${x.nom})`),
    ...(indicateurs.length && { indicateurs: indicateurs.map((x) => x.nom) }),
    ...(g.societes.length && { societes: g.societes.map((x) => `${x.code} (${x.nom})`) }),
    ...common,
  };
}
