import type { MarketRecord, Resolution } from "../types.js";
import type { VenueAdapter } from "../venues/adapter.js";

export interface ResolutionSource {
  getResolution(market: MarketRecord): Promise<{ resolution: Resolution; raw: unknown }>;
}

/** Routes resolution reads to the read-only venue adapter for each market. */
export class VenueResolutionSource implements ResolutionSource {
  private readonly byVenue: Map<string, VenueAdapter>;

  constructor(adapters: VenueAdapter[]) {
    this.byVenue = new Map(adapters.map((adapter) => [adapter.venue, adapter]));
  }

  async getResolution(market: MarketRecord): Promise<{ resolution: Resolution; raw: unknown }> {
    const adapter = this.byVenue.get(market.venue);
    if (!adapter) return { resolution: "pending", raw: null };
    return adapter.getResolution(market);
  }
}
