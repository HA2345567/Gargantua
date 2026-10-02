import { createHmac, timingSafeEqual } from "node:crypto";
import type { QuotePayload } from "../types.js";

function encode(payload: QuotePayload): string { return Buffer.from(JSON.stringify(payload)).toString("base64url"); }
function signature(encoded: string, secret: string): string { return createHmac("sha256", secret).update(encoded).digest("base64url"); }
export function signQuote(payload: QuotePayload, secret: string): string { const encoded = encode(payload); return `${encoded}.${signature(encoded, secret)}`; }
export function verifyQuote(token: string, secret: string): QuotePayload | null {
  const [encoded, supplied, extra] = token.split("."); if (!encoded || !supplied || extra) return null;
  const expected = signature(encoded, secret), a = Buffer.from(supplied), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as QuotePayload;
    if (payload.v !== 1 || !payload.userId || !payload.nonce || !Array.isArray(payload.legs) || payload.legs.length < 2 || payload.legs.length > 5) return null;
    return payload;
  } catch { return null; }
}
