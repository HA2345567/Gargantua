import { parseConfig } from "../src/config.js";
import type { MarketRecord } from "../src/types.js";
import { getJson, asString } from "../src/venues/http.js";
import { KalshiAdapter } from "../src/venues/kalshi.js";
import { PolymarketAdapter, parsePolymarketResolution } from "../src/venues/polymarket.js";

const config = parseConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost/gargantua-readonly-check",
  CORS_ORIGIN: "http://localhost:3000",
  QUOTE_SECRET: "read-only-resolution-check-secret-at-least-32",
  KALSHI_BASE_URL: process.env.KALSHI_BASE_URL,
  KALSHI_ACCESS_KEY: process.env.KALSHI_ACCESS_KEY,
  KALSHI_PRIVATE_KEY_PEM: process.env.KALSHI_PRIVATE_KEY_PEM,
  POLYMARKET_GAMMA_URL: process.env.POLYMARKET_GAMMA_URL,
  POLYMARKET_CLOB_URL: process.env.POLYMARKET_CLOB_URL,
});

const kalshi = new KalshiAdapter(config);
const kalshiUrl = new URL("markets", config.KALSHI_BASE_URL.endsWith("/") ? config.KALSHI_BASE_URL : `${config.KALSHI_BASE_URL}/`);
kalshiUrl.searchParams.set("status", "settled");
kalshiUrl.searchParams.set("mve_filter", "exclude");
kalshiUrl.searchParams.set("limit", "20");
const settled = await getJson<{ markets?: Record<string, unknown>[] }>(kalshiUrl, 5);
const finalMarket = settled?.markets?.find((row) => asString(row.ticker) && ["yes", "no"].includes(String(row.result).toLowerCase()) && ["finalized", "settled"].includes(String(row.status).toLowerCase()));
if (!finalMarket) throw new Error("Kalshi returned no finalized binary market to verify");
const ticker = asString(finalMarket.ticker)!;
const kalshiRecord = { id: `kalshi:${ticker}`, venue: "kalshi", venueMarketId: ticker, eventId: "resolution-check", title: "resolution check", category: "", rulesText: "", closeTime: new Date(), status: "closed", yesTokenId: null, noTokenId: null, conditionId: null, equivalenceGroup: null, isCombo: false } as MarketRecord;
const kalshiResolution = await kalshi.getResolution(kalshiRecord);
if (kalshiResolution.resolution !== String(finalMarket.result).toLowerCase()) throw new Error(`Kalshi detail/list mismatch for ${ticker}`);
console.log(`kalshi: settled listing and detail agree (${ticker} ${kalshiResolution.resolution})`);

const polymarket = new PolymarketAdapter(config.POLYMARKET_GAMMA_URL, config.POLYMARKET_CLOB_URL);
const gammaUrl = new URL("markets", config.POLYMARKET_GAMMA_URL.endsWith("/") ? config.POLYMARKET_GAMMA_URL : `${config.POLYMARKET_GAMMA_URL}/`);
gammaUrl.searchParams.set("closed", "true");
gammaUrl.searchParams.set("limit", "100");
gammaUrl.searchParams.set("order", "endDate");
gammaUrl.searchParams.set("ascending", "false");
const closed = await getJson<Record<string, unknown>[]>(gammaUrl, 5);
const payoutRecord = closed?.find((row) => parsePolymarketResolution(row) !== "pending" && asString(row.id));
if (!payoutRecord) throw new Error("Polymarket returned no closed binary market with definitive payout values");
const marketId = asString(payoutRecord.id)!;
const polymarketRecord = { id: `polymarket:${marketId}`, venue: "polymarket", venueMarketId: marketId, eventId: "resolution-check", title: "resolution check", category: "", rulesText: "", closeTime: new Date(), status: "closed", yesTokenId: null, noTokenId: null, conditionId: null, equivalenceGroup: null, isCombo: false } as MarketRecord;
const polymarketResolution = await polymarket.getResolution(polymarketRecord);
if (polymarketResolution.resolution === "pending") throw new Error(`Polymarket final payout changed while verifying market ${marketId}`);
console.log(`polymarket: closed market has final binary payout (${marketId} ${polymarketResolution.resolution})`);
