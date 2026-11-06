// Texte des documents lus par SharePoint et Dropbox : Word, Excel, PowerPoint (zip Office lu par fflate), PDF (pdf.js via unpdf)
// et fichiers texte. Tout se fait en mémoire, sans fichier temporaire. Garde-fous : taille du fichier source, volume décompressé
// (bombe zip), nombre de pages et durée pour un PDF, longueur du texte rendu. Pages scannées d'un PDF : jointes en image (png.js).
// Images et autres binaires : métadonnées et lien.
import { unzipSync } from "fflate";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import * as png from "./png.js";

export const MAX_SIZE = 25 * 1024 * 1024;     // fichier source, vérifié sur les métadonnées avant le téléchargement
export const MAX_UNZIPPED = 60 * 1024 * 1024; // total décompressé des entrées utiles
export const MAX_TEXT = 200_000;              // caractères rendus
export const MAX_PAGES = 300;                 // pages PDF lues
export const PDF_TIMEOUT = 20_000;            // durée d'extraction d'un PDF (ms), contrôlée entre deux pages
export const IMAGES_PER_CALL = 5;             // pages scannées jointes en image par appel
export const MAX_IMAGES_B64 = 4_000_000;      // images jointes à une réponse (base64)

const OFFICE = { docx: "docx", docm: "docx", xlsx: "xlsx", xlsm: "xlsx", pptx: "pptx", pptm: "pptx" };
const TEXT = /^(txt|csv|tsv|md|json|xml|html?|log|ya?ml|ini|sql)$/;
const ext = (name) => (/\.([a-z0-9]{1,5})$/i.exec(name || "")?.[1] || "").toLowerCase();
const mo = (n) => `${Math.ceil(n / 1024 / 1024)} Mo`;

/** Format lisible d'après le nom (puis le type MIME pour un texte sans extension connue) : docx, xlsx, pptx, text, ou null. */
export function format(name, contentType = "") {
  const e = ext(name);
  if (OFFICE[e]) return OFFICE[e];
  if (e === "pdf" || contentType === "application/pdf") return "pdf";
  if (TEXT.test(e) || /^text\/|^application\/(json|xml|csv)\b|\+(json|xml)\b/.test(contentType)) return "text";
  return null;
}

/** Note pour un format non lu (image, ancien Office, archive…) : rien n'est téléchargé. */
export function unsupported(name, link) {
  const e = ext(name);
  return `${e ? `Format .${e}` : "Format inconnu"} : lecture du contenu non prise en charge dans cette version ; ouvrez ${link}.`;
}

/** Refuse un fichier trop gros avant de le télécharger (taille des métadonnées). */
export function checkSize(size, link) {
  if (size > MAX_SIZE) throw new Error(`Fichier de ${mo(size)} : au-delà de ${mo(MAX_SIZE)}, le contenu n'est pas lu ; ouvrez ${link}.`);
}

/** Corps d'une réponse HTTP lu jusqu'à MAX_SIZE : au-delà (métadonnées absentes ou fausses), lecture interrompue. */
export async function readBody(r, link) {
  const chunks = []; let n = 0;
  for await (const c of r.body ?? []) {
    n += c.length;
    checkSize(n, link); // la sortie de boucle annule le flux
    chunks.push(c);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** Entités XML : nommées, décimales et hexadécimales ; une référence invalide reste telle quelle. */
export const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
  const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  try { return String.fromCodePoint(cp); } catch { return m; }
});
const attr = (tag, name) => decode(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "");
const tidy = (s) => s.replace(/ +$/gm, "").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, ""); // tabulations gardées : colonnes vides

/** Entrées utiles du zip, décompressées dans la limite de MAX_UNZIPPED (tailles déclarées, que fflate ne dépasse pas). */
function unzip(data, wanted) {
  let total = 0;
  let files;
  try {
    files = unzipSync(data, { filter: (f) => {
      if (!wanted(f.name)) return false;
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw Object.assign(new Error(`Document refusé : plus de ${mo(MAX_UNZIPPED)} une fois décompressé.`), { bomb: true });
      return true;
    } });
  } catch (e) {
    if (e.bomb) throw e;
    throw new Error("Document Office illisible (archive zip invalide ou endommagée).");
  }
  const dec = new TextDecoder();
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, dec.decode(v)]));
}

/** Relations d'une partie : Id → chemin complet dans le zip. */
function rels(xml = "", dir) {
  const out = {};
  for (const [tag] of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const t = attr(tag, "Target");
    out[attr(tag, "Id")] = { type: attr(tag, "Type"), path: t.startsWith("/") ? t.slice(1) : decodeURIComponent(new URL(t, `file:///${dir}`).pathname.slice(1)) };
  }
  return out;
}

// ---------- Word : paragraphes, tabulations, sauts de ligne ; tableaux à une ligne par rangée, cellules séparées par des tabulations
function docx(data) {
  const xml = unzip(data, (n) => n === "word/document.xml")["word/document.xml"] ?? "";
  const body = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "").replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, ""); // doublons des zones de texte, taquets de tabulation
  let out = "", depth = 0;
  for (const m of body.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<(\/?)w:(p|tc|tr|tbl)(?:\s[^>]*?)?(\/?)>/g)) {
    if (m[1] !== undefined) out += decode(m[1]);
    else if (m[2]) out += m[2] === "tab" ? "\t" : "\n";
    else {
      const close = m[3] === "/" || m[5] === "/", el = m[4];
      if (el === "tbl") depth += close ? (m[3] ? -1 : 0) : 1;
      else if (!close) continue;
      else if (el === "p") out += depth ? " " : "\n";
      else if (el === "tc") out = out.replace(/ $/, "") + "\t";
      else if (el === "tr") out = out.replace(/\t$/, "") + "\n";
    }
  }
  return tidy(out);
}

// ---------- Excel : une section par feuille (ordre du classeur), une ligne par rangée, colonnes respectées
const col = (ref) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const inner = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decode(m[1])).join(""); // sans le phonétique

// Formats de nombre Excel : une date est stockée comme un nombre de jours (série), un pourcentage comme une fraction ; sans le
// style, Claude lirait 45962 au lieu du 01/11/2025 et 0.15 au lieu de 15 %. Formats intégrés de date : 14-22, 27-36, 45-47, 50-58.
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_PCT = new Set([9, 10]);
/** Style de chaque index de cellule (attribut s) : "date", "datetime", "time", "pct" ou null. */
function cellKinds(styles = "") {
  const custom = Object.fromEntries([...styles.matchAll(/<numFmt\b[^>]*>/g)].map(([t]) => [attr(t, "numFmtId"), decode(attr(t, "formatCode") ?? "")]));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map(([t]) => {
    const id = Number(attr(t, "numFmtId") ?? 0);
    if (BUILTIN_PCT.has(id)) return "pct";
    // Format personnalisé : sans les textes entre guillemets, les caractères échappés et les couleurs [Red] ; [h] (durée) compte.
    const code = (custom[id] ?? "").replace(/"[^"]*"|\\.|\[(?![hms]\])[^\]]*\]/gi, "").toLowerCase();
    if (code.includes("%")) return "pct";
    const day = BUILTIN_DATE.has(id) || /[dy]/.test(code) || (/m/.test(code) && !/[hs]/.test(code)), hour = /[hs]/.test(code) || [18, 19, 20, 21, 22, 45, 46, 47].includes(id);
    return day && hour ? (id >= 18 && id <= 21) || id >= 45 && id <= 47 ? "time" : "datetime" : day ? "date" : hour ? "time" : null;
  });
}
const two = (n) => String(n).padStart(2, "0");
/** Valeur affichable d'un nombre selon son style : 01/11/2025, 01/11/2025 14:30, 14:30, 15 %. */
function formatNumber(raw, kind, date1904) {
  const n = Number(raw);
  if (!kind || !Number.isFinite(n) || raw === "") return raw;
  if (kind === "pct") return `${+(n * 100).toFixed(4)} %`;
  const ms = Math.round((n + (date1904 ? 1462 : 0)) * 86_400_000) + Date.UTC(1899, 11, 30), d = new Date(ms);
  const date = `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`, time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  return kind === "date" ? date : kind === "time" ? time : `${date} ${time}`;
}

function xlsx(data) {
  const files = unzip(data, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const kinds = cellKinds(files["xl/styles.xml"]), date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(files["xl/workbook.xml"] ?? "");
  const shared = [...(files["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => inner(m[1]));
  const r = rels(files["xl/_rels/workbook.xml.rels"], "xl/");
  const parts = [];
  let len = 0;
  for (const [tag] of (files["xl/workbook.xml"] ?? "").matchAll(/<sheet\b[^>]*>/g)) {
    const sheet = files[r[attr(tag, "r:id")]?.path];
    if (sheet === undefined || len > MAX_TEXT) continue; // feuille de graphique, ou texte déjà au plafond
    const lines = [];
    for (const row of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells = [];
      for (const c of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], "r"), t = attr(c[1], "t"), body = c[2] ?? "", kind = kinds[Number(attr(c[1], "s") ?? 0)];
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1]; // valeur calculée pour une formule
        const val = t === "s" ? shared[Number(v)] ?? "" : t === "inlineStr" ? inner(body) : t === "b" ? (v === "1" ? "VRAI" : v === "0" ? "FAUX" : "") : t === "str" || t === "e" ? decode(v ?? "") : formatNumber(decode(v ?? ""), kind, date1904);
        cells[ref ? col(ref) : cells.length] = val.replace(/[\t\r\n]+/g, " ");
      }
      if (cells.length) { const line = Array.from(cells, (x) => x ?? "").join("\t"); lines.push(line); len += line.length; }
      if (len > MAX_TEXT) break;
    }
    parts.push(`## Feuille « ${attr(tag, "name")} »${attr(tag, "state") === "hidden" ? " (masquée)" : ""}\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

// ---------- PowerPoint : une section par diapositive (ordre de la présentation, sinon numérique), notes de l'orateur
// Seuls les textes <a:t>, sauts <a:br/> et fins de paragraphe sont gardés : rien d'autre du XML ne passe dans le résultat.
const drawing = (xml = "") => tidy([...xml.replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, "") // numéro de diapositive, date
  .matchAll(/<a:t>([^<]*)<\/a:t>|<a:br\b[^>]*\/>|<\/a:p>/g)].map(([m, t]) => (t !== undefined ? decode(t) : "\n")).join(""));

function pptx(data) {
  const files = unzip(data, (n) => /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml)$/.test(n));
  const num = (p) => Number(/(\d+)\.xml$/.exec(p)[1]);
  const r = rels(files["ppt/_rels/presentation.xml.rels"], "ppt/");
  let order = [...(files["ppt/presentation.xml"] ?? "").matchAll(/<p:sldId\b[^>]*>/g)].map(([tag]) => r[attr(tag, "r:id")]?.path).filter((p) => files[p] !== undefined);
  if (!order.length) order = Object.keys(files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => num(a) - num(b));
  return order.map((p, i) => {
    const notesPath = Object.values(rels(files[p.replace("slides/", "slides/_rels/") + ".rels"], "ppt/slides/")).find((x) => x.type.endsWith("/notesSlide"))?.path;
    const notes = drawing(files[notesPath]);
    return `## Diapositive ${i + 1}\n${drawing(files[p])}${notes ? `\n\nNotes : ${notes}` : ""}`;
  }).join("\n\n");
}

// ---------- PDF : texte page par page, avec un marqueur par page. Pages sans texte (scan) : l'image de la page est jointe pour
// que Claude la lise lui-même ; aucune reconnaissance de caractères dans le hub.
const pageList = (ps) => (ps.length > 1 && ps.at(-1) - ps[0] === ps.length - 1 ? `${ps[0]} à ${ps.at(-1)}` : ps.join(", "));

/** PNG (base64) de la plus grande image de la page, si elle en est l'essentiel (page scannée) ; undefined pour une page sans image
 *  (blanche), null pour une page en plusieurs images. Pixels décodés par pdf.js. */
async function scanImage(doc, n, OPS, deadline) {
  const page = await doc.getPage(n), ops = await page.getOperatorList(), imgs = [];
  for (let k = 0; k < ops.fnArray.length; k++) {
    if (ops.fnArray[k] !== OPS.paintImageXObject) continue;
    const key = ops.argsArray[k][0];
    const img = await Promise.race([new Promise((r) => (key.startsWith("g_") ? page.commonObjs : page.objs).get(key, r)), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())).unref())]);
    if (img?.data && img.width && img.height) imgs.push(img);
  }
  const area = (i) => i.width * i.height, big = imgs.sort((a, b) => area(b) - area(a))[0];
  if (!big) return undefined;
  if (imgs.slice(1).reduce((s, i) => s + area(i), 0) > area(big) / 4) return null; // page en plusieurs morceaux
  return png.pagePng(big).toString("base64");
}

/** Pages demandées « 3 » ou « 6-10 » → [début, fin]. */
export function parsePages(s, total) {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(s ?? "");
  if (!m) return [1, Math.min(total, MAX_PAGES)];
  const a = Math.max(1, Number(m[1])), b = Math.min(total, Number(m[2] ?? m[1]), a + MAX_PAGES - 1);
  if (a > total) throw new Error(`Ce PDF n'a que ${total} page${total > 1 ? "s" : ""}.`);
  return [a, Math.max(a, b)];
}

async function pdf(data, link, pages) {
  let doc;
  try { doc = await getDocumentProxy(data, { verbosity: 0, isEvalSupported: false, isOffscreenCanvasSupported: false }); }
  catch (e) {
    throw new Error(e?.name === "PasswordException" ? `PDF protégé par un mot de passe : lecture impossible ; ouvrez ${link}.` : `PDF illisible (fichier endommagé ou non conforme) ; ouvrez ${link}.`);
  }
  try {
    const total = doc.numPages, [from, to] = parsePages(pages, total), deadline = Date.now() + PDF_TIMEOUT;
    const parts = [], scanned = [], notes = [];
    let len = 0, last = from - 1;
    for (let i = from; i <= to && len <= MAX_TEXT; i++) {
      if (Date.now() > deadline) { notes.push(`Extraction arrêtée après ${PDF_TIMEOUT / 1000} s, à la page ${i - 1} sur ${total}.`); break; }
      const { items } = await (await doc.getPage(i)).getTextContent();
      const page = tidy(items.map((t) => (t.str ?? "") + (t.hasEOL ? "\n" : "")).join(""));
      if (page.replace(/\s/g, "").length < 20) scanned.push(i); // page sans couche texte : probablement scannée
      parts.push(`--- Page ${i} ---\n${page}`); len += page.length; last = i;
    }
    if (last < total && !notes.length) notes.push(`Pages ${from} à ${last} lues sur ${total} : demander la suite avec pages="${last + 1}-${Math.min(total, last + MAX_PAGES)}".`);
    // Images des pages scannées : 5 au plus par appel et MAX_IMAGES_B64 au total ; les suivantes se demandent avec l'argument pages.
    const images = [], unreadable = [];
    let size = 0, next = 0;
    if (scanned.length) {
      const { OPS } = await getResolvedPDFJS();
      for (const n of scanned) {
        if (images.length >= IMAGES_PER_CALL || Date.now() > deadline) { next = n; break; }
        let b64 = null;
        try { b64 = await scanImage(doc, n, OPS, deadline); } catch { /* image non décodable : page signalée illisible */ }
        if (b64 === undefined) continue; // page blanche
        if (!b64) { unreadable.push(n); continue; }
        if (size + b64.length > MAX_IMAGES_B64 && images.length) { next = n; notes.push(`Limite de ${MAX_IMAGES_B64 / 1e6} Mo d'images atteinte pour cet appel.`); break; }
        images.push({ page: n, data: b64 }); size += b64.length;
      }
    }
    if (images.length) notes.unshift(`PDF scanné : ${total} page${total > 1 ? "s" : ""}, page${images.length > 1 ? "s" : ""} ${pageList(images.map((i) => i.page))} jointe${images.length > 1 ? "s" : ""} en image.`);
    if (next) notes.push(`Pages scannées suivantes : redemander avec pages="${next}-${Math.min(total, next + IMAGES_PER_CALL - 1)}".`);
    if (unreadable.length) notes.push(`PDF scanné : page${unreadable.length > 1 ? "s" : ""} ${pageList(unreadable)} illisible${unreadable.length > 1 ? "s" : ""} ; ouvrez ${link}.`);
    const joined = new Set(images.map((i) => i.page));
    const label = (p, n) => (joined.has(n) ? "(page scannée, jointe en image)" : unreadable.includes(n) ? "(page scannée illisible)"
      : next && n >= next && scanned.includes(n) ? "(page sans texte, image non jointe : voir la note)" : /---\n$/.test(p) ? "(page sans texte)" : "");
    const mark = (p, n) => p + (label(p, n) && (/\n$/.test(p) ? "" : "\n") + label(p, n));
    if (!parts.some((p) => !/---\n$/.test(p)) && !images.length && !unreadable.length) // ni texte ni image : pages blanches, ou dessin vectoriel
      return { note: `PDF sans texte ni image de page lisible ; ouvrez ${link}.` };
    return {
      ...(parts.some((_, k) => !scanned.includes(from + k)) && { text: parts.map((p, k) => mark(p, from + k)).join("\n\n") }),
      ...(notes.length && { note: notes.join(" ") }),
      ...(last < total && { truncated: true }),
      ...(images.length && { images }),
    };
  } catch (e) {
    if (/^Ce PDF n'a que/.test(e.message)) throw e;
    throw new Error(`PDF illisible (${String(e?.message || e).slice(0, 100)}) ; ouvrez ${link}.`);
  } finally {
    await doc.loadingTask?.destroy?.().catch(() => {});
  }
}

/** Texte d'un document déjà téléchargé : { format, truncated, text, note }, et pour un PDF scanné images: [{ page, data }]. */
export async function extract(data, fmt, link, pages) {
  const out = fmt === "pdf" ? await pdf(data, link, pages) : { text: fmt === "text" ? new TextDecoder().decode(data).replace(/^﻿/, "") : { docx, xlsx, pptx }[fmt](data) };
  if (out.text === undefined) return { format: fmt, ...out };
  return { format: fmt, ...out, truncated: !!out.truncated || out.text.length > MAX_TEXT, text: out.text.slice(0, MAX_TEXT) };
}

/** Résultat d'outil : objet JSON, ou contenu MCP mixte (texte puis une image PNG par page scannée) relayé tel quel par server.js. */
export function toResult({ images, ...rest }) {
  if (!images?.length) return rest;
  return { $content: [{ type: "text", text: JSON.stringify(rest) }, ...images.map((i) => ({ type: "image", data: i.data, mimeType: "image/png" }))] };
}

/** Argument pages des outils de lecture (PDF). */
export const PAGES_HELP = "PDF seulement : pages à lire, ex. \"1-5\" puis \"6-10\". Les pages scannées sont jointes en image, 5 par appel : demander les suivantes quand la note l'indique.";
