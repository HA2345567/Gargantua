import type { MarketRecord, PricePoint, Resolution, Venue } from "../types.js";

export interface VenueAdapter {
  readonly venue: Venue;
  listMarkets(limit: number): Promise<MarketRecord[]>;
  getPrice(market: MarketRecord): Promise<PricePoint | null>;
  getResolution(market: MarketRecord): Promise<{ resolution: Resolution; raw: unknown }>;
}
