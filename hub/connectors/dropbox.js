// Connecteur passif Dropbox : proxy vers le serveur MCP officiel Dropbox (https://mcp.dropbox.com/mcp) pour lister et chercher,
// et API HTTP Dropbox (files/get_metadata, files/download) pour lire un fichier : le serveur MCP n'expose ni fetch ni file_preview
// à une application tierce. Le hub utilise le jeton OAuth Dropbox de l'utilisateur ; Dropbox applique ses droits.
// Lecture seule : scopes OAuth *.read uniquement ET liste blanche d'outils (jamais create/move/copy/delete).
import { z } from "zod";
import { withMcp, toolText, callRemote, unreachable, EMAIL } from "../mcpclient.js";
import * as extract from "../extract.js";

const MCP_URL = process.env.DROPBOX_MCP_URL || "https://mcp.dropbox.com/mcp";
const API = (process.env.DROPBOX_API_URL || "https://api.dropboxapi.com").replace(/\/$/, "");
const CONTENT = (process.env.DROPBOX_CONTENT_URL || "https://content.dropboxapi.com").replace(/\/$/, "");
const READ_ONLY = ["who_am_i", "list_folder", "search", "get_file_metadata", "list_shared_links", "get_shared_link_metadata"];

export const id = "dropbox";
export const label = "Dropbox";
export const domain = "documents";
export const probeUrl = MCP_URL; // sonde HEAD sans identifiant (health.js)
export const oauth = {
  authUrl: `${(process.env.DROPBOX_AUTH_URL || "https://www.dropbox.com").replace(/\/$/, "")}/oauth2/authorize`,
  tokenUrl: `${API}/oauth2/token`,
  clientId: process.env.DROPBOX_APP_KEY,
  clientSecret: process.env.DROPBOX_APP_SECRET,
  scope: "account_info.read files.metadata.read files.content.read sharing.read",
  extraAuthParams: { token_access_type: "offline" }, // refresh_token Dropbox
};

const mcp = (tok, fn) => withMcp({ url: MCP_URL, headers: { Authorization: `Bearer ${tok.access_token}` }, label: "Dropbox MCP" }, fn);

/** Outils du serveur Dropbox restreints à la liste blanche lecture seule (nom, description, schéma d'entrée), toutes pages lues. */
export const schema = (tok) => mcp(tok, async (c) => {
  const all = [];
  let cursor;
  for (let page = 0; page < 20; page++) { // 20 pages au plus : un curseur qui boucle ne bloque pas le hub
    const r = await c.listTools(cursor ? { cursor } : undefined);
    all.push(...r.tools);
    if (!(cursor = r.nextCursor)) break;
  }
  return { tools: all.filter((t) => READ_ONLY.includes(t.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
});

export const identity = (tok) => mcp(tok, async (c) => toolText(await c.callTool({ name: "who_am_i", arguments: {} })).match(EMAIL)?.[0] ?? null);

export async function ping(_tok, schema) {
  const { tools } = await schema();
  return { message: `Connecté au serveur MCP Dropbox (${MCP_URL}) · ${tools.length} outils en lecture seule`, tables: tools.map((t) => t.name) };
}

// Dropbox exige un en-tête Dropbox-API-Arg en ASCII : tout caractère non ASCII est échappé en \uXXXX.
const apiArg = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Appel de l'API HTTP Dropbox (POST, comme toute l'API v2) ; un 401 garde son statut pour le renouvellement du jeton (oauth.js). */
async function api(tok, url, { json, arg } = {}) {
  const headers = { Authorization: `Bearer ${tok.access_token}`, ...(json && { "Content-Type": "application/json" }), ...(arg && { "Dropbox-API-Arg": apiArg(arg) }) };
  const r = await fetch(url, { method: "POST", headers, body: json && JSON.stringify(json), signal: AbortSignal.timeout(60_000) }).catch((e) => { throw unreachable("Dropbox", url, e); });
  if (r.ok) return r;
  const body = (await r.text()).slice(0, 300);
  let summary; try { summary = JSON.parse(body).error_summary ?? body; } catch { summary = body; }
  if (r.status === 409 && /not_found/.test(summary)) throw new Error(`Dropbox : fichier introuvable ou inaccessible (${summary}). Vérifiez le chemin, ou utilisez l'id renvoyé par search ou list_folder.`);
  throw Object.assign(new Error(`Dropbox ${r.status}: ${summary}`), { status: r.status });
}

export const tools = [
  {
    name: "dropbox_tools", title: "Dropbox – outils disponibles",
    description: "Outils Dropbox disponibles en lecture seule (list_folder, search, get_file_metadata…) avec leur schéma d'arguments. À appeler avant dropbox_call ; pour lire un fichier, dropbox_read.",
    input: {},
    run: async (_tok, _a, schema) => (await schema()).tools,
  },
  {
    name: "dropbox_call", title: "Dropbox – lister et rechercher",
    description: "Appelle un outil Dropbox en lecture seule avec les droits de l'utilisateur, ex. tool='search', arguments={query:'budget'} ou tool='list_folder', arguments={path:'/Finance'}. Pour lire le contenu d'un fichier : dropbox_read.",
    input: { tool: z.enum(READ_ONLY), arguments: z.record(z.string(), z.any()).default({}) },
    run: (tok, { tool, arguments: args }) => mcp(tok, (c) => callRemote(c, tool, args)),
  },
  {
    name: "dropbox_read", title: "Dropbox – lire un fichier",
    description: "Texte d'un fichier Dropbox : Word, Excel (une section par feuille), PowerPoint (une section par diapositive), PDF (page par page ; pages scannées jointes en image), texte. Préférer l'id renvoyé par search ou list_folder (id:…) ; sinon le chemin complet, ex. /Finance/Budget.xlsx.",
    input: {
      // ns:<n>/… : chemin d'espace d'équipe (Dropbox Business) tel que search et list_folder le renvoient
      path: z.string().regex(/^(id:[\w-]+|ns:\d+\/[^\u0000-\u001f]*|\/[^\u0000-\u001f]+)$/).describe("Identifiant id:… (préféré), chemin d'équipe ns:… ou chemin complet /dossier/fichier, tels que renvoyés par search ou list_folder"),
      pages: z.string().regex(/^\d{1,4}(-\d{1,4})?$/).optional().describe(extract.PAGES_HELP),
    },
    run: async (tok, { path, pages }) => {
      const m = await (await api(tok, `${API}/2/files/get_metadata`, { json: { path } })).json();
      if (m[".tag"] !== "file") throw new Error("C'est un dossier : utilisez dropbox_call avec list_folder.");
      const where = `le fichier dans Dropbox (${m.path_display})`;
      const meta = { id: m.id, name: m.name, path: m.path_display, size: m.size, modified: m.server_modified };
      const fmt = extract.format(m.name);
      if (!fmt) return { ...meta, note: extract.unsupported(m.name, where) };
      extract.checkSize(m.size ?? 0, where);
      const data = await extract.readBody(await api(tok, `${CONTENT}/2/files/download`, { arg: { path } }), where);
      return extract.toResult({ ...meta, ...(await extract.extract(data, fmt, where, pages)) });
    },
  },
];
