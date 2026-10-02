import type { Pool } from "pg";
import type { MarketRecord, PricePoint } from "../types.js";
import type { VenueAdapter } from "../venues/adapter.js";

type Cached = { point: PricePoint; expires: number };
export class PriceService {
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<PricePoint | null>>();
  constructor(private readonly pool: Pool, private readonly adapters: VenueAdapter[], private readonly ttlMs: number, private readonly maxAgeMs: number) {}
  async get(marketId: string, forceRefresh = false): Promise<{ market: MarketRecord; price: PricePoint; ageMs: number } | null> {
    const row = await this.pool.query<Record<string, unknown>>("SELECT * FROM markets WHERE id=$1 AND status='open' AND is_combo=false AND close_time > now()", [marketId]);
    const raw = row.rows[0]; if (!raw) return null;
    const market: MarketRecord = { id:String(raw.id),venue:raw.venue as MarketRecord["venue"],venueMarketId:String(raw.venue_market_id),eventId:String(raw.event_id),title:String(raw.title),category:String(raw.category),rulesText:String(raw.rules_text),closeTime:new Date(String(raw.close_time)),status:String(raw.status),yesTokenId:raw.yes_token_id == null ? null : String(raw.yes_token_id),noTokenId:raw.no_token_id == null ? null : String(raw.no_token_id),conditionId:raw.condition_id == null ? null : String(raw.condition_id),equivalenceGroup:raw.equivalence_group == null ? null : String(raw.equivalence_group),isCombo:Boolean(raw.is_combo) };
    const cached = this.cache.get(marketId);
    let point = !forceRefresh && cached && cached.expires > Date.now() ? cached.point : null;
    if (!point) {
      let request = this.pending.get(marketId);
      if (!request) {
        const adapter = this.adapters.find((item) => item.venue === market.venue);
        request = (adapter ? adapter.getPrice(market).catch(() => null) : Promise.resolve(null)).finally(() => {
          if (this.pending.get(marketId) === request) this.pending.delete(marketId);
        });
        this.pending.set(marketId, request);
      }
      point = await request;
      if (point) {
        if (this.cache.size >= 2_000) for (const [key, value] of this.cache) { if (value.expires <= Date.now() || this.cache.size >= 1_800) this.cache.delete(key); }
        this.cache.set(marketId, { point, expires: Date.now() + this.ttlMs });
      }
    }
    if (!point) return null;
    const ageMs = Date.now() - Date.parse(point.ingestedTs);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > this.maxAgeMs) return null;
    return { market, price: point, ageMs };
  }
}
