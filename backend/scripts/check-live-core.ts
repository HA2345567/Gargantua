import { createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
import { parseConfig } from "../src/config.js";
import { migrate } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import { complementPrice, parseFixed } from "../src/core/parlay.js";
import { syncVenue } from "../src/services/catalog.js";
import { KalshiAdapter } from "../src/venues/kalshi.js";
import { PolymarketAdapter } from "../src/venues/polymarket.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("could not allocate local test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const port = await freePort(), database = new PGlite();
const socket = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port, maxConnections: 2 });
await socket.start();
const pool = new Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 });
const config = parseConfig({
  NODE_ENV: "test", DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
  CORS_ORIGIN: "http://localhost:3000", QUOTE_SECRET: "live-end-to-end-check-secret-over-32-chars", ADMIN_API_TOKEN: "live-end-to-end-admin-token-over-32-chars",
  ...(process.env.KALSHI_ACCESS_KEY ? { KALSHI_ACCESS_KEY: process.env.KALSHI_ACCESS_KEY } : {}),
  ...(process.env.KALSHI_PRIVATE_KEY_PEM ? { KALSHI_PRIVATE_KEY_PEM: process.env.KALSHI_PRIVATE_KEY_PEM } : {}),
});
const adapters = [new KalshiAdapter(config), new PolymarketAdapter(config.POLYMARKET_GAMMA_URL, config.POLYMARKET_CLOB_URL)];
const app = buildServer(config, pool, adapters);
try {
  await migrate(pool);
  const syncCounts = await Promise.all(adapters.map((adapter) => syncVenue(pool, adapter, config.CATALOG_MAX_MARKETS)));
  if (syncCounts.some((count) => count === 0)) throw new Error(`live catalog incomplete: ${syncCounts.join(",")}`);
  const registration = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `live-check-${Date.now()}@example.test` } });
  if (registration.statusCode !== 201) throw new Error(`registration failed: ${registration.statusCode} ${registration.body}`);
  const auth = { authorization: `Bearer ${registration.json().token as string}` };
  const catalogResponses = await Promise.all(["kalshi", "polymarket"].map((venue) => app.inject({ method: "GET", url: `/api/markets?venue=${venue}&limit=100` })));
  const rows = catalogResponses.flatMap((response) => response.json().markets as { id: string; venue: "kalshi" | "polymarket"; eventId: string; closeTime: string; equivalenceGroup: string | null }[]);
  const horizon = Date.now() + config.MAX_HORIZON_DAYS * 86_400_000;
  const usable = rows.filter((market) => Date.parse(market.closeTime) > Date.now() && Date.parse(market.closeTime) <= horizon);
  const live: { market: typeof usable[number]; side: "YES" | "NO" }[] = [];
  const diagnostics: Record<string, { candidates: number; books: number; quoteEligible: number }> = {};
  for (const venue of ["kalshi", "polymarket"] as const) {
    const candidates = usable.filter((item) => item.venue === venue);
    diagnostics[venue] = { candidates: candidates.length, books: 0, quoteEligible: 0 };
    for (const market of candidates.slice(0, 40)) {
      const result = await app.inject({ method: "GET", url: `/api/markets/${encodeURIComponent(market.id)}/price` });
      if (result.statusCode !== 200) continue;
      diagnostics[venue]!.books += 1;
      const book = result.json();
      const yesAsk = parseFixed(book.yes.ask, 8)!, yesBid = parseFixed(book.yes.bid, 8)!;
      const noAsk = parseFixed(complementPrice(book.yes.bid)!, 8)!;
      const spreadOk = yesAsk - yesBid <= 15_000_000n;
      if (yesAsk >= 2_000_000n && yesAsk <= 98_000_000n && spreadOk) live.push({ market, side: "YES" });
      else if (noAsk >= 2_000_000n && noAsk <= 98_000_000n && spreadOk) live.push({ market, side: "NO" });
      if (yesAsk >= 2_000_000n && yesAsk <= 98_000_000n && spreadOk || noAsk >= 2_000_000n && noAsk <= 98_000_000n && spreadOk) diagnostics[venue]!.quoteEligible += 1;
      if (live.filter((item) => item.market.venue === venue).length >= 10) break;
    }
  }
  let acceptedVenuePair = "";
  let quoteP95Ms = 0;
  let quoteAttempts = 0;
  for (const kalshi of live.filter((item) => item.market.venue === "kalshi")) {
    for (const polymarket of live.filter((item) => item.market.venue === "polymarket")) {
      if (kalshi.market.eventId === polymarket.market.eventId || (kalshi.market.equivalenceGroup && kalshi.market.equivalenceGroup === polymarket.market.equivalenceGroup)) continue;
      if (quoteAttempts >= 12) break;
      quoteAttempts += 1;
      const payload = { stake: "1", legs: [{ marketId: kalshi.market.id, side: kalshi.side }, { marketId: polymarket.market.id, side: polymarket.side }] };
      const durations: number[] = [];
      const started = performance.now();
      const response = await app.inject({ method: "POST", url: "/api/quote", headers: auth, payload });
      if (response.statusCode !== 200) continue;
      let token = response.json().token as string;
      durations.push(performance.now() - started);
      for (let sample = 1; sample < 20; sample += 1) {
        const sampleStarted = performance.now();
        const next = await app.inject({ method: "POST", url: "/api/quote", headers: auth, payload });
        if (next.statusCode !== 200) throw new Error(`live quote benchmark sample failed: ${next.statusCode} ${next.body}`);
        durations.push(performance.now() - sampleStarted);
        token = next.json().token as string;
      }
      durations.sort((a, b) => a - b);
      quoteP95Ms = Math.round(durations[Math.ceil(durations.length * 0.95) - 1]!);
      const acceptance = await app.inject({ method: "POST", url: "/api/parlays", headers: auth, payload: { token } });
      if (acceptance.statusCode !== 201) throw new Error(`live quote acceptance failed: ${acceptance.statusCode} ${acceptance.body}`);
      acceptedVenuePair = `${kalshi.market.venue}+${polymarket.market.venue}`;
      break;
    }
    if (acceptedVenuePair) break;
  }
  if (!acceptedVenuePair) throw new Error(`no valid cross-venue quote after ${quoteAttempts} attempts; ${JSON.stringify(diagnostics)}`);
  const metricsResponse = await app.inject({ method: "GET", url: "/api/admin/metrics", headers: { authorization: `Bearer ${config.ADMIN_API_TOKEN}` } });
  if (metricsResponse.statusCode !== 200) throw new Error(`live metrics query failed: ${metricsResponse.statusCode} ${metricsResponse.body}`);
  const metrics = metricsResponse.json().metrics;
  if (metrics.quotes.issued < 20 || metrics.quotes.latencyP95Ms >= 3_000 || metrics.venues.kalshi.requestCount < 1 || metrics.venues.polymarket.requestCount < 1) throw new Error(`live metrics incomplete or outside target: ${JSON.stringify(metrics)}`);
  console.log(`live end-to-end: Kalshi+Polymarket catalog=ok; fresh books=ok; signed quote=ok; virtual acceptance=ok; admin metrics=ok; 20-sample quote p95=${quoteP95Ms}ms`);
} finally {
  await app.close(); await pool.end(); await socket.stop(); await database.close();
}
