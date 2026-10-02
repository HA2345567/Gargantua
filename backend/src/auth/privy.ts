import { createPublicKey, verify } from "node:crypto";

export interface PrivyClaims { sub: string; aud: string | string[]; iss: string; exp: number; iat?: number }

function publicKeyFromConfig(value: string) {
  const pem = value.replaceAll("\\n", "\n");
  if (pem.includes("BEGIN PUBLIC KEY")) return createPublicKey(pem);
  const hex = pem.replace(/^0x/, "");
  if (!/^[a-f\d]+$/i.test(hex)) throw new Error("PRIVY_VERIFICATION_KEY must be a PEM public key or hex P-256 point");
  const raw = Buffer.from(hex, "hex");
  const point = raw.length === 64 ? Buffer.concat([Buffer.from([4]), raw]) : raw;
  if (point.length !== 65 || point[0] !== 4) throw new Error("PRIVY_VERIFICATION_KEY must contain a 65-byte uncompressed P-256 point");
  const spkiPrefix = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, point]), format: "der", type: "spki" });
}

/** Verify Privy's ES256 access token and bind audience/issuer/expiry before using its DID. */
export function verifyPrivyAccessToken(token: string, appId: string, verificationKey: string, nowSeconds = Math.floor(Date.now() / 1000)): PrivyClaims {
  if (token.length > 8192) throw new Error("invalid token");
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("invalid token");
  const [encodedHeader, encodedClaims, encodedSignature] = segments as [string, string, string];
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { alg?: string };
  const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as Partial<PrivyClaims>;
  if (header.alg !== "ES256") throw new Error("unsupported token algorithm");
  const signingInput = Buffer.from(`${encodedHeader}.${encodedClaims}`);
  const signature = Buffer.from(encodedSignature, "base64url");
  if (signature.length !== 64 || !verify("sha256", signingInput, { key: publicKeyFromConfig(verificationKey), dsaEncoding: "ieee-p1363" }, signature)) throw new Error("invalid token signature");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== "privy.io" || !audiences.includes(appId) || !Number.isInteger(claims.exp) || claims.exp! <= nowSeconds || (claims.iat !== undefined && claims.iat > nowSeconds + 60) || typeof claims.sub !== "string" || !claims.sub.startsWith("did:privy:")) throw new Error("invalid token claims");
  return claims as PrivyClaims;
}
