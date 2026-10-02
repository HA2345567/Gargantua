import type { MarketRecord, PricePoint, Resolution } from "../types.js";
import { parseFixed } from "../core/parlay.js";
import { asRecord, asString, bidAsk, getJson, isoOrNull, parseStringArray } from "./http.js";
import type { VenueAdapter } from "./adapter.js";

type GammaMarket = Record<string, unknown>;
export function parsePolymarketResolution(row: GammaMarket): Resolution {
  if (row.closed !== true || !["resolved", "settled"].includes(String(row.umaResolutionStatus).toLowerCase())) return "pending";
  const outcomes = parseStringArray(row.outcomes), prices = parseStringArray(row.outcomePrices);
  const yesIndex = outcomes.findIndex((x) => x.toLowerCase() === "yes"), noIndex = outcomes.findIndex((x) => x.toLowerCase() === "no");
  if (yesIndex < 0 || noIndex < 0 || outcomes.length !== 2 || prices.length !== 2) return "pending";
  const pYes = parseFixed(prices[yesIndex]!, 8), pNo = parseFixed(prices[noIndex]!, 8);
  if (pYes === 50_000_000n && pNo === 50_000_000n) return "void";
  if (pYes === 100_000_000n && pNo === 0n) return "yes";
  if (pYes === 0n && pNo === 100_000_000n) return "no";
  return "pending";
}

export class PolymarketAdapter implements VenueAdapter {
  readonly venue = "polymarket" as const;
  private readonly gamma: URL;
  private readonly clob: URL;
  constructor(gammaUrl: string, clobUrl: string) {
    this.gamma = new URL(gammaUrl.endsWith("/") ? gammaUrl : `${gammaUrl}/`);
    this.clob = new URL(clobUrl.endsWith("/") ? clobUrl : `${clobUrl}/`);
  }
  async listMarkets(limit: number): Promise<MarketRecord[]> {
    const result: MarketRecord[] = []; const pageSize = Math.min(100, limit);
    for (let offset = 0; result.length < limit; offset += pageSize) {
      const url = new URL("markets", this.gamma); url.searchParams.set("active", "true"); url.searchParams.set("closed", "false"); url.searchParams.set("limit", String(pageSize)); url.searchParams.set("offset", String(offset));
      const rows = await getJson<GammaMarket[]>(url, 5); if (!rows) throw new Error("Polymarket catalog request failed"); if (!rows.length) break;
      for (const row of rows) {
        const outcomes = parseStringArray(row.outcomes), tokens = parseStringArray(row.clobTokenIds);
        const yesIndex = outcomes.findIndex((x) => x.toLowerCase() === "yes"), noIndex = outcomes.findIndex((x) => x.toLowerCase() === "no");
        const id = asString(row.id), condition = asString(row.conditionId), question = asString(row.question), close = isoOrNull(row.endDate);
        if (!id || !condition || !question || !close || Date.parse(close) <= Date.now() || yesIndex < 0 || noIndex < 0 || outcomes.length !== 2 || !tokens[yesIndex] || !tokens[noIndex] || row.active !== true || row.closed !== false || row.enableOrderBook === false) continue;
        const events = Array.isArray(row.events) ? row.events : [];
        const firstEvent = asRecord(events[0]);
        result.push({ id: `polymarket:${id}`, venue: this.venue, venueMarketId: id, eventId: asString(firstEvent?.id) ?? condition, title: question, category: asString(row.category) ?? "", rulesText: [asString(row.description), asString(row.resolutionSource)].filter(Boolean).join("\n\n"), closeTime: new Date(close), status: "open", yesTokenId: tokens[yesIndex]!, noTokenId: tokens[noIndex]!, conditionId: condition, equivalenceGroup: null, isCombo: false });
        if (result.length >= limit) break;
      }
      if (rows.length < pageSize) break;
    }
    return result;
  }
  async getPrice(market: MarketRecord): Promise<PricePoint | null> {
    if (!market.yesTokenId || !market.noTokenId) return null;
    const fetchBook = async (token: string) => { const url = new URL("book", this.clob); url.searchParams.set("token_id", token); return getJson<Record<string, unknown>>(url, 8); };
    const [yesBook, noBook] = await Promise.all([fetchBook(market.yesTokenId), fetchBook(market.noTokenId)]);
    if (!yesBook || !noBook || yesBook.asset_id !== market.yesTokenId || noBook.asset_id !== market.noTokenId) return null;
    const yes = bidAsk(yesBook.bids, yesBook.asks), no = bidAsk(noBook.bids, noBook.asks); if (!yes || !no) return null;
    const yesTs = isoOrNull(yesBook.timestamp), noTs = isoOrNull(noBook.timestamp);
    const sourceTs = yesTs && noTs ? (Date.parse(yesTs) < Date.parse(noTs) ? yesTs : noTs) : null;
    return { yesBid: yes.bid, yesAsk: yes.ask, noBid: no.bid, noAsk: no.ask, sourceTs, ingestedTs: new Date().toISOString() };
  }
  async getResolution(market: MarketRecord): Promise<{ resolution: Resolution; raw: unknown }> {
    const url = new URL(`markets/${encodeURIComponent(market.venueMarketId)}`, this.gamma);
    const row = await getJson<GammaMarket>(url, 5);
    return { resolution: row ? parsePolymarketResolution(row) : "pending", raw: row };
  }
}
