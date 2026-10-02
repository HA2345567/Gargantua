import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import type { QuotePayload } from "../types.js";
import { parseFixed } from "../core/parlay.js";

const DOMAIN = Buffer.from("GARGANTUA_PARLAY_QUOTE_V1", "utf8");
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export interface SolanaQuoteConfig {
  programId: string;
  mint: string;
  privateKeyPem: string;
}

function base58Decode(value: string): Buffer {
  if (!value || value.length > 64) throw new Error("invalid Solana public key");
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error("invalid Solana public key");
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) { bytes.unshift(Number(number & 0xffn)); number >>= 8n; }
  for (const char of value) { if (char !== "1") break; bytes.unshift(0); }
  if (bytes.length !== 32) throw new Error("Solana public keys must decode to 32 bytes");
  return Buffer.from(bytes);
}

function base58Encode(input: Uint8Array): string {
  let number = BigInt(`0x${Buffer.from(input).toString("hex") || "0"}`);
  let encoded = "";
  while (number > 0n) { const digit = Number(number % 58n); encoded = BASE58[digit]! + encoded; number /= 58n; }
  for (const byte of input) { if (byte !== 0) break; encoded = `1${encoded}`; }
  return encoded;
}

function sha256(value: Uint8Array): Buffer { return createHash("sha256").update(value).digest(); }
function i64le(value: bigint): Buffer {
  const output = Buffer.alloc(8);
  output.writeBigInt64LE(value);
  return output;
}
function u64le(value: bigint): Buffer {
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(value);
  return output;
}

/** Create the exact digest consumed by gargantua-escrow's preceding Ed25519 instruction. */
export function createSolanaQuote(payload: QuotePayload, ownerAddress: string, config: SolanaQuoteConfig) {
  const owner = base58Decode(ownerAddress);
  const programId = base58Decode(config.programId);
  const mint = base58Decode(config.mint);
  const privateKey = createPrivateKey(config.privateKeyPem.replaceAll("\\n", "\n"));
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const signerPublicKey = publicDer.subarray(publicDer.length - 32);
  const nonce = sha256(Buffer.from(payload.nonce, "utf8"));
  const legsHash = sha256(Buffer.from(JSON.stringify(payload.legs), "utf8"));
  const stake = parseFixed(payload.stake, 6);
  const maxPayout = parseFixed(payload.payout, 6);
  if (stake === null || maxPayout === null || stake <= 0n) throw new Error("quote has invalid token amounts");
  const expiresAt = BigInt(Math.floor(Date.parse(payload.expiresAt) / 1000));
  const digest = sha256(Buffer.concat([
    DOMAIN, programId, mint, owner, nonce, u64le(stake), u64le(maxPayout), i64le(expiresAt), legsHash,
  ]));
  const signature = sign(null, digest, privateKey);
  return {
    programId: config.programId,
    mint: config.mint,
    owner: ownerAddress,
    quoteSigner: base58Encode(signerPublicKey),
    nonce: nonce.toString("hex"),
    stake: stake.toString(),
    maxPayout: maxPayout.toString(),
    expiresAt: expiresAt.toString(),
    legsHash: legsHash.toString("hex"),
    digest: digest.toString("hex"),
    signature: signature.toString("hex"),
  };
}
