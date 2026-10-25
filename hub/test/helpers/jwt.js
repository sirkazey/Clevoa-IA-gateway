// Signature RS256 des id_token des annuaires simulés, comme un vrai annuaire : le hub vérifie la signature avec la clé publiée
// (openid-client). `sign(claims, { tamper })` produit, à la demande, une signature falsifiée pour les tests d'usurpation.
import { generateKeyPairSync, createSign } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "cle-de-test";
export const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function sign(claims, { tamper = false } = {}) {
  const head = b64({ alg: "RS256", typ: "JWT", kid: KID }), body = b64(claims);
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
  return `${head}.${body}.${tamper ? `${sig.slice(0, -6)}AAAAAA` : sig}`;
}

/** Métadonnées OIDC d'un annuaire simulé d'émetteur `issuer` (points de terminaison sous `base`). */
export const discovery = (issuer, { authorize, token, keys }) => ({
  issuer, authorization_endpoint: authorize, token_endpoint: token, jwks_uri: keys,
  response_types_supported: ["code"], subject_types_supported: ["pairwise"], id_token_signing_alg_values_supported: ["RS256"],
});
