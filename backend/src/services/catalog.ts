import type { Pool, PoolClient } from "pg";
import { withTx } from "../db/pool.js";
import type { MarketRecord, Venue } from "../types.js";
import type { VenueAdapter } from "../venues/adapter.js";

async function upsert(client: PoolClient, m: MarketRecord): Promise<void> {
  await client.query(`INSERT INTO markets (id,venue,venue_market_id,event_id,title,category,rules_text,close_time,status,yes_token_id,no_token_id,condition_id,equivalence_group,is_combo)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (id) DO UPDATE SET event_id=EXCLUDED.event_id,title=EXCLUDED.title,category=EXCLUDED.category,rules_text=EXCLUDED.rules_text,close_time=EXCLUDED.close_time,status=EXCLUDED.status,yes_token_id=EXCLUDED.yes_token_id,no_token_id=EXCLUDED.no_token_id,condition_id=EXCLUDED.condition_id,is_combo=EXCLUDED.is_combo,updated_at=now()`,
  [m.id,m.venue,m.venueMarketId,m.eventId,m.title,m.category,m.rulesText,m.closeTime,m.status,m.yesTokenId,m.noTokenId,m.conditionId,m.equivalenceGroup,m.isCombo]);
}
export async function syncVenue(pool: Pool, adapter: VenueAdapter, limit: number, fullSnapshot = false): Promise<number> {
  await pool.query("UPDATE venue_sync_state SET last_started_at=now(),last_error=NULL WHERE venue=$1", [adapter.venue]);
  try {
    const markets = await adapter.listMarkets(limit);
    await withTx(pool, async (client) => {
      // A capped page is not a complete venue snapshot. Do not close markets
      // omitted only because the adapter reached its configured limit.
      if (fullSnapshot || markets.length < limit) {
        await client.query("UPDATE markets SET status='closed',updated_at=now() WHERE venue=$1 AND id <> ALL($2::text[])", [adapter.venue, markets.map((market) => market.id)]);
      }
      for (const market of markets) await upsert(client, market);
      await client.query("UPDATE venue_sync_state SET last_succeeded_at=now(),last_error=NULL,markets_seen=$2 WHERE venue=$1", [adapter.venue, markets.length]);
    });
    return markets.length;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "catalog sync failed";
    await pool.query("UPDATE venue_sync_state SET last_error=$2 WHERE venue=$1", [adapter.venue, message]);
    throw error;
  }
}
export async function syncAll(pool: Pool, adapters: VenueAdapter[], limit: number, fullSnapshot = false): Promise<void> {
  await Promise.all(adapters.map(async (adapter) => { try { await syncVenue(pool, adapter, limit, fullSnapshot); } catch { /* venue state records the isolated failure */ } }));
}
export async function setEquivalenceGroup(pool: Pool, marketId: string, equivalenceGroup: string | null): Promise<{ id: string; equivalenceGroup: string | null } | null> {
  const result = await pool.query<{ id: string; equivalence_group: string | null }>(
    "UPDATE markets SET equivalence_group=$2,updated_at=now() WHERE id=$1 RETURNING id,equivalence_group",
    [marketId, equivalenceGroup],
  );
  const row = result.rows[0];
  return row ? { id: row.id, equivalenceGroup: row.equivalence_group } : null;
}
export function venueFromString(value: string): Venue | null { return value === "kalshi" || value === "polymarket" ? value : null; }
