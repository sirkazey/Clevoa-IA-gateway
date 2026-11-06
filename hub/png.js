// Images des pages scannées d'un PDF : pixels bruts décodés par pdf.js → niveaux de gris → réduction (moyenne par blocs)
// → PNG encodé avec node:zlib. JavaScript pur, aucune dépendance native ni canvas.
import { deflateSync, crc32 } from "node:zlib";

export const MAX_SIDE = 1568; // grand côté maximal transmis à Claude

/** Niveaux de gris (1 octet par pixel) depuis une image pdf.js : kind 1 = 1 bit par pixel (bit à 1 = blanc), sinon 1, 3 ou 4 canaux. */
export function toGray({ data, width, height, kind }) {
  const out = new Uint8Array(width * height);
  if (kind === 1 || (kind === undefined && width > 1 && data.length === Math.ceil(width / 8) * height)) {
    const row = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = data[y * row + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0;
    return out;
  }
  const ch = data.length / (width * height);
  if (![1, 3, 4].includes(ch)) throw new Error(`format de pixels inattendu (${ch} canaux)`);
  if (ch === 1) return Uint8Array.from(data);
  for (let i = 0, j = 0; i < out.length; i++, j += ch) out[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000; // luminance
  return out;
}

/** Réduction par moyenne des blocs de pixels pour que le grand côté fasse au plus `max` ; inchangée si déjà assez petite. */
export function shrink(gray, width, height, max = MAX_SIDE) {
  const s = Math.max(width, height) / max;
  if (s <= 1) return { data: gray, width, height };
  const w = Math.max(1, Math.round(width / s)), h = Math.max(1, Math.round(height / s));
  const sum = new Float64Array(w * h), n = new Uint32Array(w * h);
  for (let y = 0; y < height; y++) {
    const oy = Math.min(h - 1, Math.floor((y * h) / height)) * w;
    for (let x = 0; x < width; x++) { const o = oy + Math.min(w - 1, Math.floor((x * w) / width)); sum[o] += gray[y * width + x]; n[o]++; }
  }
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(sum[i] / n[i]);
  return { data, width: w, height: h };
}

const chunk = (type, body) => {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), tb = Buffer.concat([Buffer.from(type, "ascii"), body]);
  len.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
};

/** PNG en niveaux de gris 8 bits : signature, IHDR, IDAT (filtre « Up » par ligne, compressé), IEND. */
export function encodeGray({ data, width, height }) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 2; // filtre Up : différence avec la ligne du dessus, efficace sur un scan
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = (data[y * width + x] - (y ? data[(y - 1) * width + x] : 0)) & 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0; // 8 bits, niveaux de gris
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Image pdf.js → PNG réduit, niveaux de gris. */
export const pagePng = (img) => encodeGray(shrink(toGray(img), img.width, img.height));
