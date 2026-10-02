import { createHash } from "node:crypto";
import type { QuotePayload } from "../types.js";
import type { SolanaQuoteConfig } from "./quote.js";
import { createSolanaQuote } from "./quote.js";
import { decodeSolanaAddress } from "../auth/solana-wallet.js";

function decodeBase58(input: string): Buffer {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const character of input) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("invalid base58 data");
    value = value * 58n + BigInt(digit);
  }
  const decoded: number[] = [];
  while (value > 0n) { decoded.unshift(Number(value & 255n)); value >>= 8n; }
  for (const character of input) { if (character !== "1") break; decoded.unshift(0); }
  return Buffer.from(decoded);
}

function bytes(hex: string): Buffer { return Buffer.from(hex, "hex"); }
function same(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((byte, index) => byte === b[index]); }
function u64le(value: bigint): Buffer { const output = Buffer.alloc(8); output.writeBigUInt64LE(value); return output; }
function i64le(value: bigint): Buffer { const output = Buffer.alloc(8); output.writeBigInt64LE(value); return output; }

async function rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "gargantua-confirm", method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}`);
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined) throw new Error(body.error?.message ?? "Solana RPC response was empty");
  return body.result;
}

/** Verify that the submitted signature executed this exact signed quote and created its PDA account. */
export async function confirmSolanaAcceptance(input: {
  rpcUrl: string;
  quote: QuotePayload;
  owner: string;
  parlayAddress: string;
  transactionSignature: string;
  config: SolanaQuoteConfig;
}): Promise<void> {
  const signed = createSolanaQuote(input.quote, input.owner, input.config);
  const statuses = await rpc<Array<{ err: unknown; confirmationStatus?: string } | null>>(input.rpcUrl, "getSignatureStatuses", [[input.transactionSignature], { searchTransactionHistory: true }]);
  const status = statuses[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) throw new Error("Solana transaction is not confirmed successfully");

  const transaction = await rpc<{ transaction: { message: { instructions: Array<{ programId?: string; data?: string }> } } } | null>(input.rpcUrl, "getTransaction", [input.transactionSignature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  if (!transaction) throw new Error("Solana transaction is not available at confirmed commitment");
  const expectedInstructionData = Buffer.concat([
    createHash("sha256").update("global:accept_parlay").digest().subarray(0, 8),
    bytes(signed.nonce), u64le(BigInt(signed.stake)), u64le(BigInt(signed.maxPayout)), i64le(BigInt(signed.expiresAt)), bytes(signed.legsHash),
  ]);
  const hasAcceptanceInstruction = transaction.transaction.message.instructions.some((instruction) =>
    instruction.programId === input.config.programId && instruction.data !== undefined && same(decodeBase58(instruction.data), expectedInstructionData));
  if (!hasAcceptanceInstruction) throw new Error("confirmed transaction does not contain this parlay acceptance instruction");

  const accountResult = await rpc<{ value: { owner: string; data: [string, string]; executable: boolean } | null }>(input.rpcUrl, "getAccountInfo", [input.parlayAddress, { commitment: "confirmed", encoding: "base64" }]);
  const account = accountResult.value;
  if (!account || account.executable || account.owner !== input.config.programId) throw new Error("parlay PDA account is missing or owned by another program");
  const data = Buffer.from(account.data[0], "base64");
  const expectedOwner = decodeSolanaAddress(input.owner);
  const expectedMint = decodeSolanaAddress(input.config.mint);
  const expectedNonce = bytes(signed.nonce);
  const expectedLegs = bytes(signed.legsHash);
  const expectedDigest = bytes(signed.digest);
  const discriminator = createHash("sha256").update("account:Parlay").digest().subarray(0, 8);
  const stake = data.length >= 112 ? data.readBigUInt64LE(104) : 0n;
  const maxPayout = data.length >= 120 ? data.readBigUInt64LE(112) : 0n;
  const expiresAt = data.length >= 128 ? data.readBigInt64LE(120) : 0n;
  if (data.length < 202
    || !same(data.subarray(0, 8), discriminator)
    || !same(data.subarray(8, 40), expectedOwner)
    || !same(data.subarray(40, 72), expectedMint)
    || !same(data.subarray(72, 104), expectedNonce)
    || stake !== BigInt(signed.stake)
    || maxPayout !== BigInt(signed.maxPayout)
    || expiresAt !== BigInt(signed.expiresAt)
    || !same(data.subarray(128, 160), expectedLegs)
    || !same(data.subarray(160, 192), expectedDigest)
    || data[192] !== 0) throw new Error("on-chain parlay state does not match the signed quote");
}
