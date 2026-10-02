import { Buffer } from "buffer";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export interface SignedSolanaQuote {
  programId: string;
  mint: string;
  owner: string;
  quoteSigner: string;
  nonce: string;
  stake: string;
  maxPayout: string;
  expiresAt: string;
  legsHash: string;
  digest: string;
  signature: string;
}

function hex(value: string, bytes: number): Buffer {
  if (!new RegExp(`^[a-f0-9]{${bytes * 2}}$`, "i").test(value)) throw new Error("Malformed signed quote bytes");
  return Buffer.from(value, "hex");
}

function u64le(value: string): Buffer {
  const amount = BigInt(value);
  if (amount <= 0n || amount > 0xffff_ffff_ffff_ffffn) throw new Error("Token amount out of range");
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(amount);
  return buffer;
}

function i64le(value: string): Buffer {
  const seconds = BigInt(value);
  if (seconds < -0x8000_0000_0000_0000n || seconds > 0x7fff_ffff_ffff_ffffn) throw new Error("Quote expiry out of range");
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(seconds);
  return buffer;
}

async function instructionDiscriminator(name: string): Promise<Buffer> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return Buffer.from(hash).subarray(0, 8);
}

/** Build the unsigned acceptance transaction; Privy prompts the user to sign and send it. */
export async function buildAcceptParlayTransaction(
  connection: Connection,
  owner: PublicKey,
  quote: SignedSolanaQuote,
): Promise<{ transaction: Transaction; parlayAddress: PublicKey }> {
  const programId = new PublicKey(quote.programId);
  const mint = new PublicKey(quote.mint);
  if (!owner.equals(new PublicKey(quote.owner))) throw new Error("Connected wallet does not match the quote owner");
  const nonce = hex(quote.nonce, 32);
  const digest = hex(quote.digest, 32);
  const legsHash = hex(quote.legsHash, 32);
  const signature = hex(quote.signature, 64);
  const quoteSigner = new PublicKey(quote.quoteSigner);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [parlayAddress] = PublicKey.findProgramAddressSync([Buffer.from("parlay"), owner.toBuffer(), nonce], programId);
  const ownerTokens = getAssociatedTokenAddressSync(mint, owner);
  const parlayVault = getAssociatedTokenAddressSync(mint, parlayAddress, true);
  const discriminator = await instructionDiscriminator("accept_parlay");
  const data = Buffer.concat([discriminator, nonce, u64le(quote.stake), u64le(quote.maxPayout), i64le(quote.expiresAt), legsHash]);
  const ensureOwnerAta = createAssociatedTokenAccountIdempotentInstruction(owner, ownerTokens, owner, mint);
  const verifyQuoteSignature = Ed25519Program.createInstructionWithPublicKey({ publicKey: quoteSigner.toBytes(), message: digest, signature });
  const accept = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: parlayAddress, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ownerTokens, isSigner: false, isWritable: true },
      { pubkey: parlayVault, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: owner,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });
  // The signature precompile must immediately precede the Anchor acceptance instruction.
  transaction.add(ensureOwnerAta, verifyQuoteSignature, accept);
  return { transaction, parlayAddress };
}
