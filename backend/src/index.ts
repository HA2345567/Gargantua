import { parseConfig } from "./config.js";
import { createPool, migrate } from "./db/pool.js";
import { buildServer } from "./server.js";
import { KalshiAdapter } from "./venues/kalshi.js";
import { PolymarketAdapter } from "./venues/polymarket.js";
import { syncAll } from "./services/catalog.js";
import { runSettlement } from "./services/settlement.js";
import { VenueResolutionSource } from "./services/resolution-source.js";
import { runSolanaSettlement } from "./services/solana-settlement.js";

const config = parseConfig();
const pool = createPool(config);
const adapters = [new KalshiAdapter(config), new PolymarketAdapter(config.POLYMARKET_GAMMA_URL, config.POLYMARKET_CLOB_URL)];
const resolutionSource = new VenueResolutionSource(adapters);
const app = buildServer(config, pool, adapters);
let catalogTimer: NodeJS.Timeout | undefined;
let fullCatalogTimer: NodeJS.Timeout | undefined;
let settlementTimer: NodeJS.Timeout | undefined;
let settlementRunning = false;
let catalogRunning = false;
let catalogTask: Promise<void> | null = null;
let fullCatalogTask: Promise<void> | null = null;
let settlementTask: Promise<void> | null = null;

const settle = async () => {
  if (settlementRunning) return;
  settlementRunning = true;
  try {
    await runSettlement(pool, resolutionSource, app.metrics);
    await runSolanaSettlement(pool, resolutionSource, config);
  }
  catch (error) {
    app.log.error({ err: error }, "settlement run failed");
    await pool.query("INSERT INTO system_state(key,value) VALUES ('settlement',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()", [JSON.stringify({ lastRunAt: new Date().toISOString(), lastError: error instanceof Error ? error.message.slice(0, 300) : "settlement failed" })]).catch(() => undefined);
  } finally { settlementRunning = false; }
};

try {
  await migrate(pool);
  await syncAll(pool, adapters, config.CATALOG_MAX_MARKETS);
  await app.listen({ host: config.HOST, port: config.PORT });
  catalogTimer = setInterval(() => {
    if (catalogRunning) return;
    catalogRunning = true;
    catalogTask = syncAll(pool, adapters, config.CATALOG_MAX_MARKETS).finally(() => { catalogRunning = false; });
    void catalogTask;
  }, config.CATALOG_INTERVAL_MS);
  fullCatalogTimer = setInterval(() => {
    fullCatalogTask = (async () => {
      while (catalogRunning && catalogTask) await catalogTask;
      catalogRunning = true;
      try {
        // Venue adapters paginate until exhaustion when given this upper bound.
        await syncAll(pool, adapters, Number.MAX_SAFE_INTEGER, true);
      } finally { catalogRunning = false; }
    })();
    void fullCatalogTask;
  }, config.CATALOG_FULL_SYNC_INTERVAL_MS);
  settlementTask = settle();
  await settlementTask;
  settlementTimer = setInterval(() => { settlementTask = settle(); void settlementTask; }, config.SETTLEMENT_INTERVAL_MS);
  catalogTimer.unref();
  fullCatalogTimer.unref();
  settlementTimer.unref();
} catch (error) {
  app.log.error({ err: error }, "backend startup failed");
  if (catalogTimer) clearInterval(catalogTimer);
  if (fullCatalogTimer) clearInterval(fullCatalogTimer);
  if (settlementTimer) clearInterval(settlementTimer);
  await pool.end();
  process.exitCode = 1;
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  if (catalogTimer) clearInterval(catalogTimer);
  if (settlementTimer) clearInterval(settlementTimer);
  await app.close();
  await Promise.allSettled([catalogTask, fullCatalogTask, settlementTask].filter((task): task is Promise<void> => task !== null));
  await pool.end();
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
