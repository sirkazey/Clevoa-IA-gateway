// Documents de test construits en mémoire (aucun fichier binaire dans le dépôt) : Word, Excel, PowerPoint avec un XML minimal
// réaliste (zip fflate), et PDF écrit à la main (une police standard, une ligne de texte par page). Contenus inventés.
import { zipSync, strToU8 } from "fflate";
import { deflateSync } from "node:zlib";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const zip = (files) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])));
const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const rels = (...r) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${r.join("")}</Relationships>`;

/** Word : paragraphes (texte brut XML) et un tableau facultatif (rangées de cellules). */
export function docx({ paragraphs = [], table } = {}) {
  const p = (t) => `<w:p w:rsidR="00A1"><w:pPr><w:tabs><w:tab w:val="left" w:pos="708"/></w:tabs></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const tbl = table ? `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>${table.map((row) =>
    `<w:tr><w:trPr/>${row.map((c) => `<w:tc><w:tcPr><w:tcW w:w="3000"/></w:tcPr>${p(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>` : "";
  return zip({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": rels(rel("rId1", "officeDocument", "word/document.xml")),
    "word/document.xml": `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(p).join("")}${tbl}<w:sectPr/></w:body></w:document>`,
  });
}

/** Excel : feuilles { name, rows: [[cellule XML brute, …]] } ; la cellule est le XML de <c> (ex. '<c r="A1" t="s"><v>0</v></c>'). */
export function xlsx({ sheets, shared = [], order, styles, date1904 = false }) {
  const files = {
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "xl/workbook.xml": `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${date1904 ? '<workbookPr date1904="1"/>' : ""}<sheets>${
      (order ?? sheets.map((_, i) => i)).map((i) => `<sheet name="${sheets[i].name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": rels(...sheets.map((_, i) => rel(`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`)), rel("rId99", "sharedStrings", "sharedStrings.xml")),
    "xl/sharedStrings.xml": `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}">${shared.map((s) => `<si>${s}</si>`).join("")}</sst>`,
  };
  if (styles) files["xl/styles.xml"] = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${styles}</styleSheet>`;
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    s.rows.map((r, j) => `<row r="${j + 1}">${r.join("")}</row>`).join("")}</sheetData></worksheet>`; });
  return zip(files);
}

/** PowerPoint : diapositives (texte brut XML), notes facultatives ; fichiers numérotés slide1…slideN dans l'ordre donné.
 *  bare : sans presentation.xml, et fichiers rangés dans l'ordre alphabétique (slide10 avant slide2). */
export function pptx({ slides, notes = {}, bare = false }) {
  const files = bare ? {} : {
    "ppt/presentation.xml": `${XML}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${
      slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels(...slides.map((_, i) => rel(`rId${i + 1}`, "slide", `slides/slide${i + 1}.xml`))),
  };
  const sp = (t) => `<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="fr-FR"/><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
  slides.forEach((t, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = `${XML}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${sp(t)}</p:spTree></p:cSld></p:sld>`;
    if (notes[i] === undefined) return;
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels(rel("rId1", "notesSlide", `../notesSlides/notesSlide${i + 1}.xml`));
    files[`ppt/notesSlides/notesSlide${i + 1}.xml`] = `${XML}<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${sp(notes[i])}<p:sp><p:txBody><a:p><a:fld type="slidenum"><a:t>${i + 1}</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
  });
  return zip(bare ? Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) : files);
}

/** PDF minimal : une page par élément. Texte (ASCII, Helvetica) ; "" = page vide ; { image: { width, height, bits, pixels } }
 *  = page scannée (image pleine page, niveaux de gris, flux FlateDecode), avec un texte facultatif ; { images: [a, b] } = page en morceaux. */
export function pdf(pages) {
  const objs = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), null, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")];
  const add = (o) => objs.push(Buffer.isBuffer(o) ? o : Buffer.from(o)) && objs.length;
  const kids = pages.map((p) => {
    const { text = "", image, images = image ? [image] : [] } = typeof p === "string" ? { text: p } : p;
    let xobj = "", draw = "";
    images.forEach((im, k) => {
      const z = deflateSync(Buffer.from(im.pixels));
      const id = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceGray /BitsPerComponent ${im.bits ?? 8} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`), z, Buffer.from("\nendstream")]));
      xobj += ` /Im${k + 1} ${id} 0 R`; draw += `q 612 0 0 ${792 / images.length} 0 ${(792 / images.length) * k} cm /Im${k + 1} Do Q `;
    });
    if (xobj) xobj = ` /XObject <<${xobj} >>`;
    const stream = draw + (text ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET` : "");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >>${xobj} >> /Contents ${content} 0 R >>`);
  });
  objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  const out = [Buffer.from("%PDF-1.4\n")];
  let at = out[0].length;
  const offsets = objs.map((o, i) => { const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from("\nendobj\n")]); out.push(b); const here = at; at += b.length; return here; });
  out.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(out));
}

/** Image de « scan » en niveaux de gris : fond blanc, un bandeau noir en haut (repère d'orientation), bruit déterministe. */
export function scan(width, height, seed = 1) {
  const px = new Uint8Array(width * height);
  for (let i = 0; i < px.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; px[i] = i < width * Math.ceil(height / 10) ? 0 : 200 + (seed % 56); }
  return { width, height, pixels: px };
}
