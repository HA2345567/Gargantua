import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
import { parseConfig } from "../src/config.js";
import { signQuote, verifyQuote } from "../src/services/quote-token.js";
import { migrate } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import { syncAll, syncVenue } from "../src/services/catalog.js";
import { runSettlement } from "../src/services/settlement.js";
import { VenueResolutionSource } from "../src/services/resolution-source.js";
import { formatFixed, parseFixed } from "../src/core/parlay.js";
import type { VenueAdapter } from "../src/venues/adapter.js";
import type { MarketRecord, PricePoint } from "../src/types.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("could not allocate test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("Postgres-wire integration covers registration, catalog, live prices, quote, acceptance, ledger and settlement", async () => {
  const port = await freePort();
  const database = new PGlite();
  const socket = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port, maxConnections: 2 });
  await socket.start();
  const pool = new Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, max: 2, connectionTimeoutMillis: 5_000 });
  const config = parseConfig({ NODE_ENV: "test", DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, CORS_ORIGIN: "http://localhost:3000", QUOTE_SECRET: "integration-test-secret-which-is-over-32", ADMIN_API_TOKEN: "integration-admin-token-which-is-over-32", STARTING_BALANCE: "100", HOUSE_EDGE: "0.05" });
  const markets: MarketRecord[] = ["kalshi:TEST-A", "kalshi:TEST-B"].map((id, i) => ({ id, venue: "kalshi", venueMarketId: id.slice(7), eventId: `event-${i}`, title: `Integration market ${i}`, category: "test", rulesText: "Test resolution rule", closeTime: new Date(Date.now() + 60 * 60_000), status: "open", yesTokenId: null, noTokenId: null, conditionId: null, equivalenceGroup: null, isCombo: false }));
  const prices = new Map(markets.map((market) => [market.id, { yesBid: "0.50", yesAsk: "0.50", noBid: "0.50", noAsk: "0.50", sourceTs: new Date().toISOString(), ingestedTs: new Date().toISOString() } satisfies PricePoint]));
  let resolutionMode: "normal" | "void" | "mixed" | "early-loss" = "normal";
  const adapter: VenueAdapter = { venue: "kalshi", listMarkets: async () => markets, getPrice: async (market) => {
    const point = prices.get(market.id);
    return point ? { ...point, ingestedTs: new Date().toISOString() } : null;
  }, getResolution: async (market) => {
    const resolution = resolutionMode === "void" ? "void" : resolutionMode === "mixed" ? market.venueMarketId === "TEST-A" ? "yes" : "void" : resolutionMode === "early-loss" ? market.venueMarketId === "TEST-A" ? "pending" : "yes" : market.venueMarketId === "TEST-A" ? "yes" : "no";
    return { resolution, raw: { market: { status: resolution === "pending" ? "active" : "finalized", result: resolution, settlement_ts: resolution === "pending" ? null : new Date(Date.now() - 25).toISOString() } } };
  } };
  const app = buildServer(config, pool, [adapter]);
  try {
    await migrate(pool);
    await syncVenue(pool, adapter, 10);
    const failedPolymarket: VenueAdapter = {
      venue: "polymarket",
      listMarkets: async () => { throw new Error("simulated Polymarket catalog outage"); },
      getPrice: async () => null,
      getResolution: async () => ({ resolution: "pending", raw: null }),
    };
    await syncAll(pool, [adapter, failedPolymarket], 10);
    const syncState = await pool.query<{ venue: string; last_error: string | null; markets_seen: number }>("SELECT venue,last_error,markets_seen FROM venue_sync_state ORDER BY venue");
    assert.equal(syncState.rows.find((row) => row.venue === "kalshi")?.markets_seen, 2);
    assert.match(syncState.rows.find((row) => row.venue === "polymarket")?.last_error ?? "", /simulated Polymarket catalog outage/);
    const degradedHealth = await app.inject({ method: "GET", url: "/health" });
    assert.equal(degradedHealth.json().status, "degraded");
    assert.equal(degradedHealth.json().openMarketCount, 2);
    const omittedByCap: MarketRecord = { ...markets[0]!, id: "kalshi:OMITTED-BY-CAP", venueMarketId: "OMITTED-BY-CAP", eventId: "event-omitted", title: "Omitted by catalog cap" };
    const completeSnapshotAdapter: VenueAdapter = { ...adapter, listMarkets: async () => [...markets, omittedByCap] };
    await syncVenue(pool, completeSnapshotAdapter, 10);
    await syncVenue(pool, adapter, 2);
    const omittedStatus = await pool.query<{ status: string }>("SELECT status FROM markets WHERE id=$1", [omittedByCap.id]);
    assert.equal(omittedStatus.rows[0]?.status, "open", "a capped catalog page must not close markets omitted beyond the cap");
    await syncVenue(pool, adapter, Number.MAX_SAFE_INTEGER, true);
    const fullSnapshotStatus = await pool.query<{ status: string }>("SELECT status FROM markets WHERE id=$1", [omittedByCap.id]);
    assert.equal(fullSnapshotStatus.rows[0]?.status, "closed", "a completed full catalog snapshot must close markets no longer returned by the venue");
    await pool.query("DELETE FROM markets WHERE id=$1", [omittedByCap.id]);
    const unauthenticated = await Promise.all([
      app.inject({ method: "GET", url: "/api/me" }),
      app.inject({ method: "GET", url: "/api/ledger" }),
      app.inject({ method: "POST", url: "/api/quote", payload: { stake: "1", legs: [] } }),
      app.inject({ method: "POST", url: "/api/parlays", payload: { token: "x".repeat(40) } }),
      app.inject({ method: "GET", url: "/api/parlays" }),
      app.inject({ method: "GET", url: "/api/parlays/00000000-0000-0000-0000-000000000000" }),
    ]);
    assert.deepEqual(unauthenticated.map((response) => response.statusCode), [401, 401, 401, 401, 401, 401]);
    const registration = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "integration@example.test" } });
    assert.equal(registration.statusCode, 201, registration.body);
    const token = registration.json().token as string;
    const auth = { authorization: `Bearer ${token}` };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const duplicateEmail = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "INTEGRATION@example.test" } });
      assert.equal(duplicateEmail.statusCode, 409, duplicateEmail.body);
    }
    const registrationEmailLimited = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "integration@example.test" } });
    assert.equal(registrationEmailLimited.statusCode, 429);
    const adminHeaders = { authorization: `Bearer ${config.ADMIN_API_TOKEN}` };
    const deniedAdmin = await app.inject({ method: "PUT", url: `/api/admin/markets/${encodeURIComponent(markets[0]!.id)}/equivalence-group`, payload: { equivalenceGroup: "same-real-world-event" } });
    assert.equal(deniedAdmin.statusCode, 401);
    for (const market of markets) {
      const curated = await app.inject({ method: "PUT", url: `/api/admin/markets/${encodeURIComponent(market.id)}/equivalence-group`, headers: adminHeaders, payload: { equivalenceGroup: "same-real-world-event" } });
      assert.equal(curated.statusCode, 200, curated.body);
    }
    await syncVenue(pool, adapter, 10);
    const curatedRows = await pool.query<{ equivalence_group: string | null }>("SELECT equivalence_group FROM markets ORDER BY id");
    assert.deepEqual(curatedRows.rows.map((row) => row.equivalence_group), ["same-real-world-event", "same-real-world-event"], "catalog refresh must preserve operator curation");
    const meBefore = await app.inject({ method: "GET", url: "/api/me", headers: auth });
    assert.equal(meBefore.json().user.balance, "100.000000");
    const browse = await app.inject({ method: "GET", url: "/api/markets?venue=kalshi", headers: auth });
    assert.equal(browse.json().markets.length, 2);
    const live = await app.inject({ method: "GET", url: "/api/markets/kalshi%3ATEST-A/price" });
    assert.equal(live.statusCode, 200, live.body);
    assert.equal(live.json().yes.ask, "0.50");
    prices.delete(markets[1]!.id);
    const unavailable = await app.inject({ method: "GET", url: "/api/markets/kalshi%3ATEST-B/price" });
    assert.equal(unavailable.statusCode, 503);
    prices.set(markets[1]!.id, { yesBid: "0.50", yesAsk: "0.50", noBid: "0.50", noAsk: "0.50", sourceTs: new Date().toISOString(), ingestedTs: new Date().toISOString() });
    const equivalentQuote = await app.inject({ method: "POST", url: "/api/quote", headers: auth, payload: { stake: "10", legs: [{ marketId: markets[0]!.id, side: "YES" }, { marketId: markets[1]!.id, side: "NO" }] } });
    assert.equal(equivalentQuote.statusCode, 422);
    assert.ok(equivalentQuote.json().error.details.issues.some((issue: { code: string }) => issue.code === "equivalent_markets"));
    for (const market of markets) {
      const cleared = await app.inject({ method: "PUT", url: `/api/admin/markets/${encodeURIComponent(market.id)}/equivalence-group`, headers: adminHeaders, payload: { equivalenceGroup: null } });
      assert.equal(cleared.statusCode, 200, cleared.body);
    }
    prices.set(markets[0]!.id, { yesBid: "0.30", yesAsk: "0.60", noBid: "0.30", noAsk: "0.70", sourceTs: new Date().toISOString(), ingestedTs: new Date().toISOString() });
    prices.set(markets[1]!.id, { yesBid: "0.01", yesAsk: "0.05", noBid: "0.95", noAsk: "0.99", sourceTs: new Date().toISOString(), ingestedTs: new Date().toISOString() });
    const allRuleErrors = await app.inject({ method: "POST", url: "/api/quote", headers: auth, payload: { stake: "0.5", legs: [{ marketId: markets[0]!.id, side: "YES" }, { marketId: markets[0]!.id, side: "NO" }, { marketId: markets[1]!.id, side: "NO" }] } });
    assert.equal(allRuleErrors.statusCode, 422, allRuleErrors.body);
    const errorCodes = allRuleErrors.json().error.details.issues.map((issue: { code: string }) => issue.code);
    assert.ok(errorCodes.includes("duplicate_market"));
    assert.ok(errorCodes.includes("same_event"));
    assert.ok(errorCodes.includes("stake_limit"));
    assert.ok(errorCodes.includes("yes_spread"));
    assert.ok(errorCodes.includes("price_range"));
    prices.set(markets[0]!.id, { yesBid: "0.50", yesAsk: "0.50", noBid: "0.50", noAsk: "0.50", sourceTs: new Date().toISOString(), ingestedTs: new Date().toISOString() });
    prices.set(markets[1]!.id, { yesBid: "0.50", yesAsk: "0.50", noBid: "0.50", noAsk: "0.50", sourceTs: new Date().toISOString(), ingestedTs: new Date().toISOString() });
    const quoteResponse = await app.inject({ method: "POST", url: "/api/quote", headers: auth, payload: { stake: "10", legs: [{ marketId: markets[0]!.id, side: "YES" }, { marketId: markets[1]!.id, side: "NO" }] } });
    assert.equal(quoteResponse.statusCode, 200, quoteResponse.body);
    const quote = quoteResponse.json();
    assert.equal(quote.quote.fairMultiplier, "4");
    assert.equal(quote.quote.multiplier, "3.8");
    const expiredPayload = verifyQuote(quote.token, config.QUOTE_SECRET)!;
    const expired = await app.inject({ method: "POST", url: "/api/parlays", headers: auth, payload: { token: signQuote({ ...expiredPayload, expiresAt: new Date(Date.now() - 1).toISOString() }, config.QUOTE_SECRET) } });
    assert.equal(expired.statusCode, 409);
    const accepted = await app.inject({ method: "POST", url: "/api/parlays", headers: auth, payload: { token: quote.token } });
    assert.equal(accepted.statusCode, 201, accepted.body);
    const parlayId = accepted.json().parlay.id as string;
    const duplicate = await app.inject({ method: "POST", url: "/api/parlays", headers: auth, payload: { token: quote.token } });
    assert.equal(duplicate.statusCode, 409);
    const afterStake = await app.inject({ method: "GET", url: "/api/me", headers: auth });
    assert.equal(afterStake.json().user.balance, "90.000000");
    const raceQuoteA = await app.inject({ method: "POST", url: "/api/quote", headers: auth, payload: { stake: "80", legs: [{ marketId: markets[0]!.id, side: "YES" }, { marketId: markets[1]!.id, side: "NO" }] } });
    const raceQuoteB = await app.inject({ method: "POST", url: "/api/quote", headers: auth, payload: { stake: "80", legs: [{ marketId: markets[0]!.id, side: "YES" }, { marketId: markets[1]!.id, side: "NO" }] } });
    assert.equal(raceQuoteA.statusCode, 200, raceQuoteA.body);
    assert.equal(raceQuoteB.statusCode, 200, raceQuoteB.body);
    const concurrent = await Promise.all([raceQuoteA, raceQuoteB].map((response) => app.inject({ method: "POST", url: "/api/parlays", headers: auth, payload: { token: response.json().token } })));
    assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [201, 402]);
    const acceptedConcurrent = concurrent.find((response) => response.statusCode === 201)!;
    const concurrentParlayId = acceptedConcurrent.json().parlay.id as string;
    const afterConcurrentStake = await app.inject({ method: "GET", url: "/api/me", headers: auth });
    assert.equal(afterConcurrentStake.json().user.balance, "10.000000");
    const settled = await runSettlement(pool, new VenueResolutionSource([adapter]), app.metrics);
    assert.equal(settled.settled, 2);
    const evidence = await pool.query("SELECT market_id,side,result,raw_resolution FROM parlay_legs WHERE parlay_id=$1 ORDER BY idx", [parlayId]);
    assert.deepEqual(evidence.rows.map((row) => ({ market_id: row.market_id, side: row.side, result: row.result, resolution: row.raw_resolution?.resolution })), [
      { market_id: "kalshi:TEST-A", side: "YES", result: "win", resolution: "yes" },
      { market_id: "kalshi:TEST-B", side: "NO", result: "win", resolution: "no" },
    ]);
    const position = await app.inject({ method: "GET", url: `/api/parlays/${parlayId}`, headers: auth });
    assert.deepEqual(position.json().parlay.legs.map((leg: { result: string }) => leg.result), ["win", "win"], position.body);
    assert.equal(position.json().parlay.status, "won");
    const portfolio = await app.inject({ method: "GET", url: "/api/parlays", headers: auth });
    const portfolioPosition = portfolio.json().parlays.find((item: { id: string }) => item.id === parlayId);
    assert.equal(portfolioPosition.legCount, 2);
    assert.deepEqual(portfolioPosition.legs.map((leg: { title: string; rulesText: string; result: string }) => ({ title: leg.title, rulesText: leg.rulesText, result: leg.result })), [
      { title: "Integration market 0", rulesText: "Test resolution rule", result: "win" },
      { title: "Integration market 1", rulesText: "Test resolution rule", result: "win" },
    ]);
    assert.equal(position.json().parlay.legs[0].rulesText, "Test resolution rule");
    const concurrentPosition = await app.inject({ method: "GET", url: `/api/parlays/${concurrentParlayId}`, headers: auth });
    assert.equal(concurrentPosition.json().parlay.status, "won");
    const ledger = await app.inject({ method: "GET", url: "/api/ledger", headers: auth });
    assert.deepEqual(ledger.json().entries.map((entry: { kind: string }) => entry.kind).sort(), ["grant", "payout", "payout", "stake", "stake"]);
    const finalAccount = await app.inject({ method: "GET", url: "/api/me", headers: auth });
    let winningBalance = formatFixed(10_000_000n + parseFixed(quote.quote.payout, 6)! + parseFixed(raceQuoteA.json().quote.payout, 6)!, 6);
    assert.equal(parseFixed(finalAccount.json().user.balance, 6), parseFixed(winningBalance, 6));
    await runSettlement(pool, new VenueResolutionSource([adapter]), app.metrics);
    assert.equal(parseFixed((await app.inject({ method: "GET", url: "/api/me", headers: auth })).json().user.balance, 6), parseFixed(winningBalance, 6), "repeated settlement must not pay twice");

    const retryQuote = await app.inject({ method: "POST", url: "/api/quote", headers: auth, payload: { stake: "1", legs: [{ marketId: markets[0]!.id, side: "YES" }, { marketId: markets[1]!.id, side: "NO" }] } });
    const retryAccepted = await app.inject({ method: "POST", url: "/api/parlays", headers: auth, payload: { token: retryQuote.json().token } });
    const retryParlayId = retryAccepted.json().parlay.id as string;
    let observedStaleRead!: () => void;
    let finishFirstRun!: () => void;
    const staleRead = new Promise<void>((resolve) => { observedStaleRead = resolve; });
    const firstRunFinished = new Promise<void>((resolve) => { finishFirstRun = resolve; });
    const firstResolutionSource = { getResolution: async (market: MarketRecord) => {
      if (market.id === markets[0]!.id) { await staleRead; return { resolution: "yes" as const, raw: { source: "first-run" } }; }
      return { resolution: "pending" as const, raw: null };
    } };
    const staleResolutionSource = { getResolution: async (market: MarketRecord) => {
      if (market.id === markets[0]!.id) { observedStaleRead(); await firstRunFinished; return { resolution: "no" as const, raw: { source: "stale-conflicting-read" } }; }
      return { resolution: "pending" as const, raw: null };
    } };
    const firstSettlement = runSettlement(pool, firstResolutionSource, app.metrics).finally(finishFirstRun);
    const staleSettlement = runSettlement(pool, staleResolutionSource, app.metrics);
    await Promise.all([firstSettlement, staleSettlement]);
    const retriedPosition = await app.inject({ method: "GET", url: `/api/parlays/${retryParlayId}`, headers: auth });
    assert.equal(retriedPosition.json().parlay.status, "open", "a stale conflicting resolution must not overwrite the already-recorded leg result");
    assert.equal(retriedPosition.json().parlay.legs[0].result, "win");
    resolutionMode = "early-loss";
    await runSettlement(pool, new VenueResolutionSource([adapter]), app.metrics);
    assert.equal((await app.inject({ method: "GET", url: `/api/parlays/${retryParlayId}`, headers: auth })).json().parlay.status, "lost");
    winningBalance = formatFixed(parseFixed(winningBalance, 6)! - 1_000_000n, 6);

    const voidQuoteResponse = await app.inject({ method: "POST", url: "/api/quote", headers: auth, payload: { stake: "10", legs: [{ marketId: markets[0]!.id, side: "YES" }, { marketId: markets[1]!.id, side: "NO" }] } });
    assert.equal(voidQuoteResponse.statusCode, 200, voidQuoteResponse.body);
    const voidAccepted = await app.inject({ method: "POST", url: "/api/parlays", headers: auth, payload: { token: voidQuoteResponse.json().token } });
    assert.equal(voidAccepted.statusCode, 201, voidAccepted.body);
    const voidParlayId = voidAccepted.json().parlay.id as string;
    resolutionMode = "void";
    assert.equal((await runSettlement(pool, new VenueResolutionSource([adapter]), app.metrics)).settled, 1);
    const voidPosition = await app.inject({ method: "GET", url: `/api/parlays/${voidParlayId}`, headers: auth });
    assert.equal(voidPosition.json().parlay.status, "void");
    const afterRefund = await app.inject({ method: "GET", url: "/api/me", headers: auth });
    assert.equal(parseFixed(afterRefund.json().user.balance, 6), parseFixed(winningBalance, 6));
    const afterRefundLedger = await app.inject({ method: "GET", url: "/api/ledger", headers: auth });
    assert.equal(afterRefundLedger.json().entries.filter((entry: { kind: string }) => entry.kind === "refund").length, 1);

    const mixedQuoteResponse = await app.inject({ method: "POST", url: "/api/quote", headers: auth, payload: { stake: "10", legs: [{ marketId: markets[0]!.id, side: "YES" }, { marketId: markets[1]!.id, side: "NO" }] } });
    assert.equal(mixedQuoteResponse.statusCode, 200, mixedQuoteResponse.body);
    const mixedAccepted = await app.inject({ method: "POST", url: "/api/parlays", headers: auth, payload: { token: mixedQuoteResponse.json().token } });
    assert.equal(mixedAccepted.statusCode, 201, mixedAccepted.body);
    const mixedParlayId = mixedAccepted.json().parlay.id as string;
    resolutionMode = "mixed";
    await runSettlement(pool, new VenueResolutionSource([adapter]), app.metrics);
    const mixedPosition = await app.inject({ method: "GET", url: `/api/parlays/${mixedParlayId}`, headers: auth });
    assert.equal(mixedPosition.json().parlay.status, "won");
    assert.deepEqual(mixedPosition.json().parlay.legs.map((leg: { result: string }) => leg.result), ["win", "void"]);
    const mixedPayout = 10_000_000n * parseFixed(mixedQuoteResponse.json().quote.legs[0].factor, 18)! / 1_000_000_000_000_000_000n;
    const afterMixedBalance = formatFixed(parseFixed(winningBalance, 6)! - 10_000_000n + mixedPayout, 6);
    assert.equal(parseFixed((await app.inject({ method: "GET", url: "/api/me", headers: auth })).json().user.balance, 6), parseFixed(afterMixedBalance, 6));

    const lossQuoteResponse = await app.inject({ method: "POST", url: "/api/quote", headers: auth, payload: { stake: "10", legs: [{ marketId: markets[0]!.id, side: "YES" }, { marketId: markets[1]!.id, side: "NO" }] } });
    const lossAccepted = await app.inject({ method: "POST", url: "/api/parlays", headers: auth, payload: { token: lossQuoteResponse.json().token } });
    assert.equal(lossAccepted.statusCode, 201, lossAccepted.body);
    const lossParlayId = lossAccepted.json().parlay.id as string;
    resolutionMode = "early-loss";
    await runSettlement(pool, new VenueResolutionSource([adapter]), app.metrics);
    const lostPosition = await app.inject({ method: "GET", url: `/api/parlays/${lossParlayId}`, headers: auth });
    assert.equal(lostPosition.json().parlay.status, "lost");
    assert.deepEqual(lostPosition.json().parlay.legs.map((leg: { result: string }) => leg.result), ["pending", "lose"]);
    const afterLossBalance = await app.inject({ method: "GET", url: "/api/me", headers: auth });
    assert.equal(parseFixed(afterLossBalance.json().user.balance, 6), parseFixed(formatFixed(parseFixed(afterMixedBalance, 6)! - 10_000_000n, 6), 6));
    await runSettlement(pool, new VenueResolutionSource([adapter]), app.metrics);
    assert.equal(parseFixed((await app.inject({ method: "GET", url: "/api/me", headers: auth })).json().user.balance, 6), parseFixed(afterLossBalance.json().user.balance, 6), "lost parlay retries must not change balance");

    const metricsDenied = await app.inject({ method: "GET", url: "/api/admin/metrics" });
    assert.equal(metricsDenied.statusCode, 401);
    const metricsResponse = await app.inject({ method: "GET", url: "/api/admin/metrics", headers: adminHeaders });
    assert.equal(metricsResponse.statusCode, 200, metricsResponse.body);
    const metrics = metricsResponse.json().metrics;
    assert.ok(metrics.quotes.issued >= 5);
    assert.ok(metrics.quotes.latencyP95Ms >= 0);
    assert.ok(metrics.stalePriceRefusals >= 1);
    assert.ok(metrics.settlementLag.sampleCount >= 1);
    assert.ok(metrics.parlaysByStatus.won >= 1);
    assert.ok(metrics.parlaysByStatus.lost >= 1);
    const ledgerBalance = await pool.query<{ balance: string }>("SELECT COALESCE(sum(amount),0)::text AS balance FROM ledger_entries WHERE user_id=(SELECT id FROM users WHERE email=$1)", ["integration@example.test"]);
    const accountBalance = await pool.query<{ balance: string }>("SELECT balance::text AS balance FROM users WHERE email=$1", ["integration@example.test"]);
    assert.equal(parseFixed(ledgerBalance.rows[0]!.balance, 6), parseFixed(accountBalance.rows[0]!.balance, 6), "the account balance must equal the exact sum of all ledger entries");

    const poorRegistration = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "poor-user@example.test" } });
    assert.equal(poorRegistration.statusCode, 201, poorRegistration.body);
    const poorAuth = { authorization: `Bearer ${poorRegistration.json().token as string}` };
    const exhaustQuote = await app.inject({ method: "POST", url: "/api/quote", headers: poorAuth, payload: { stake: "100", legs: [{ marketId: markets[0]!.id, side: "YES" }, { marketId: markets[1]!.id, side: "NO" }] } });
    assert.equal(exhaustQuote.statusCode, 200, exhaustQuote.body);
    const wrongAccountAcceptance = await app.inject({ method: "POST", url: "/api/parlays", headers: auth, payload: { token: exhaustQuote.json().token } });
    assert.equal(wrongAccountAcceptance.statusCode, 409, wrongAccountAcceptance.body);
    assert.equal((await app.inject({ method: "POST", url: "/api/parlays", headers: poorAuth, payload: { token: exhaustQuote.json().token } })).statusCode, 201);
    const excessQuote = await app.inject({ method: "POST", url: "/api/quote", headers: poorAuth, payload: { stake: "1", legs: [{ marketId: markets[0]!.id, side: "YES" }, { marketId: markets[1]!.id, side: "NO" }] } });
    assert.equal(excessQuote.statusCode, 200, excessQuote.body);
    const insufficient = await app.inject({ method: "POST", url: "/api/parlays", headers: poorAuth, payload: { token: excessQuote.json().token } });
    assert.equal(insufficient.statusCode, 402, insufficient.body);
    assert.equal(insufficient.json().error.code, "insufficient_balance");
    assert.equal((await app.inject({ method: "GET", url: "/api/me", headers: poorAuth })).json().user.balance, "0.000000");
  } finally {
    await app.close();
    await pool.end();
    await socket.stop();
    await database.close();
  }
});
