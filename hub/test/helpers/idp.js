// Annuaires OIDC simulés pour les tests du serveur OAuth du hub : des Entra (émetteur /entra/<annuaire>/v2.0, oid + tid) et un
// Google (/google, hd), avec découverte, PKCE, nonce, refresh, compte désactivé, panne et id_token falsifiable.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

export const USERS = {
  marie: { kind: "entra", oid: "oid-marie", upn: "marie.dupont@charlois.com", name: "Marie Dupont" },
  paul: { kind: "entra", oid: "oid-paul", upn: "paul.martin@charlois.com", name: "Paul Martin" },
  jack: { kind: "entra", oid: "oid-jack", upn: "jack.reed@oakwoodcooperage.com", name: "Jack Reed" },
  lea: { kind: "google", sub: "g-lea", email: "lea.bernard@acquise.example", hd: "acquise.example", name: "Léa Bernard" },
  perso: { kind: "google", sub: "g-perso", email: "quelquun@gmail.com", name: "Compte personnel" },
  intrus: { kind: "google", sub: "g-intrus", email: "x@autre.example", hd: "autre.example", name: "Autre société" },
};
export const SECRET = "secret-de-l-annuaire";

export async function startIdp() {
  const st = { next: "marie", flaw: "", disabled: new Set(), down: false, refreshes: 0, lastAuthorize: null };
  const codes = new Map();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  let base;

  function idToken(issuer, tenant, clientId, user, nonce) {
    const u = USERS[user], f = st.flaw, now = Math.floor(Date.now() / 1000);
    const common = { iss: f === "iss" ? "http://evil.example.invalid" : issuer, aud: f === "aud" ? "autre-appli" : clientId, nonce: f === "nonce" ? "autre" : nonce, iat: now, exp: f === "exp" ? now - 10 : now + 3600, name: u.name };
    const claims = u.kind === "entra"
      ? { ...common, oid: u.oid, sub: `pairwise-${u.oid}`, tid: f === "tid" ? "autre-annuaire" : tenant, preferred_username: u.upn, email: u.upn, ...(f === "guest" ? { idp: "https://sts.windows.net/annuaire-d-origine/" } : {}) }
      : { ...common, sub: u.sub, email: u.email, email_verified: true, ...(u.hd ? { hd: u.hd } : {}) };
    return [b64({ alg: "none" }), b64(claims), ""].join(".");
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base), path = url.pathname;
    let body = ""; for await (const c of req) body += c;
    const p = new URLSearchParams(body);
    const m = path.match(/^\/(entra\/([^/]+)\/v2\.0|google)(\/.*)$/);
    if (!m) return json(res, 404, {});
    const issuer = `${base}/${m[1]}`, tenant = m[2] || "", rest = m[3];
    if (rest === "/.well-known/openid-configuration")
      return json(res, 200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ["code"] });
    if (rest === "/authorize") { // pas d'interface : le compte `st.next` approuve (ou refuse avec "deny")
      st.lastAuthorize = url.searchParams;
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("state", url.searchParams.get("state"));
      if (st.next === "deny") back.searchParams.set("error", "access_denied");
      else {
        const code = randomBytes(8).toString("hex");
        codes.set(code, { user: st.next, nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge"), redirect: url.searchParams.get("redirect_uri"), issuer });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { Location: back.href }); return res.end();
    }
    if (rest === "/token" && req.method === "POST") {
      if (st.down) return json(res, 503, { error: "temporarily_unavailable" });
      if (p.get("client_secret") !== SECRET) return json(res, 401, { error: "invalid_client" });
      if (p.get("grant_type") === "authorization_code") {
        const c = codes.get(p.get("code")); codes.delete(p.get("code"));
        if (!c || c.issuer !== issuer || c.redirect !== p.get("redirect_uri")) return json(res, 400, { error: "invalid_grant" });
        if (createHash("sha256").update(p.get("code_verifier") || "").digest("base64url") !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE" });
        return json(res, 200, { access_token: `at-${c.user}`, token_type: "Bearer", id_token: idToken(issuer, tenant, p.get("client_id"), c.user, c.nonce), refresh_token: `rt-${c.user}-${randomBytes(4).toString("hex")}` });
      }
      if (p.get("grant_type") === "refresh_token") {
        st.refreshes++;
        const user = p.get("refresh_token")?.match(/^rt-(\w+)-/)?.[1];
        if (!user || st.disabled.has(user)) return json(res, 400, { error: "invalid_grant", error_description: "AADSTS50057: compte désactivé" });
        return json(res, 200, { access_token: `at-${user}`, token_type: "Bearer", refresh_token: `rt-${user}-${randomBytes(4).toString("hex")}` });
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    json(res, 404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base, state: st,
    entra: (tenant) => `${base}/entra/${tenant}/v2.0`,
    google: `${base}/google`,
    stop: () => new Promise((r) => server.close(r)),
  };
}
