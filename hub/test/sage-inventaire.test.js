// Inventaire de l'API Sage X3 (ops/sage-inventaire.js) : faux Syracuse local, aucun réseau.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inventory, readPrototype, compare, markdown } from "../../ops/sage-inventaire.js";

const ref = (rep) => ({ $type: "application/x-reference", $title: "{@1}", $item: { $url: `{$baseUrl}/${rep}('{$key}')?representation=${rep}.$lookup` } });
const PROTOS = {
  "CLIENT.$query": { $properties: { $resources: { $item: { $properties: { NUM: { $type: "application/x-string", $title: "{@1}" }, CUR: { $type: "application/x-string" }, CUR_REF: ref("DEVISE") } } } }, $localization: { "@1": "Numéro" } },
  "CLIENT.$details": { $properties: { NUM: { $type: "application/x-string" }, OST: { $type: "application/x-quantity" },
    LIGNES: { $type: "application/x-array", $item: { $properties: { ART: { $type: "application/x-string" }, ART_REF: ref("ARTICLE") } } } } },
  "DEVISE.$query": { $properties: { $resources: { $item: { $properties: { CUR: { $type: "application/x-string" } } } } } },
};

async function fakeSyracuse(t, { status = {} } = {}) {
  const calls = [];
  const srv = createServer((req, res) => {
    const m = decodeURIComponent(req.url).match(/\$prototypes\('(\w+)\.(\$\w+)'\)/);
    const key = m && `${m[1]}.${m[2]}`;
    calls.push({ key, auth: req.headers.authorization, method: req.method });
    if (status[m?.[1]]) { res.writeHead(status[m[1]]); return res.end(); }
    if (!PROTOS[key]) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(PROTOS[key]));
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  return { base: `http://127.0.0.1:${srv.address().port}`, calls };
}

test("readPrototype : champs, blocs dépliés et liaisons tirées des références", () => {
  const q = readPrototype(PROTOS["CLIENT.$query"]);
  assert.deepEqual(q.fields.map((f) => f.champ), ["NUM", "CUR"]);
  assert.equal(q.fields[0].libelle, "Numéro");
  assert.deepEqual(q.links, [{ champ: "CUR", vers: "DEVISE" }]);
  const d = readPrototype(PROTOS["CLIENT.$details"]);
  assert.deepEqual(d.fields.map((f) => f.champ), ["NUM", "OST", "LIGNES.ART"]);
  assert.deepEqual(d.links, [{ champ: "LIGNES.ART", vers: "ARTICLE" }]);
});

test("inventaire : suit les liaisons, classe absentes et interdites, n'appelle que $prototypes en GET", async (t) => {
  const { base, calls } = await fakeSyracuse(t, { status: { SECRET: 403 } });
  const r = await inventory({ base, folder: "TEST", auth: "Basic eDp5", seeds: ["CLIENT", "SECRET", "INCONNUE"], delayMs: 0 });
  assert.equal(r.CLIENT.statut, "disponible");
  assert.equal(r.DEVISE.statut, "disponible", "découverte par la référence CUR_REF");
  assert.equal(r.ARTICLE.statut, "absente", "découverte par une ligne de la fiche, puis 404");
  assert.equal(r.SECRET.statut, "interdite");
  assert.equal(r.INCONNUE.statut, "absente");
  assert.equal(r.DEVISE.fiche, "indisponible (404)");
  assert.ok(calls.every((c) => c.method === "GET" && /\.\$(query|details)$/.test(c.key)), "métadonnées seulement");
  assert.ok(calls.every((c) => c.auth === "Basic eDp5"));
});

test("inventaire : un 401 arrête tout après un seul essai", async (t) => {
  const { base, calls } = await fakeSyracuse(t, { status: { CLIENT: 401, DEVISE: 401 } });
  await assert.rejects(inventory({ base, folder: "TEST", auth: "Basic x", seeds: ["CLIENT", "DEVISE", "AUTRE"], delayMs: 0 }), (e) => e.stop === true);
  assert.equal(calls.length, 1, "un mot de passe refusé ne coûte qu'un essai à Syracuse");
});

test("compare et markdown : champs du dictionnaire absents de l'instance", async (t) => {
  const { base } = await fakeSyracuse(t);
  const r = await inventory({ base, folder: "TEST", auth: "Basic x", seeds: ["CLIENT"], delayMs: 0 });
  const objets = [{ id: "CLIENT", systeme: "sagex3", champs: [{ champ: "NUM" }, { champ: "OST" }, { champ: "ART" }, { champ: "ABSENT" }] },
    { id: "FACTURE", systeme: "sagex3", champs: [] }, { id: "Account", systeme: "salesforce", champs: [] }];
  const e = compare(r, objets);
  assert.deepEqual(e, [{ objet: "CLIENT", statut: "disponible", champs_absents: ["ABSENT"] }, { objet: "FACTURE", statut: "non testé", champs_absents: [] }]);
  const md = markdown(r, e, { folder: "TEST", date: "2026-11-12 10:00" });
  assert.match(md, /\| CLIENT \| CUR \| DEVISE \| oui \|/);
  assert.match(md, /\| CLIENT \| disponible \| ABSENT \|/);
  assert.match(md, /aucune donnée métier/);
});
