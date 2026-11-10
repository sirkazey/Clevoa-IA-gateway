// Couche sémantique (1.8, expérimental) : glossaire générique, couche client (SEMANTICS_FILE), outil clevoa_glossaire.
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
import { OBJETS, TERMES } from "../semantics/generique.js";

const EXAMPLE = join(HUB_DIR, "..", "ops", "semantique-exemple.json");
const ALL = ["salesforce", "sagex3", "sharepoint", "dropbox", "myreport"];
let up, dir;
before(async () => { up = await startUpstream(); dir = mkdtempSync(join(tmpdir(), "semantique-")); });
after(async () => { await up?.stop(); rmSync(dir, { recursive: true, force: true }); });

async function client(hub) {
  const c = new Client({ name: "test-glossaire", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${hub.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
  return c;
}
const ask = async (c, args = {}) => {
  const r = await c.callTool({ name: "clevoa_glossaire", arguments: args });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(r.content.at(-1).text, "Source : Clevoa AI Gateway (glossaire métier)");
  return JSON.parse(r.content[0].text);
};

test("Couche générique : chaîne de vente et achats Sage X3, objets Salesforce ; chaque objet complet, chaque terme renvoie à des objets connus", () => {
  const ids = OBJETS.map((o) => o.id);
  for (const id of ["SQUOTE", "SORDER", "SDELIVERY", "SINVOICE", "GACCENTRY", "PAYMENT", "PORDER", "PINVOICE", "BPCUSTOMER", "BPSUPPLIER", "ITMMASTER", "Lead", "Account", "Contact", "Opportunity", "Quote", "Task"])
    assert.ok(ids.includes(id), id);
  for (const o of OBJETS) {
    assert.ok(o.nom && o.usage && o.champs.length && o.liens.length && o.pieges.length, `${o.id} : fiche complète`);
    assert.equal(o.questions.length, 3, `${o.id} : trois questions types`);
    for (const ch of o.champs) assert.ok(ch.champ ? ["instance", "aide", "salesforce"].includes(ch.source) : ch.statut === "champ à confirmer sur l'instance", `${o.id}.${ch.champ} : source ou « à confirmer »`);
  }
  for (const t of TERMES) {
    assert.ok(t.objets.every((id) => ids.includes(id)) && ids.includes(t.faitFoi), `${t.terme} : objets connus`);
  }
  assert.equal(norm("Chiffre D’Affaires  facturé"), "chiffre d'affaires facture");
});

test("clevoa_glossaire : sommaire, « CA » et « chiffre d'affaires » → factures de vente, recherche sans accents, objet ; consigne dans les INSTRUCTIONS", async () => {
  const hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, env: { SAGE_REPRESENTATIONS: "SINVOICE,NOPE" } });
  const c = await client(hub);
  try {
    assert.match(c.getInstructions(), /Question métier \(CA, encours, commandes, BFR…\) : consulter clevoa_glossaire avant de choisir les objets\./);
    const tool = (await c.listTools()).tools.find((t) => t.name === "clevoa_glossaire");
    assert.equal(tool.title, "Clevoa – glossaire métier"); assert.equal(tool.annotations.readOnlyHint, true);

    const sum = await ask(c);
    assert.match(sum.sommaire, /terme.*objet/);
    assert.ok(sum.termes.includes("Chiffre d'affaires facturé") && sum.termes.includes("Pipeline commercial"));
    assert.ok(sum.objets.includes("SINVOICE (Facture de vente)") && sum.objets.includes("Opportunity (Opportunité)"));
    assert.match(sum.couche, /générique seulement/);
    assert.ok(sum.regles_prudence.some((r) => /liste tronquée/.test(r)));
    assert.ok(JSON.stringify(sum).length < 6000, "sommaire court");

    for (const q of ["CA", "chiffre d'affaires", "Chiffre d’affaires", "ca facture", "CHIFFRE D'AFFAIRES FACTURÉ"]) {
      const r = await ask(c, { terme: q });
      assert.deepEqual(r.termes.map((t) => t.terme), ["Chiffre d'affaires facturé"], q);
      assert.equal(r.termes[0].faitFoi, "SINVOICE", `${q} : les factures de vente font foi`);
      assert.ok(r.objets.some((o) => o.id === "SINVOICE"), `${q} : fiche des factures de vente jointe`);
    }
    assert.ok(!(await ask(c, { terme: "CA" })).objets.some((o) => o.id === "SORDER"), "« CA » ne trouve pas les commandes (mot entier)");
    assert.deepEqual((await ask(c, { terme: "inventaire tournant" })).resultat, "aucune entrée");
    const accent = await ask(c, { terme: "ecriture" });
    assert.ok(accent.objets.some((o) => o.id === "GACCENTRY"), "« ecriture » trouve « Écriture comptable »");
    const question = await ask(c, { terme: "dix plus grosses factures" });
    assert.deepEqual(question.objets.map((o) => o.id), ["SINVOICE"], "recherche dans les questions types");

    // Disponibilité Sage X3 : aucun appel tant que la structure n'est pas en cache ; ensuite, d'après la structure.
    up.reset();
    const before = await ask(c, { objet: "sinvoice" });
    assert.equal(before.objet.id, "SINVOICE"); assert.equal(before.objet.disponibilite, undefined);
    assert.match(before.note_sage_x3, /non vérifiée dans cette session : appeler sagex3_representations/);
    assert.equal(up.state.requests.length, 0, "le glossaire n'appelle aucun système");
    await c.callTool({ name: "sagex3_representations", arguments: {} });
    assert.equal((await ask(c, { objet: "SINVOICE" })).objet.disponibilite, "publiée et lisible");
    assert.match((await ask(c, { objet: "SORDER" })).objet.disponibilite, /non vérifiée \(hors SAGE_REPRESENTATIONS\)/);
    assert.match((await ask(c, { objet: "Inconnu" })).resultat, /objet inconnu/);
  } finally { await c.close(); await hub.stop(); }
});

test("clevoa_glossaire : seuls les connecteurs proposés (CONNECTORS_ENABLED) ; un terme sans objet proposé disparaît", async () => {
  const hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, env: { CONNECTORS_ENABLED: "salesforce,dropbox" } });
  const c = await client(hub);
  try {
    const sum = await ask(c);
    assert.ok(sum.objets.every((o) => !/^(S|P|G|BP|ITM)[A-Z]+ /.test(o)), `aucun objet Sage X3 : ${sum.objets}`);
    assert.ok(sum.termes.includes("Pipeline commercial") && !sum.termes.includes("Chiffre d'affaires facturé"));
    assert.equal(sum.note_sage_x3, undefined); assert.ok(sum.regles_prudence.every((r) => !/Sage X3/.test(r)));
    assert.equal((await ask(c, { terme: "CA" })).resultat, "aucune entrée");
    const transfo = await ask(c, { terme: "taux de transformation" });
    assert.deepEqual(transfo.termes[0].objets, ["Quote", "Opportunity"]); assert.equal(transfo.termes[0].faitFoi, undefined);
    assert.match((await ask(c, { objet: "SINVOICE" })).resultat, /non proposé/);
  } finally { await c.close(); await hub.stop(); }
  const only = answer(build(null), {}, ["sagex3"]);
  assert.ok(only.objets.every((o) => !/Opportunity|Lead|Account/.test(o)));
});

test("Couche client fictive : ajoute un terme, en remplace un, complète un objet ; jamais le chemin du fichier dans les réponses", async () => {
  const hub = await startHub({ upstreamUrl: up.url, users: { [KEY]: connectedUser(up.url) }, env: { SEMANTICS_FILE: EXAMPLE } });
  const c = await client(hub);
  try {
    const sum = await ask(c);
    assert.match(sum.couche, /générique et propre à Biscuiterie Lune et Comète/);
    assert.deepEqual(sum.termes.filter((t) => t === "Carnet de commandes").length, 1, "terme remplacé, pas doublé");
    assert.equal(sum.termes[0], "Ventes comptoir", "la couche client vient en premier");
    assert.ok(sum.objets.includes("Salon__c (Salon gourmand (objet personnalisé fictif))"));
    assert.deepEqual(sum.indicateurs, ["Marge sur coûts directs"]); assert.ok(sum.societes.includes("LUNE (Biscuiterie Lune et Comète SAS (fictive))"));
    assert.match(sum.regles_prudence[0], /internes au groupe/);

    const added = await ask(c, { terme: "ca boutique" });
    assert.equal(added.termes[0].terme, "Ventes comptoir"); assert.equal(added.termes[0].origine, "client");
    const replaced = await ask(c, { terme: "carnet de commandes" });
    assert.equal(replaced.termes.length, 1); assert.equal(replaced.termes[0].origine, "client"); assert.match(replaced.termes[0].definition, /90 prochains jours/);
    const inv = await ask(c, { objet: "SINVOICE" });
    assert.deepEqual(inv.objet.champs[0], { champ: "ZCANAL", sens: "canal de vente (COMPTOIR, DISTRIBUTEUR) : champ spécifique de l'exemple fictif", source: "client" });
    const marge = await ask(c, { terme: "marge directe" });
    assert.equal(marge.indicateurs[0].nom, "Marge sur coûts directs");
    assert.equal(marge.classeurs[0].chemin, "/Exemple fictif/Direction financière/Marge mensuelle fictive.xlsx", "chemin du classeur de référence : utile à l'assistant");
    for (const r of [sum, added, replaced, inv, marge]) assert.ok(!JSON.stringify(r).includes(EXAMPLE) && !JSON.stringify(r).includes("semantique-exemple"), "jamais le chemin du fichier client");
    assert.ok(!c.getInstructions().includes("semantique-exemple"));
  } finally { await c.close(); await hub.stop(); }
});

test("Fichier client invalide ou absent : refus au démarrage avec un message clair", async () => {
  const bad = (name, content) => { const p = join(dir, name); writeFileSync(p, content); return p; };
  const cases = [
    [bad("json.json", "{ pas du json"), /SEMANTICS_FILE invalide \(.*json\.json\) : JSON invalide/],
    [bad("version.json", JSON.stringify({ version: 2 })), /SEMANTICS_FILE invalide .* version : /],
    [bad("cle.json", JSON.stringify({ version: 1, vocabulair: [] })), /SEMANTICS_FILE invalide .*vocabulair/],
    [bad("champ.json", JSON.stringify({ version: 1, vocabulaire: [{ terme: "Marge" }] })), /vocabulaire\[0\]\.definition/],
    [bad("objet.json", JSON.stringify({ version: 1, champsSpecifiques: [{ objet: "SINVOICES", champ: "ZX", sens: "test" }] })), /objet inconnu : champsSpecifiques\[0\]\.objet = SINVOICES/],
    [bad("classeur.json", JSON.stringify({ version: 1, indicateurs: [{ nom: "X", definition: "y", classeur: "Absent" }] })), /classeur inconnu : indicateurs\[0\]\.classeur = Absent/],
    [bad("format.yaml", "version: 1"), /YAML non pris en charge/],
    [join(dir, "absent.json"), /fichier introuvable/],
  ];
  for (const [file, re] of cases) assert.throws(() => { try { loadClient(file); } catch (e) { throw new Error(`SEMANTICS_FILE invalide (${file}) : ${e.message}`); } }, re, file);
  await assert.rejects(startHub({ upstreamUrl: up.url, env: { SEMANTICS_FILE: cases[3][0] } }), /\[config\] SEMANTICS_FILE invalide \(.*champ\.json\) : vocabulaire\[0\]\.definition/);
  assert.equal(loadClient(""), null, "variable vide : couche générique seule");
  assert.equal(loadClient(EXAMPLE).nom, "Biscuiterie Lune et Comète (société fictive d'exemple)", "l'exemple du dépôt est valide");
});
