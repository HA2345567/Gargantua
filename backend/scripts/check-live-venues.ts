import { parseConfig } from "../src/config.js";
import { KalshiAdapter } from "../src/venues/kalshi.js";
import { PolymarketAdapter } from "../src/venues/polymarket.js";

const config = parseConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost/gargantua-readonly-check",
  CORS_ORIGIN: "http://localhost:3000",
  QUOTE_SECRET: "read-only-venue-check-secret-at-least-32",
  KALSHI_BASE_URL: process.env.KALSHI_BASE_URL,
  KALSHI_ACCESS_KEY: process.env.KALSHI_ACCESS_KEY,
  KALSHI_PRIVATE_KEY_PEM: process.env.KALSHI_PRIVATE_KEY_PEM,
  POLYMARKET_GAMMA_URL: process.env.POLYMARKET_GAMMA_URL,
  POLYMARKET_CLOB_URL: process.env.POLYMARKET_CLOB_URL,
});
const adapters = [new KalshiAdapter(config), new PolymarketAdapter(config.POLYMARKET_GAMMA_URL, config.POLYMARKET_CLOB_URL)];
for (const adapter of adapters) {
  try {
    const markets = await adapter.listMarkets(1);
    if (!markets.length) { console.log(`${adapter.venue}: no eligible open binary market returned`); continue; }
    const price = await adapter.getPrice(markets[0]!);
    console.log(`${adapter.venue}: catalog=ok (${markets.length} market), twoSidedBook=${price ? "ok" : "unavailable"}`);
  } catch (error) {
    console.log(`${adapter.venue}: request failed (${error instanceof Error ? error.message : "unknown error"})`);
  }
}
