import { createHash } from "node:crypto";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { formatFixed, floorPayout, parseFixed } from "../core/parlay.js";
import type { MarketRecord, Resolution, Venue } from "../types.js";
import type { ResolutionSource } from "./resolution-source.js";

type ChainLeg = {
  parlay_id: string; idx: number; market_id: string; side: "YES"|"NO";
  venue: Venue; venue_market_id: string; event_id: string; title: string; category: string;
  rules_text: string; close_time: Date; market_status: string; yes_token_id: string|null;
  no_token_id: string|null; condition_id: string|null; equivalence_group: string|null; is_combo: boolean;
};
type OpenParlay = { id: string; parlay_address: string; wallet_address: string; mint: string; stake: string; multiplier: string; status: string };

function asMarket(row: ChainLeg): MarketRecord {
  return { id:row.market_id,venue:row.venue,venueMarketId:row.venue_market_id,eventId:row.event_id,title:row.title,category:row.category,rulesText:row.rules_text,closeTime:new Date(row.close_time),status:row.market_status,yesTokenId:row.yes_token_id,noTokenId:row.no_token_id,conditionId:row.condition_id,equivalenceGroup:row.equivalence_group,isCombo:row.is_combo };
}

function legResult(resolution: Resolution, side: "YES"|"NO"): "pending"|"win"|"lose"|"void" {
  if (resolution === "pending") return "pending";
  if (resolution === "void") return "void";
  return (resolution === "yes") === (side === "YES") ? "win" : "lose";
}

function signerKeypairs(encoded: string | undefined): Keypair[] {
  if (!encoded) return [];
  const arrays = JSON.parse(encoded) as number[][];
  return arrays.map((secret) => Keypair.fromSecretKey(Uint8Array.from(secret)));
}

function settleInstruction(programId: PublicKey, accounts: {
  config: PublicKey; parlay: PublicKey; owner: PublicKey; mint: PublicKey;
  ownerTokens: PublicKey; parlayVault: PublicKey; houseVault: PublicKey; signers: Keypair[];
}, result: number, payout: bigint): TransactionInstruction {
  const discriminator = createHash("sha256").update("global:settle_parlay").digest().subarray(0,8);
  const payoutBytes = Buffer.alloc(8); payoutBytes.writeBigUInt64LE(payout);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey:accounts.config,isSigner:false,isWritable:false },
      { pubkey:accounts.parlay,isSigner:false,isWritable:true },
      { pubkey:accounts.owner,isSigner:false,isWritable:true },
      { pubkey:accounts.mint,isSigner:false,isWritable:false },
      { pubkey:accounts.ownerTokens,isSigner:false,isWritable:true },
      { pubkey:accounts.parlayVault,isSigner:false,isWritable:true },
      { pubkey:accounts.houseVault,isSigner:false,isWritable:true },
      { pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false },
      ...accounts.signers.map((signer)=>({pubkey:signer.publicKey,isSigner:true,isWritable:false})),
    ],
    data: Buffer.concat([discriminator,Buffer.from([result]),payoutBytes]),
  });
}

async function submitSettlement(connection: Connection, config: AppConfig, parlay: OpenParlay, signers: Keypair[], result: number, payout: bigint): Promise<string> {
  const programId = new PublicKey(config.SOLANA_PROGRAM_ID!);
  const mint = new PublicKey(parlay.mint);
  const owner = new PublicKey(parlay.wallet_address);
  const parlayAddress = new PublicKey(parlay.parlay_address);
  const [configAddress] = PublicKey.findProgramAddressSync([Buffer.from("config")],programId);
  const houseVault = getAssociatedTokenAddressSync(mint,configAddress,true);
  const instruction = settleInstruction(programId,{config:configAddress,parlay:parlayAddress,owner,mint,ownerTokens:getAssociatedTokenAddressSync(mint,owner),parlayVault:getAssociatedTokenAddressSync(mint,parlayAddress,true),houseVault,signers},result,payout);
  const latestBlockhash=await connection.getLatestBlockhash("confirmed");
  const transaction=new Transaction({feePayer:signers[0]!.publicKey,blockhash:latestBlockhash.blockhash,lastValidBlockHeight:latestBlockhash.lastValidBlockHeight}).add(instruction);
  return sendAndConfirmTransaction(connection,transaction,signers,{commitment:"confirmed"});
}

/** Poll venue outcomes for chain positions and submit threshold-signed terminal settlement. */
export async function runSolanaSettlement(pool: Pool, source: ResolutionSource, config: AppConfig): Promise<{ checked: number; settled: number }> {
  if (!config.SOLANA_PROGRAM_ID || !config.SOLANA_ESCROW_MINT) return { checked:0,settled:0 };
  const connection = new Connection(config.SOLANA_RPC_URL,"confirmed");
  const signers = signerKeypairs(config.SOLANA_SETTLEMENT_SIGNER_KEYPAIRS);
  const pending = await pool.query<ChainLeg>(
    `SELECT l.parlay_id,l.idx,l.market_id,l.side,m.venue,m.venue_market_id,m.event_id,m.title,m.category,m.rules_text,m.close_time,m.status AS market_status,m.yes_token_id,m.no_token_id,m.condition_id,m.equivalence_group,m.is_combo FROM solana_parlay_legs l JOIN solana_parlays p ON p.id=l.parlay_id JOIN markets m ON m.id=l.market_id WHERE p.status='open' AND l.result='pending' ORDER BY p.created_at LIMIT 500`,
  );
  const marketCache=new Map<string,{resolution:Resolution;raw:unknown}>();
  for(const row of pending.rows){
    let evidence=marketCache.get(row.market_id);
    if(!evidence){evidence=await source.getResolution(asMarket(row));marketCache.set(row.market_id,evidence);}
    const outcome=legResult(evidence.resolution,row.side);
    if(outcome==="pending") continue;
    await pool.query("UPDATE solana_parlay_legs SET result=$3::leg_result,resolved_at=now(),raw_resolution=$4::jsonb WHERE parlay_id=$1 AND idx=$2 AND result='pending'",[row.parlay_id,row.idx,outcome,JSON.stringify({resolution:evidence.resolution,sourcePayload:evidence.raw,checkedAt:new Date().toISOString()})]);
  }
  const open=await pool.query<OpenParlay>("SELECT id,parlay_address,wallet_address,mint,stake::text AS stake,multiplier::text AS multiplier,status FROM solana_parlays WHERE status='open' ORDER BY created_at LIMIT 500");
  let settled=0;
  for(const parlay of open.rows){
    const legs=await pool.query<{result:string;factor:string}>("SELECT result,factor::text AS factor FROM solana_parlay_legs WHERE parlay_id=$1 ORDER BY idx",[parlay.id]);
    if(legs.rows.some((leg)=>leg.result==="pending")) continue;
    const stake=parseFixed(parlay.stake,6)!;
    let result:number,payout:bigint,status:"won"|"lost"|"void";
    if(legs.rows.some((leg)=>leg.result==="lose")){result=0;payout=0n;status="lost";}
    else if(legs.rows.some((leg)=>leg.result==="void")){result=2;payout=stake;status="void";}
    else {result=1;payout=floorPayout(stake,parseFixed(parlay.multiplier,12)!);status="won";}
    if(signers.length===0) continue;
    try {
      const signature=await submitSettlement(connection,config,parlay,signers,result,payout);
      await pool.query("UPDATE solana_parlays SET status=$2,payout=$3,settlement_signature=$4,settled_at=now() WHERE id=$1 AND status='open'",[parlay.id,status,formatFixed(payout,6),signature]);
      settled++;
    } catch(error) {
      // Keep the position open for retry; do not mark it settled when the chain call failed.
      if (error instanceof Error) console.error("Solana settlement submission failed",{parlayId:parlay.id,message:error.message});
    }
  }
  return { checked:pending.rows.length,settled };
}
