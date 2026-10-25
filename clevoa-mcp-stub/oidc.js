// Annuaires OIDC simulés pour le prototype « connexion en un clic » : Entra Charlois, Entra Oakwood Cooperage (autre locataire)
// et le Google Workspace de la société acquise. Découverte, mire de choix du compte, code + PKCE + nonce, refresh, et
// désactivation d'un compte pour montrer la coupure au renouvellement. Émetteur : <bouchon>/oidc/<annuaire>/v2.0.
import { Router } from "express";
import { randomBytes, createHash } from "node:crypto";

// Comptes par annuaire. Le compte Google personnel doit être refusé par le hub (pas de domaine Workspace `hd`).
export const DIRECTORY = {
  "marie.dupont@charlois.com": { dir: "charlois", name: "Marie Dupont" },
  "paul.martin@charlois.com": { dir: "charlois", name: "Paul Martin" },
  "jack.reed@oakwoodcooperage.com": { dir: "oakwood", name: "Jack Reed" },
  "lea.bernard@acquise.example": { dir: "acquise", name: "Léa Bernard", hd: "acquise.example" },
  "quelquun@gmail.com": { dir: "acquise", name: "Compte Google personnel" },
};
const GOOGLE = new Set(["acquise"]); // annuaires de type Google (sub, email_verified, hd) ; les autres imitent Entra (oid, tid)
const TTL = 3600;
const codes = new Map(), disabled = new Set();
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const oid = (email) => `oid-${createHash("sha256").update(email).digest("hex").slice(0, 12)}`;

function idToken(issuer, dir, clientId, email, nonce) {
  const u = DIRECTORY[email], now = Math.floor(Date.now() / 1000), common = { iss: issuer, aud: clientId, nonce, iat: now, exp: now + TTL, name: u.name };
  const claims = GOOGLE.has(dir)
    ? { ...common, sub: `g-${oid(email)}`, email, email_verified: true, ...(u.hd ? { hd: u.hd } : {}) }
    : { ...common, sub: `pairwise-${oid(email)}`, oid: oid(email), tid: dir, preferred_username: email, email };
  return [enc({ alg: "none", typ: "JWT" }), enc(claims), ""].join("."); // non signé : reçu en direct du point de terminaison token
}

const DIRS = [...new Set(Object.values(DIRECTORY).map((u) => u.dir))];
/** Mire de choix du compte : toutes les valeurs sont échappées ici, une fois. */
function mire(dir, accounts, denyHref) {
  return `<!doctype html><meta charset="utf-8"><title>Annuaire ${esc(dir)} (simulé)</title>
<body style="font:16px system-ui;max-width:420px;margin:60px auto"><h2>Annuaire « ${esc(dir)} » — connexion simulée</h2><p>Choisissez le compte :</p>
${accounts.map((a) => `<p><a href="${esc(a.href)}" style="display:block;padding:12px;border:1px solid #999;border-radius:8px;text-decoration:none;color:#111">${esc(a.name)}<br><small>${esc(a.email)}${a.off ? " (désactivé)" : ""}</small></a></p>`).join("")}
<p><a href="${esc(denyHref)}">Refuser</a></p></body>`;
}

export function oidcRouter() {
  const r = Router();
  const issuerOf = (req) => `${req.protocol}://${req.headers.host}/oidc/${req.params.dir}/v2.0`;
  const known = (req, res, next) => (DIRS.includes(req.params.dir) ? next() : res.status(404).json({ error: "annuaire inconnu" }));

  r.get("/oidc/:dir/v2.0/.well-known/openid-configuration", known, (req, res) => {
    const iss = issuerOf(req);
    res.json({ issuer: iss, authorization_endpoint: `${iss}/authorize`, token_endpoint: `${iss}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], scopes_supported: ["openid", "email", "profile", "offline_access"] });
  });

  r.get("/oidc/:dir/v2.0/authorize", known, (req, res) => {
    const q = req.query;
    let back; try { back = new URL(String(q.redirect_uri)); } catch { back = null; }
    if (!back || !/^https?:$/.test(back.protocol) || !q.client_id || !q.state) return res.status(400).send("redirect_uri, client_id et state requis");
    const dir = DIRS.find((d) => d === req.params.dir); // valeur du serveur, plus celle de la requête
    const link = (email) => `/oidc/${dir}/v2.0/approve?${new URLSearchParams({ email, redirect_uri: back.href, state: q.state, client_id: q.client_id, nonce: q.nonce || "", code_challenge: q.code_challenge || "" })}`;
    const deny = new URL(back.href); deny.searchParams.set("state", String(q.state)); deny.searchParams.set("error", "access_denied");
    const accounts = Object.entries(DIRECTORY).filter(([, u]) => u.dir === dir).map(([e, u]) => ({ href: link(e), name: u.name, email: e, off: disabled.has(e) }));
    res.type("html").send(mire(dir, accounts, deny.href));
  });

  r.get("/oidc/:dir/v2.0/approve", known, (req, res) => {
    const { email, redirect_uri, state, client_id, nonce, code_challenge } = req.query;
    if (DIRECTORY[email]?.dir !== req.params.dir) return res.status(400).send("compte inconnu dans cet annuaire");
    if (disabled.has(email)) return res.status(403).send("compte désactivé dans l'annuaire");
    const code = randomBytes(8).toString("hex");
    codes.set(code, { email, dir: req.params.dir, redirect_uri, client_id, nonce, challenge: code_challenge, exp: Date.now() + 120_000 });
    const back = new URL(String(redirect_uri)); back.searchParams.set("code", code); back.searchParams.set("state", String(state));
    res.redirect(back.href);
  });

  r.post("/oidc/:dir/v2.0/token", known, (req, res) => {
    const p = req.body || {};
    if (!p.client_id || !p.client_secret) return res.status(401).json({ error: "invalid_client" });
    if (p.grant_type === "authorization_code") {
      const c = codes.get(p.code); codes.delete(p.code);
      if (!c || c.dir !== req.params.dir || c.exp < Date.now() || c.client_id !== p.client_id || c.redirect_uri !== p.redirect_uri) return res.status(400).json({ error: "invalid_grant" });
      if (c.challenge && createHash("sha256").update(String(p.code_verifier || "")).digest("base64url") !== c.challenge) return res.status(400).json({ error: "invalid_grant", error_description: "PKCE" });
      return res.json({ access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: TTL, id_token: idToken(issuerOf(req), c.dir, p.client_id, c.email, c.nonce), refresh_token: `rt.${enc({ email: c.email, dir: c.dir, r: randomBytes(4).toString("hex") })}` });
    }
    if (p.grant_type === "refresh_token") {
      let t; try { t = JSON.parse(Buffer.from(String(p.refresh_token).slice(3), "base64url").toString()); } catch { t = null; }
      if (!t || t.dir !== req.params.dir || !DIRECTORY[t.email]) return res.status(400).json({ error: "invalid_grant" });
      if (disabled.has(t.email)) return res.status(400).json({ error: "invalid_grant", error_description: "AADSTS50057: compte désactivé (simulé)" });
      return res.json({ access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: TTL, refresh_token: `rt.${enc({ ...t, r: randomBytes(4).toString("hex") })}` });
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  // Démonstration de la coupure : désactiver un compte (POST, comme une action d'administrateur), puis le réactiver.
  r.post("/oidc/_admin/:action", (req, res) => {
    const email = String(req.body?.email || "");
    if (!DIRECTORY[email] || !["disable", "enable"].includes(req.params.action)) return res.status(400).json({ error: "compte ou action inconnus" });
    if (req.params.action === "disable") disabled.add(email); else disabled.delete(email);
    res.json({ email, disabled: disabled.has(email) });
  });
  return r;
}
