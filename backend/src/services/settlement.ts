import type { Pool } from "pg";
import { withTx } from "../db/pool.js";
import { formatFixed, parseFixed, productFactors } from "../core/parlay.js";
import type { MarketRecord, Resolution, Venue } from "../types.js";
import type { ResolutionSource } from "./resolution-source.js";
import { PostgresVirtualLedger } from "./ledger.js";
import type { OperationalMetrics } from "./metrics.js";
import { asRecord } from "../venues/http.js";

type Pending = { parlay_id: string; idx: number; side: "YES" | "NO"; market_id: string; venue: Venue; venue_market_id: string; event_id: string; title: string; category: string; rules_text: string; close_time: Date; status: string; yes_token_id: string | null; no_token_id: string | null; condition_id: string | null; equivalence_group: string | null; is_combo: boolean };
function market(row: Pending): MarketRecord { return { id:row.market_id,venue:row.venue,venueMarketId:row.venue_market_id,eventId:row.event_id,title:row.title,category:row.category,rulesText:row.rules_text,closeTime:new Date(row.close_time),status:row.status,yesTokenId:row.yes_token_id,noTokenId:row.no_token_id,conditionId:row.condition_id,equivalenceGroup:row.equivalence_group,isCombo:row.is_combo }; }
function venueResolutionTimestamp(venue: Venue, raw: unknown): number | null {
  const top = asRecord(raw);
  const source = venue === "kalshi" ? asRecord(top?.market) : top;
  const value = venue === "kalshi" ? source?.settlement_ts : source?.umaResolutionStatusTimestamp;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function runSettlement(pool: Pool, resolutionSource: ResolutionSource, metrics?: OperationalMetrics): Promise<{ checked: number; settled: number }> {
  const ledger = new PostgresVirtualLedger();
  const found = await pool.query<Pending>(`SELECT l.parlay_id,l.idx,l.side,m.id AS market_id,m.* FROM parlay_legs l JOIN parlays p ON p.id=l.parlay_id JOIN markets m ON m.id=l.market_id WHERE p.status='open' AND l.result='pending' ORDER BY p.created_at LIMIT 500`);
  const byMarket = new Map<string, Promise<{ resolution: Resolution; raw: unknown }>>();
  for (const row of found.rows) {
    if (!byMarket.has(row.market_id)) byMarket.set(row.market_id, resolutionSource.getResolution(market(row)).catch(() => ({ resolution: "pending", raw: null })));
  }
  let settled = 0;
  for (const [marketId, request] of byMarket) {
    const evidence = await request, resolution = evidence.resolution; if (resolution === "pending") continue;
    const resolvedAt = venueResolutionTimestamp(found.rows.find((row) => row.market_id === marketId)!.venue, evidence.raw);
    if (resolvedAt !== null && resolvedAt <= Date.now()) metrics?.observeSettlementLag(Date.now() - resolvedAt);
    const applicable = found.rows.filter((row) => row.market_id === marketId);
    for (const row of applicable) await withTx(pool, async (client) => {
      const parlayResult = await client.query<{ id: string; status: string; stake: string }>("SELECT id,status,stake::text AS stake FROM parlays WHERE id=$1 FOR UPDATE", [row.parlay_id]);
      if (!parlayResult.rows[0] || parlayResult.rows[0].status !== "open") return;
      const result = resolution === "void" ? "void" : (resolution === "yes") === (row.side === "YES") ? "win" : "lose";
      const updatedLeg = await client.query("UPDATE parlay_legs SET result=$3::leg_result,resolved_at=now(),raw_resolution=$4::jsonb WHERE parlay_id=$1 AND idx=$2 AND result='pending' RETURNING idx", [row.parlay_id,row.idx,result,JSON.stringify({ venue: row.venue, venueMarketId: row.venue_market_id, resolution, checkedAt: new Date().toISOString(), sourcePayload: evidence.raw })]);
      if (updatedLeg.rowCount !== 1) return;
      if (result === "lose") await client.query("UPDATE parlays SET status='lost',payout=0,settled_at=now() WHERE id=$1 AND status='open'", [row.parlay_id]);
    });
  }
  const open = await pool.query<{ id: string; user_id: string; stake: string }>("SELECT p.id,p.user_id,p.stake::text AS stake FROM parlays p WHERE p.status='open' AND NOT EXISTS (SELECT 1 FROM parlay_legs l WHERE l.parlay_id=p.id AND l.result='pending') ORDER BY p.created_at LIMIT 500");
  for (const item of open.rows) {
    await withTx(pool, async (client) => {
      const parlay = await client.query<{ user_id: string; stake: string; status: string }>("SELECT user_id,stake::text AS stake,status FROM parlays WHERE id=$1 FOR UPDATE", [item.id]);
      if (!parlay.rows[0] || parlay.rows[0].status !== "open") return;
      const legs = await client.query<{ result: string; factor: string }>("SELECT result,factor::text AS factor FROM parlay_legs WHERE parlay_id=$1", [item.id]);
      if (legs.rows.some((l) => l.result === "pending")) return;
      let payout = 0n; let status: "won" | "lost" | "void";
      if (legs.rows.some((l) => l.result === "lose")) status = "lost";
      else {
        const winning = legs.rows.filter((l) => l.result === "win");
        if (!winning.length) { status = "void"; payout = parseFixed(parlay.rows[0].stake, 6)!; }
        else {
          status = "won"; const multiplier = productFactors(winning.map((leg) => leg.factor));
          payout = parseFixed(parlay.rows[0].stake, 6)! * multiplier / 1_000_000_000_000n;
        }
      }
      const payoutText = formatFixed(payout, 6);
      await client.query("UPDATE parlays SET status=$2::parlay_status,payout=$3,settled_at=now() WHERE id=$1", [item.id,status,payoutText]);
      if (payout > 0n) await ledger.credit(client, { userId: parlay.rows[0].user_id, amount: payoutText, parlayId: item.id, kind: status === "void" ? "refund" : "payout" });
      settled += 1;
    });
  }
  await pool.query("INSERT INTO system_state(key,value) VALUES ('settlement',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()", [JSON.stringify({ lastRunAt: new Date().toISOString(), lastError: null, checked: found.rows.length, settled })]);
  return { checked: found.rows.length, settled };
}
