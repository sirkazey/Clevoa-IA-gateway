// Extraction de texte (extract.js) : Word, Excel, PowerPoint, PDF, texte, et garde-fous (taille, bombe zip, troncature).
// Les documents sont construits dans le test (helpers/docs.js) : aucun fichier binaire dans le dépôt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import * as docs from "./helpers/docs.js";
import { inflateSync, crc32 } from "node:zlib";
import { extract, format, checkSize, readBody, decode, unsupported, parsePages, toResult, MAX_SIZE, MAX_TEXT, MAX_IMAGES_B64 } from "../extract.js";
import { encodeGray, shrink, toGray, pagePng } from "../png.js";

test("Entités XML : nommées, décimales, hexadécimales ; une référence invalide reste telle quelle", () => {
  assert.equal(decode("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#233;&#x2014;&#X41; &#xFFFFFFF; &nbsp;"), "a & b <c> \"d\" 'e' é—A &#xFFFFFFF; &nbsp;");
});

test("Format d'après le nom : Office, PDF, texte ; image et ancien Office non lus, avec une note sans téléchargement", () => {
  assert.deepEqual(["a.DOCX", "b.xlsm", "c.pptx", "d.pdf", "e.csv", "f", "g.png", "h.doc"].map((n) => format(n)), ["docx", "xlsx", "pptx", "pdf", "text", null, null, null]);
  assert.equal(format("sans-extension", "text/plain; charset=utf-8"), "text");
  assert.equal(unsupported("photo.png", "https://lien"), "Format .png : lecture du contenu non prise en charge dans cette version ; ouvrez https://lien.");
});

test("Word : paragraphes, entités, tableau à une ligne par rangée ; les taquets de tabulation du style ne produisent rien", async () => {
  const r = await extract(docs.docx({ paragraphs: ["Titre &amp; sous-titre", "Montant&#160;: 12&#xA0;€"], table: [["Poste", "Montant"], ["Loyer", ""], ["", "800"]] }), "docx");
  assert.deepEqual(r, { format: "docx", truncated: false, text: "Titre & sous-titre\nMontant : 12 €\nPoste\tMontant\nLoyer\t\n\t800" });
});

test("Excel : feuilles dans l'ordre du classeur, chaînes partagées et en ligne, nombres, booléens, formule (valeur calculée), cellules vides", async () => {
  const r = await extract(docs.xlsx({
    shared: ["<t>Libellé</t>", "<r><t>Ri</t></r><r><t>che &amp; co</t></r><rPh><t>phonétique</t></rPh>"],
    sheets: [
      { name: "Synthèse", rows: [['<c r="A1" t="s"><v>0</v></c>', '<c r="C1" t="s"><v>1</v></c>'], ['<c r="A2"><v>42.5</v></c>', '<c r="B2"><f>A2*2</f><v>85</v></c>', '<c r="C2" t="b"><v>1</v></c>', '<c r="D2" t="inlineStr"><is><t>a &lt; b</t></is></c>']] },
      { name: "Détail &amp; annexes", rows: [['<c r="C1" t="str"><f>"x"</f><v>calculé</v></c>']] },
    ],
    order: [1, 0],
  }), "xlsx");
  assert.equal(r.text, "## Feuille « Détail & annexes »\n\t\tcalculé\n\n## Feuille « Synthèse »\nLibellé\t\tRiche & co\n42.5\t85\tVRAI\ta < b");
});

test("PowerPoint : ordre de la présentation, sinon numérique (slide2 avant slide10) ; notes de l'orateur sans le numéro de page", async () => {
  const slides = Array.from({ length: 11 }, (_, i) => `Diapo ${i + 1} &amp; fin`);
  for (const bare of [false, true]) {
    const { text } = await extract(docs.pptx({ slides, notes: { 1: "Dire &quot;merci&quot;" }, bare }), "pptx");
    const order = [...text.matchAll(/Diapo (\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(order, Array.from({ length: 11 }, (_, i) => i + 1), `ordre (${bare ? "numérique" : "présentation"})`);
    assert.match(text, /## Diapositive 2\nDiapo 2 & fin\n\nNotes : Dire "merci"\n\n## Diapositive 3/);
  }
});

test("PDF : texte page par page avec marqueur ; PDF blanc → note ; PDF endommagé → message clair", async () => {
  const r = await extract(docs.pdf(["Compte de resultat fictif", "Seconde page (annexe)"]), "pdf", "<lien>");
  assert.deepEqual(r, { format: "pdf", truncated: false, text: "--- Page 1 ---\nCompte de resultat fictif\n\n--- Page 2 ---\nSeconde page (annexe)" });
  const blank = await extract(docs.pdf(["", ""]), "pdf", "<lien>");
  assert.deepEqual(blank, { format: "pdf", note: "PDF sans texte ni image de page lisible ; ouvrez <lien>." });
  await assert.rejects(extract(strToU8("%PDF-1.4 tronqué"), "pdf", "<lien>"), /^Error: PDF illisible .*ouvrez <lien>\.$/);
});

test("Troncature à 200 000 caractères (truncated: true) ; texte UTF-8 avec BOM", async () => {
  const long = await extract(strToU8("﻿é" + "x".repeat(MAX_TEXT + 10)), "text");
  assert.equal(long.truncated, true); assert.equal(long.text.length, MAX_TEXT); assert.ok(long.text.startsWith("éx"));
  const big = await extract(docs.docx({ paragraphs: ["y".repeat(MAX_TEXT + 1)] }), "docx");
  assert.equal(big.truncated, true); assert.equal(big.text.length, MAX_TEXT);
});

test("Bombe zip refusée (plus de 60 Mo décompressés) ; archive invalide → message clair", async () => {
  const bomb = zipSync({ "word/document.xml": new Uint8Array(61 * 1024 * 1024) }, { level: 9 });
  assert.ok(bomb.length < 200_000, `archive de ${bomb.length} octets`);
  await assert.rejects(extract(bomb, "docx"), /plus de 60 Mo une fois décompressé/);
  const ignored = zipSync({ "word/media/image.bin": new Uint8Array(61 * 1024 * 1024), "word/document.xml": strToU8("<w:document><w:body><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:body></w:document>") }, { level: 9 });
  assert.equal((await extract(ignored, "docx")).text, "ok", "seules les entrées utiles sont décompressées");
  await assert.rejects(extract(strToU8("PK pas un zip"), "xlsx"), /archive zip invalide/);
});

test("Taille : refus au-delà de 25 Mo sur les métadonnées, et pendant la lecture si elles mentent", async () => {
  assert.throws(() => checkSize(MAX_SIZE + 1, "<lien>"), /Fichier de 26 Mo : au-delà de 25 Mo, le contenu n'est pas lu ; ouvrez <lien>\./);
  checkSize(MAX_SIZE, "<lien>");
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream({ pull(c) { c.enqueue(chunk); } }); // flux sans fin
  await assert.rejects(readBody({ body }, "<lien>"), /au-delà de 25 Mo/);
  assert.deepEqual([...await readBody(new Response("abc"), "<lien>")], [97, 98, 99]);
});

/** Décode un PNG en niveaux de gris 8 bits produit par encodeGray (filtres 0 et 2 seulement) en vérifiant chaque CRC. */
function readPng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "signature PNG");
  const chunks = {};
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString("ascii", o + 4, o + 8), body = buf.subarray(o + 8, o + 8 + len);
    assert.equal(buf.readUInt32BE(o + 8 + len), crc32(buf.subarray(o + 4, o + 8 + len)), `CRC ${type}`);
    chunks[type] = body; o += 12 + len;
  }
  assert.ok(chunks.IEND, "IEND");
  const width = chunks.IHDR.readUInt32BE(0), height = chunks.IHDR.readUInt32BE(4);
  assert.deepEqual([chunks.IHDR[8], chunks.IHDR[9]], [8, 0], "8 bits, niveaux de gris");
  const raw = inflateSync(chunks.IDAT), px = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const f = raw[y * (width + 1)], v = raw[y * (width + 1) + 1 + x];
    px[y * width + x] = f === 2 && y ? (v + px[(y - 1) * width + x]) & 255 : v;
  }
  return { width, height, px };
}

test("PNG : signature, CRC, IHDR, données relues avec zlib.inflateSync ; niveaux de gris depuis RVB, RVBA et 1 bit", () => {
  const img = { data: Uint8Array.from([0, 64, 128, 255, 10, 20]), width: 3, height: 2 };
  const back = readPng(encodeGray(img));
  assert.deepEqual([back.width, back.height, [...back.px]], [3, 2, [0, 64, 128, 255, 10, 20]]);
  assert.deepEqual([...toGray({ data: Uint8Array.from([255, 255, 255, 0, 0, 0]), width: 2, height: 1 })], [255, 0], "RVB");
  assert.deepEqual([...toGray({ data: Uint8Array.from([255, 0, 0, 255]), width: 1, height: 1 })], [76], "RVBA : luminance du rouge");
  assert.deepEqual([...toGray({ data: Uint8Array.from([0b10100000]), width: 3, height: 1, kind: 1 })], [255, 0, 255], "1 bit : bit à 1 = blanc");
});

test("Réduction : grand côté ramené à 1568 px par moyenne de blocs ; image déjà petite inchangée", () => {
  const w = 3136, h = 1000, gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = x % 2 ? 200 : 100; // colonnes alternées
  const r = shrink(gray, w, h);
  assert.deepEqual([r.width, r.height], [1568, 500]);
  assert.ok(r.data.every((v) => v === 150), "moyenne de chaque bloc 2 × 2");
  const small = shrink(gray.subarray(0, 100), 10, 10);
  assert.deepEqual([small.width, small.height], [10, 10]);
  const big = readPng(pagePng({ data: new Uint8Array(4000 * 3000 * 3).fill(255), width: 4000, height: 3000 }));
  assert.deepEqual([big.width, big.height], [1568, 1176]);
});

test("PDF scanné : pages jointes en image PNG (1568 px au plus), PDF mixte texte et scan, image 1 bit, page en plusieurs morceaux illisible", async () => {
  const pieces = docs.scan(400, 300); // deux images de même taille par page : pas une page scannée simple
  const mixed = docs.pdf(["Page texte normale du rapport fictif", { image: docs.scan(2000, 2800) }, "",
    { image: { width: 16, height: 2, bits: 1, pixels: new Uint8Array([0xff, 0x00, 0x0f, 0xf0]) } }]);
  const r = await extract(mixed, "pdf", "<lien>");
  assert.match(r.text, /^--- Page 1 ---\nPage texte normale du rapport fictif\n\n--- Page 2 ---\n\(page scannée, jointe en image\)\n\n--- Page 3 ---\n\(page sans texte\)\n\n--- Page 4 ---\n\(page scannée, jointe en image\)$/);
  assert.equal(r.note, "PDF scanné : 4 pages, pages 2, 4 jointes en image.");
  assert.deepEqual(r.images.map((i) => i.page), [2, 4]);
  const p2 = readPng(Buffer.from(r.images[0].data, "base64"));
  assert.deepEqual([p2.width, p2.height], [1120, 1568], "réduite, proportions gardées");
  assert.equal(p2.px[0], 0, "bandeau noir en haut : orientation conservée"); assert.ok(p2.px[p2.px.length - 1] > 150);
  assert.deepEqual([...readPng(Buffer.from(r.images[1].data, "base64")).px], [...toGray({ data: Uint8Array.from([0xff, 0x00, 0x0f, 0xf0]), width: 16, height: 2, kind: 1 })]);

  const out = toResult({ name: "scan.pdf", ...r });
  assert.deepEqual(out.$content.map((c) => [c.type, c.mimeType]), [["text", undefined], ["image", "image/png"], ["image", "image/png"]]);
  assert.equal(JSON.parse(out.$content[0].text).name, "scan.pdf"); assert.equal(JSON.parse(out.$content[0].text).images, undefined);
  assert.deepEqual(toResult({ text: "x" }), { text: "x" }, "sans image : objet JSON habituel");

  const split = await extract(docs.pdf([{ images: [pieces, pieces], text: "En-tete" }, { images: [pieces, pieces] }]), "pdf", "<lien>");
  assert.equal(split.images, undefined); assert.match(split.note, /^PDF scanné : pages 1 à 2 illisibles ; ouvrez <lien>\.$/);
});

test("PDF scanné : 5 images par appel, argument pages pour la suite ; plafond de 4 Mo d'images par réponse", async () => {
  const seven = docs.pdf(Array.from({ length: 7 }, (_, i) => ({ image: docs.scan(300, 400, i + 1) })));
  const first = await extract(seven.slice(), "pdf", "<lien>"); // copie : pdf.js prend possession du tampon
  assert.deepEqual(first.images.map((i) => i.page), [1, 2, 3, 4, 5]);
  assert.match(first.note, /^PDF scanné : 7 pages, pages 1 à 5 jointes en image\. Pages scannées suivantes : redemander avec pages="6-7"\.$/);
  const next = await extract(seven.slice(), "pdf", "<lien>", "6-7");
  assert.deepEqual(next.images.map((i) => i.page), [6, 7]); assert.equal(next.note, "PDF scanné : 7 pages, pages 6 à 7 jointes en image.");
  await assert.rejects(extract(seven.slice(), "pdf", "<lien>", "9-12"), /Ce PDF n'a que 7 pages\./);
  assert.deepEqual(parsePages("3", 10), [3, 3]); assert.deepEqual(parsePages("8-20", 10), [8, 10]); assert.deepEqual(parsePages(undefined, 10), [1, 10]);

  const heavy = docs.pdf(Array.from({ length: 5 }, (_, i) => ({ image: docs.scan(1568, 2000, i + 1) }))); // bruit : environ 1,5 Mo par page en base64
  const r = await extract(heavy, "pdf", "<lien>");
  const total = r.images.reduce((s, i) => s + i.data.length, 0);
  assert.ok(r.images.length >= 1 && r.images.length < 5 && total <= MAX_IMAGES_B64, `${r.images.length} images, ${total} caractères`);
  assert.match(r.note, new RegExp(`Limite de 4 Mo d'images atteinte pour cet appel\\. Pages scannées suivantes : redemander avec pages="${r.images.length + 1}-5"\\.`));
});
