import { createPublicKey, verify } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function decodeSolanaAddress(address: string): Buffer {
  if (address.length < 32 || address.length > 44) throw new Error("invalid Solana address");
  let value = 0n;
  for (const char of address) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("invalid Solana address");
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) { bytes.unshift(Number(value & 255n)); value >>= 8n; }
  for (const char of address) { if (char !== "1") break; bytes.unshift(0); }
  if (bytes.length !== 32) throw new Error("invalid Solana address");
  return Buffer.from(bytes);
}

export function verifySolanaWalletBinding(address: string, message: string, signatureBase64: string): boolean {
  try {
    const publicKey = decodeSolanaAddress(address);
    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.length !== 64) return false;
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]);
    return verify(null, Buffer.from(message, "utf8"), createPublicKey({ key: spki, format: "der", type: "spki" }), signature);
  } catch {
    return false;
  }
}
