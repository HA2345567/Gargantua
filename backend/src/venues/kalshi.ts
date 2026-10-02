import { createPrivateKey, sign } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { MarketRecord, PricePoint, Resolution } from "../types.js";
import { asRecord, asString, formatPrice, getJson, isoOrNull, priceToScaled } from "./http.js";
import type { VenueAdapter } from "./adapter.js";

const ROOT = "https://external-api.kalshi.com/trade-api/v2";
type KalshiMarket = Record<string, unknown>;
export function parseKalshiResolution(data: unknown): Resolution {
  const market = asRecord(asRecord(data)?.market);
  if (!market || !["settled", "finalized"].includes(String(market.status).toLowerCase())) return "pending";
  const result = String(market.result ?? "").toLowerCase();
  // Only the observed binary results are terminal. Other result encodings remain pending
  // until Kalshi's public contract and a real payload confirm their meaning.
  return result === "yes" ? "yes" : result === "no" ? "no" : "pending";
}

export class KalshiAdapter implements VenueAdapter {
  readonly venue = "kalshi" as const;
  private readonly base: URL;
  constructor(private readonly config: AppConfig) { this.base = new URL(config.KALSHI_BASE_URL.endsWith("/") ? config.KALSHI_BASE_URL : `${config.KALSHI_BASE_URL}/`); }
  private async request<T>(path: string, query: Record<string, string> = {}): Promise<T | null> {
    const url = new URL(path.replace(/^\//, ""), this.base); for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if (this.config.KALSHI_ACCESS_KEY && this.config.KALSHI_PRIVATE_KEY_PEM) {
      const timestamp = Date.now().toString();
      const message = `${timestamp}GET${url.pathname}`;
      const key = createPrivateKey(this.config.KALSHI_PRIVATE_KEY_PEM.replace(/\\n/g, "\n"));
      const algorithm = key.asymmetricKeyType === "ed25519" ? null : "sha256";
      const signature = sign(algorithm, Buffer.from(message), algorithm ? { key, padding: 6, saltLength: 32 } : key).toString("base64");
      headers["KALSHI-ACCESS-KEY"] = this.config.KALSHI_ACCESS_KEY;
      headers["KALSHI-ACCESS-TIMESTAMP"] = timestamp;
      headers["KALSHI-ACCESS-SIGNATURE"] = signature;
    }
    return getJson<T>(url, 5, headers);
  }
  async listMarkets(limit: number): Promise<MarketRecord[]> {
    const results: MarketRecord[] = []; let cursor = "";
    while (results.length < limit) {
      const page = await this.request<{ markets?: KalshiMarket[]; cursor?: string }>("markets", { status: "open", mve_filter: "exclude", limit: String(Math.min(200, limit - results.length)), ...(cursor ? { cursor } : {}) });
      if (!page) throw new Error("Kalshi catalog request failed");
      if (!page?.markets?.length) break;
      for (const row of page.markets) {
        const ticker = asString(row.ticker), event = asString(row.event_ticker), title = asString(row.title), close = isoOrNull(row.close_time ?? row.expected_expiration_time);
        if (!ticker || !event || !title || !close || Date.parse(close) <= Date.now()) continue;
        if (row.market_type !== "binary" || row.mve_collection_ticker || row.mve_selected_legs || ticker.startsWith("KXMV")) continue;
        results.push({ id: `kalshi:${ticker}`, venue: this.venue, venueMarketId: ticker, eventId: event, title, category: asString(row.category) ?? "", rulesText: [asString(row.rules_primary), asString(row.rules_secondary)].filter(Boolean).join("\n\n"), closeTime: new Date(close), status: "open", yesTokenId: null, noTokenId: null, conditionId: null, equivalenceGroup: null, isCombo: false });
        if (results.length >= limit) break;
      }
      cursor = page.cursor ?? ""; if (!cursor) break;
    }
    return results;
  }
  async getPrice(market: MarketRecord): Promise<PricePoint | null> {
    const book = await this.request<Record<string, unknown>>(`markets/${encodeURIComponent(market.venueMarketId)}/orderbook`, { depth: "1" });
    const data = asRecord(book?.orderbook_fp) ?? asRecord(book?.orderbook); if (!data) return null;
    const yesBids = data.yes_dollars ?? data.yes, noBids = data.no_dollars ?? data.no;
    const topBid = (levels: unknown): bigint | null => {
      if (!Array.isArray(levels)) return null;
      const prices = levels.map((level) => Array.isArray(level) ? priceToScaled(level[0]) : null).filter((p): p is bigint => p !== null);
      return prices.length ? prices.reduce((a, b) => a > b ? a : b) : null;
    };
    const yesBid = topBid(yesBids), noBid = topBid(noBids); if (yesBid === null || noBid === null || yesBid + noBid > 100_000_000n) return null;
    const unit = 100_000_000n;
    return { yesBid: formatPrice(yesBid), yesAsk: formatPrice(unit - noBid), noBid: formatPrice(noBid), noAsk: formatPrice(unit - yesBid), sourceTs: isoOrNull(book?.ts ?? book?.timestamp), ingestedTs: new Date().toISOString() };
  }
  async getResolution(market: MarketRecord): Promise<{ resolution: Resolution; raw: unknown }> {
    const data = await this.request<{ market?: Record<string, unknown> }>(`markets/${encodeURIComponent(market.venueMarketId)}`);
    return { resolution: parseKalshiResolution(data), raw: data };
  }
}
