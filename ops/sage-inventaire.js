#!/usr/bin/env node
// Inventaire de l'API REST Sage X3 (Syracuse) : quelles représentations répondent, avec quels champs, et comment elles se
// relient entre elles. Lecture seule et MÉTADONNÉES SEULEMENT : le script n'appelle que $prototypes (description des
// champs), jamais $query ni $details sur des enregistrements ; aucune donnée métier n'est lue ni écrite.
//
// Usage (Node 24, aucune dépendance) :
//   SAGE_URL=https://x3-… SAGE_FOLDER=X3TST_CHREC SAGE_LOGIN=… node ops/sage-inventaire.js [--max 250] [--seed REP1,REP2]
// Mot de passe : demandé au clavier (non affiché), ou SAGE_PASSWORD ; jeton : SAGE_TOKEN (en-tête Bearer).
// Résultat : dossier inventaire-sage-<date>/ (inventaire.json, inventaire.md) dans le dossier courant. Ne pas le committer :
// il décrit l'instance d'un client.
//
// Prudence Syracuse : le compte est bloqué après quelques mots de passe refusés. Le premier appel est fait seul ; un 401
// arrête tout immédiatement. Les appels suivants sont espacés et limités à deux en parallèle.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Représentations de départ : objets standard de la vente, des achats, de la comptabilité, des tiers et des stocks.
 *  Un nom inconnu coûte un 404 ; les représentations citées par les champs de référence s'ajoutent d'elles-mêmes. */
export const SEEDS = [
  "BPCUSTOMER", "BPSUPPLIER", "BPARTNER", "BPADDRESS", "BPCARRIER", "CONTACTCRM", "SALESREP", "BPCINVOICE", "BPSINVOICE",
  "SQUOTE", "SORDER", "SDELIVERY", "SINVOICE", "SRETURN", "PORDER", "PRECEIPT", "PINVOICE", "PREQUIS", "PRETURN",
  "GACCENTRY", "GACCENTRYD", "GACCDUDATE", "PAYMENT", "BALANCE", "BALANA", "BPCUSTMVT", "BPSUPPMVT", "SORDERQ", "PORDERQ", "ITMMVT", "GACCOUNT", "GJOURNAL", "GACCCODE", "CACCE", "GDIE", "PERIOD", "FISCALYEAR",
  "COMPANY", "FACILITY", "ITMMASTER", "ITMFACILIT", "ITMSALES", "ITMBPS", "STOCK", "STOJOU", "STOLOC", "TABCUR", "TABPAYTERM",
  "TABCOUNTRY", "TABDEPAGIO", "BUDGET",
];

/** Champs d'un prototype : $query a ses champs sous $properties.$resources.$item.$properties, $details directement sous
 *  $properties. Les blocs répétés (lignes) sont dépliés en BLOC.CHAMP. Les références (X_REF) donnent les liaisons. */
export function readPrototype(p) {
  const loc = p?.$localization || {};
  const label = (t) => String(t ?? "").replace(/\{@([^}]+)\}/g, (_, k) => loc[`@${k}`] ?? k);
  const root = p?.$properties?.$resources?.$item?.$properties ?? p?.$properties ?? {};
  const fields = [], links = [];
  const target = (v) => /representation=(\w+)\./.exec(v?.$item?.$url ?? v?.$item?.$item?.$url ?? v?.$links?.$details?.$url ?? v?.$links?.$query?.$url ?? "")?.[1];
  const walk = (map, prefix) => {
    for (const [n, v] of Object.entries(map)) {
      const type = String(v?.$type || "").replace(/^application\/x-/, "");
      if (type === "array" && v.$item?.$properties) { walk(v.$item.$properties, `${prefix}${n}.`); continue; }
      const to = target(v);
      if (to) links.push({ champ: `${prefix}${n}`.replace(/_REF$/, ""), vers: to });
      if (type !== "reference") fields.push({ champ: `${prefix}${n}`, type, libelle: label(v?.$title) || label(map[`${n}_REF`]?.$title) });
    }
  };
  walk(root, "");
  return { fields, links };
}

/** Parcours en largeur : chaque représentation trouvée ajoute celles que ses références citent. */
export async function inventory({ base, folder, auth, seeds = SEEDS, max = 250, delayMs = 150, fetchImpl = fetch, log = () => {} }) {
  const api = `${base.replace(/\/$/, "")}/api1/x3/erp/${folder}`;
  const get = async (rep, facet) => {
    const r = await fetchImpl(`${api}/$prototypes('${rep}.$${facet}')`, { headers: { Authorization: auth, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (r.status === 401) { const e = new Error("401 : identifiants refusés par Syracuse, inventaire arrêté (le compte se bloque après quelques échecs)."); e.stop = true; throw e; }
    if (!r.ok) return { status: r.status };
    try { return { status: r.status, proto: JSON.parse(await r.text()) }; } catch { return { status: 502 }; }
  };
  const result = {}, queue = [...new Set(seeds)], seen = new Set(queue);
  const visit = async (rep) => {
    const q = await get(rep, "query");
    if (!q.proto) { result[rep] = { statut: q.status === 404 ? "absente" : q.status === 403 ? "interdite" : `erreur ${q.status}` }; return; }
    const query = readPrototype(q.proto);
    const d = await get(rep, "details");
    const details = d.proto ? readPrototype(d.proto) : null;
    const links = [...query.links, ...(details?.links ?? [])].filter((l, i, a) => a.findIndex((x) => x.champ === l.champ && x.vers === l.vers) === i);
    result[rep] = { statut: "disponible", liste: query.fields, fiche: details ? details.fields : `indisponible (${d.status})`, liaisons: links };
    for (const l of links) if (!seen.has(l.vers) && seen.size < max) { seen.add(l.vers); queue.push(l.vers); }
  };
  await visit(queue.shift()); // seul, pour qu'un mot de passe refusé ne coûte qu'un essai
  log(`${Object.keys(result)[0]} : ${Object.values(result)[0].statut}`);
  while (queue.length) {
    const batch = queue.splice(0, 2);
    await Promise.all(batch.map(visit));
    batch.forEach((rep) => log(`${rep} : ${result[rep].statut}`));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return result;
}

/** Écart avec le dictionnaire de données de la passerelle : objet indisponible, champ attendu absent de la liste et de la fiche. */
export function compare(result, objets) {
  return objets.filter((o) => o.systeme === "sagex3").map((o) => {
    const r = result[o.id];
    if (!r || r.statut !== "disponible") return { objet: o.id, statut: r?.statut ?? "non testé", champs_absents: [] };
    const present = new Set([...r.liste, ...(Array.isArray(r.fiche) ? r.fiche : [])].map((f) => f.champ.split(".").pop()));
    const attendus = (o.champs ?? []).map((c) => c.champ).filter(Boolean);
    return { objet: o.id, statut: "disponible", champs_absents: attendus.filter((c) => !present.has(c)) };
  });
}

export function markdown(result, ecarts, meta) {
  const reps = Object.entries(result).sort(([a], [b]) => a.localeCompare(b));
  const by = (s) => reps.filter(([, r]) => r.statut === s).map(([n]) => n);
  const lines = [`# Inventaire de l'API Sage X3`, "", `Dossier ${meta.folder}, lu le ${meta.date} (métadonnées seulement, aucune donnée métier).`, "",
    `| Statut | Nombre | Représentations |`, `|---|---|---|`,
    ...["disponible", "absente", "interdite"].map((s) => `| ${s} | ${by(s).length} | ${by(s).join(", ")} |`),
    `| erreur | ${reps.filter(([, r]) => r.statut.startsWith("erreur")).length} | ${reps.filter(([, r]) => r.statut.startsWith("erreur")).map(([n, r]) => `${n} (${r.statut})`).join(", ")} |`, ""];
  if (ecarts.length) {
    lines.push("## Écart avec le dictionnaire de données", "", "| Objet | Statut | Champs attendus absents |", "|---|---|---|",
      ...ecarts.map((e) => `| ${e.objet} | ${e.statut} | ${e.champs_absents.join(", ") || "—"} |`), "");
  }
  lines.push("## Liaisons entre représentations disponibles", "", "| Depuis | Champ | Vers | Cible disponible |", "|---|---|---|---|");
  for (const [n, r] of reps) for (const l of r.liaisons ?? []) lines.push(`| ${n} | ${l.champ} | ${l.vers} | ${result[l.vers]?.statut === "disponible" ? "oui" : "non"} |`);
  lines.push("", "## Champs par représentation disponible", "");
  for (const [n, r] of reps.filter(([, x]) => x.statut === "disponible")) {
    lines.push(`### ${n}`, "", `Liste ($query) : ${r.liste.map((f) => f.champ).join(", ") || "aucun champ"}`, "",
      `Fiche ($details) : ${Array.isArray(r.fiche) ? r.fiche.map((f) => f.champ).join(", ") : r.fiche}`, "");
  }
  return lines.join("\n");
}

async function askHidden(prompt) {
  process.stdout.write(prompt);
  const { stdin } = process;
  if (!stdin.isTTY) return new Promise((res) => { let s = ""; stdin.on("data", (d) => (s += d)); stdin.on("end", () => res(s.trim())); });
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
  return new Promise((res) => {
    let s = "";
    stdin.on("data", function onData(ch) {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stdout.write("\n"); res(s); }
      else if (ch === "\u0003") process.exit(130);
      else if (ch === "\u007f") s = s.slice(0, -1);
      else s += ch;
    });
  });
}

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const { SAGE_URL: base, SAGE_FOLDER: folder, SAGE_LOGIN: login, SAGE_TOKEN: token } = process.env;
  if (!base || !folder || (!login && !token)) { console.error("SAGE_URL, SAGE_FOLDER et SAGE_LOGIN (ou SAGE_TOKEN) sont obligatoires."); process.exit(2); }
  const auth = token ? `Bearer ${token}` : `Basic ${Buffer.from(`${login}:${process.env.SAGE_PASSWORD ?? await askHidden(`Mot de passe Syracuse de ${login} : `)}`).toString("base64")}`;
  const seeds = [...SEEDS, ...(arg("--seed")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])];
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  try {
    const result = await inventory({ base, folder, auth, seeds, max: Number(arg("--max") ?? 250), log: (m) => console.log(m) });
    const { OBJETS } = await import(new URL("../hub/semantics/generique.js", import.meta.url)).catch(() => ({ OBJETS: [] }));
    const ecarts = compare(result, OBJETS);
    const dir = `inventaire-sage-${date.replace(/[: ]/g, "").replace(/-/g, "")}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "inventaire.json"), JSON.stringify({ dossier: folder, date, representations: result, ecarts }, null, 2));
    writeFileSync(join(dir, "inventaire.md"), markdown(result, ecarts, { folder, date }));
    const ok = Object.values(result).filter((r) => r.statut === "disponible").length;
    console.log(`\n${Object.keys(result).length} représentations testées, ${ok} disponibles. Rapport : ${dir}/inventaire.md`);
  } catch (e) { console.error(e.message); process.exit(e.stop ? 3 : 1); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
