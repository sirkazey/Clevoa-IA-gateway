// Couche sémantique (1.8, expérimental) : dictionnaire de données générique, couche client (SEMANTICS_FILE), outil clevoa_dictionnaire.
// Le dictionnaire décrit les données et ne définit aucun indicateur (définitions et méthodes : skills de l'organisation).
// La couche client de test est l'exemple fictif du dépôt (ops/semantique-exemple.json) : il reste ainsi valide.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startUpstream } from "./helpers/upstream.js";
import { startHub, connectedUser, KEY, HUB_DIR } from "./helpers/hub.js";
import { build, answer, loadClient, norm } from "../semantics/index.js";
import * as generique from "../semantics/generique.js";

const { OBJETS, REGLES } = generique;
const EXAMPLE = join(HUB_DIR, "..", "ops", "semantique-exemple.json");
let up, dir;
before(async () => { up = await startUpstream(); dir = mkdtempSync(join(tmpdir(), "semantique-")); });
after(async () => { await up?.stop(); rmSync(dir, { recursive: true, force: true }); });

async function client(hub) {
  const c = new Client({ name: "test-dictionnaire", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${hub.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
  return c;
}
const ask = async (c, args = {}) => {
  const r = await c.callTool({ name: "clevoa_dictionnaire", arguments: args });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(r.content.at(-1).text, "Source : Clevoa AI Gateway (dictionnaire de données)");
  return JSON.parse(r.content[0].text);
};

test("Couche générique : chaîne de vente et achats Sage X3, objets Salesforce ; chaque objet complet ; aucune définition d'indicateur", () => {
  const ids = OBJETS.map((o) => o.id);
  for (const id of ["SQUOTE", "SORDER", "SDELIVERY", "SINVOICE", "GACCENTRY", "PAYMENT", "PORDER", "PINVOICE", "BPCUSTOMER", "BPSUPPLIER", "ITMMASTER", "Lead", "Account", "Contact", "Opportunity", "Quote", "Task"])
    assert.ok(ids.includes(id), id);
  for (const o of OBJETS) {
    assert.ok(o.nom && o.usage && o.champs.length && o.liens.length && o.pieges.length, `${o.id} : fiche complète`);
    assert.equal(o.questions.length, 3, `${o.id} : trois questions types`);
    for (const ch of o.champs) assert.ok(ch.champ ? ["instance", "aide", "salesforce"].includes(ch.source) : ch.statut === "champ à confirmer sur l'instance", `${o.id}.${ch.champ} : source ou « à confirmer »`);
  }
  assert.equal(generique.TERMES, undefined, "plus de vocabulaire d'indicateurs dans le hub");
  // Le savoir-faire financier (définitions, méthodes) va dans les skills : aucune règle ni aucun piège ne définit un indicateur.
  const texte = JSON.stringify([REGLES, OBJETS.map((o) => [o.usage, o.pieges])]);
  for (const re of [/\bCA\b/, /fait foi/, /carnet/i, /pipeline/i, /\bBFR\b/, /\bDSO\b/, /périmètre/]) assert.doesNotMatch(texte, re, String(re));
  assert.ok(REGLES.some((r) => r === "Dire si un montant est HT ou TTC."));
  assert.equal(norm("Chiffre D’Affaires  facturé"), "chiffre d'affaires facture");
});

test("clevoa_dictionnaire : sommaire, recherche d'objets par synonyme sans accents, fiche d'objet, aucun appel au système ; consignes dans les INSTRUCTIONS", async () => {
  const hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, env: { SAGE_REPRESENTATIONS: "SINVOICE,NOPE" } });
  const c = await client(hub);
  try {
    assert.match(c.getInstructions(), /consulter clevoa_dictionnaire avant de choisir les objets\./);
    assert.match(c.getInstructions(), /Définition d'un indicateur ou méthode d'analyse : suivre les compétences \(skills\) de l'organisation si elles existent, sinon demander la définition au collaborateur\./);
    const tools = (await c.listTools()).tools;
    assert.ok(!tools.some((t) => t.name === "clevoa_glossaire"), "pas d'alias de l'ancien nom");
    const tool = tools.find((t) => t.name === "clevoa_dictionnaire");
    assert.equal(tool.title, "Clevoa – dictionnaire de données"); assert.equal(tool.annotations.readOnlyHint, true);
    assert.match(tool.description, /ne définit aucun indicateur/);

    up.reset();
    const sum = await ask(c);
    assert.match(sum.sommaire, /terme.*objet/);
    assert.equal(sum.termes, undefined); assert.equal(sum.indicateurs, undefined);
    assert.ok(sum.objets.includes("SINVOICE (Facture de vente)") && sum.objets.includes("Opportunity (Opportunité)"));
    assert.match(sum.couche, /générique seulement/);
    assert.ok(sum.regles_lecture.some((r) => /liste tronquée/.test(r)));
    assert.ok(JSON.stringify(sum).length < 6000, "sommaire court");

    for (const q of ["facture client", "Facture de vente", "avoir client", "FACTURATION"]) {
      const r = await ask(c, { terme: q });
      assert.ok(r.objets.some((o) => o.id === "SINVOICE"), `${q} : factures de vente trouvées par synonyme`);
      assert.equal(r.termes, undefined, `${q} : plus de sortie termes`);
    }
    assert.deepEqual((await ask(c, { terme: "affaire" })).objets.map((o) => o.id), ["Opportunity"], "synonyme Salesforce");
    assert.deepEqual((await ask(c, { terme: "BL" })).objets.map((o) => o.id), ["SDELIVERY"], "mot court : mot entier");
    const accent = await ask(c, { terme: "ecriture" });
    assert.ok(accent.objets.some((o) => o.id === "GACCENTRY"), "« ecriture » trouve « Écriture comptable »");
    const question = await ask(c, { terme: "dix plus grosses factures" });
    assert.deepEqual(question.objets.map((o) => o.id), ["SINVOICE"], "recherche dans les questions types");
    for (const q of ["CA", "BFR", "carnet de commandes", "inventaire tournant"]) {
      const r = await ask(c, { terme: q });
      assert.equal(r.resultat, "aucune entrée", `${q} : aucun indicateur défini par le hub`);
      assert.ok(r.objets_connus.includes("SINVOICE"));
    }

    // Disponibilité Sage X3 : aucun appel tant que la structure n'est pas en cache ; ensuite, d'après la structure.
    const before = await ask(c, { objet: "sinvoice" });
    assert.equal(before.objet.id, "SINVOICE"); assert.equal(before.objet.disponibilite, undefined); assert.equal(before.termes, undefined);
    assert.ok(before.objet.pieges.some((p) => /avoir compte positif/.test(p)));
    assert.match(before.note_sage_x3, /non vérifiée dans cette session : appeler sagex3_representations/);
    assert.equal((await ask(c, { objet: "client" })).objet.id, "BPCUSTOMER", "objet par synonyme");
    assert.equal(up.state.requests.length, 0, "le dictionnaire n'appelle aucun système");
    await c.callTool({ name: "sagex3_representations", arguments: {} });
    assert.equal((await ask(c, { objet: "SINVOICE" })).objet.disponibilite, "publiée et lisible");
    assert.match((await ask(c, { objet: "SORDER" })).objet.disponibilite, /non vérifiée \(hors SAGE_REPRESENTATIONS\)/);
    assert.match((await ask(c, { objet: "Inconnu" })).resultat, /objet inconnu/);
  } finally { await c.close(); await hub.stop(); }
});

test("clevoa_dictionnaire : seuls les connecteurs proposés (CONNECTORS_ENABLED) ; règles filtrées par connecteur", async () => {
  const hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, env: { CONNECTORS_ENABLED: "salesforce,dropbox" } });
  const c = await client(hub);
  try {
    const sum = await ask(c);
    assert.ok(sum.objets.every((o) => !/^(S|P|G|BP|ITM)[A-Z]+ /.test(o)), `aucun objet Sage X3 : ${sum.objets}`);
    assert.equal(sum.note_sage_x3, undefined);
    assert.ok(sum.regles_lecture.every((r) => !/Sage X3/.test(r)), "aucune règle Sage X3");
    assert.ok(sum.regles_lecture.some((r) => /^Salesforce : SELECT COUNT\(\)/.test(r)), "règle Salesforce présente");
    assert.equal((await ask(c, { terme: "facture client" })).resultat, "aucune entrée");
    assert.match((await ask(c, { objet: "SINVOICE" })).resultat, /non proposé/);
  } finally { await c.close(); await hub.stop(); }
  const only = answer(build(null), {}, ["sagex3"]);
  assert.ok(only.objets.every((o) => !/Opportunity|Lead|Account/.test(o)));
  assert.ok(only.regles_lecture.some((r) => /non signés/.test(r)) && only.regles_lecture.every((r) => !/^Salesforce/.test(r)));
});

test("Couche client fictive : ajoute un objet, complète un objet, sociétés, règles, classeurs ; jamais le chemin du fichier dans les réponses", async () => {
  const hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, env: { SEMANTICS_FILE: EXAMPLE } });
  const c = await client(hub);
  try {
    const sum = await ask(c);
    assert.match(sum.couche, /générique et propre à Biscuiterie Lune et Comète/);
    assert.equal(sum.objets[0], "Salon__c (Salon gourmand (objet personnalisé fictif))", "la couche client vient en premier");
    assert.ok(sum.societes.includes("LUNE (Biscuiterie Lune et Comète SAS (fictive))"));
    assert.deepEqual(sum.classeurs, ["Marge mensuelle fictive.xlsx"]);
    assert.match(sum.regles_lecture[0], /internes au groupe/);

    const salon = await ask(c, { terme: "foire" });
    assert.deepEqual(salon.objets.map((o) => [o.id, o.origine]), [["Salon__c", "client"]]);
    const inv = await ask(c, { objet: "SINVOICE" });
    assert.deepEqual(inv.objet.champs[0], { champ: "ZCANAL", sens: "canal de vente (COMPTOIR, DISTRIBUTEUR) : champ spécifique de l'exemple fictif", source: "client" });
    const site = await ask(c, { terme: "BOUT" });
    assert.equal(site.societes[0].code, "LUNE", "recherche d'un site");
    const marge = await ask(c, { terme: "marge mensuelle" });
    assert.equal(marge.classeurs[0].chemin, "/Exemple fictif/Direction financière/Marge mensuelle fictive.xlsx", "chemin du classeur de référence : utile à l'assistant");
    for (const r of [sum, salon, inv, site, marge]) assert.ok(!JSON.stringify(r).includes(EXAMPLE) && !JSON.stringify(r).includes("semantique-exemple"), "jamais le chemin du fichier client");
    assert.ok(!c.getInstructions().includes("semantique-exemple"));
  } finally { await c.close(); await hub.stop(); }
});

test("Fichier client invalide ou absent : refus au démarrage avec un message clair ; termes, vocabulaire et indicateurs refusés", async () => {
  const bad = (name, content) => { const p = join(dir, name); writeFileSync(p, content); return p; };
  const cases = [
    [bad("json.json", "{ pas du json"), /SEMANTICS_FILE invalide \(.*json\.json\) : JSON invalide/],
    [bad("version.json", JSON.stringify({ version: 2 })), /SEMANTICS_FILE invalide .* version : /],
    [bad("cle.json", JSON.stringify({ version: 1, societe: [] })), /SEMANTICS_FILE invalide .*societe/],
    [bad("termes.json", JSON.stringify({ version: 1, termes: [{ terme: "CA", definition: "x" }] })), /SEMANTICS_FILE invalide .*racine : .*termes/],
    [bad("vocabulaire.json", JSON.stringify({ version: 1, vocabulaire: [{ terme: "CA", definition: "x" }] })), /SEMANTICS_FILE invalide .*racine : .*vocabulaire/],
    [bad("indicateurs.json", JSON.stringify({ version: 1, indicateurs: [{ nom: "Marge", definition: "x" }] })), /SEMANTICS_FILE invalide .*racine : .*indicateurs/],
    [bad("champ.json", JSON.stringify({ version: 1, objets: [{ id: "X__c", systeme: "salesforce" }] })), /objets\[0\]\.nom/],
    [bad("classeur.json", JSON.stringify({ version: 1, classeurs: [{ indicateur: "Marge", fichier: "a.xlsx", systeme: "dropbox", chemin: "/a.xlsx" }] })), /classeurs\[0\]/],
    [bad("objet.json", JSON.stringify({ version: 1, champsSpecifiques: [{ objet: "SINVOICES", champ: "ZX", sens: "test" }] })), /objet inconnu : champsSpecifiques\[0\]\.objet = SINVOICES/],
    [bad("format.yaml", "version: 1"), /YAML non pris en charge/],
    [join(dir, "absent.json"), /fichier introuvable/],
  ];
  for (const [file, re] of cases) assert.throws(() => { try { loadClient(file); } catch (e) { throw new Error(`SEMANTICS_FILE invalide (${file}) : ${e.message}`); } }, re, file);
  await assert.rejects(startHub({ upstreamUrl: up.url, env: { SEMANTICS_FILE: cases[5][0] } }), /\[config\] SEMANTICS_FILE invalide \(.*indicateurs\.json\) : racine : .*indicateurs/);
  assert.equal(loadClient(""), null, "variable vide : couche générique seule");
  assert.equal(loadClient(EXAMPLE).nom, "Biscuiterie Lune et Comète (société fictive d'exemple)", "l'exemple du dépôt est valide");
});
