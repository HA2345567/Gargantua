import test from "node:test";
import assert from "node:assert/strict";
import { createQuote, formatFixed, floorPayout, integerRoot, MONEY_SCALE, parseFixed, productFactors } from "../src/core/parlay.js";
import { signQuote, verifyQuote } from "../src/services/quote-token.js";
import { bidAsk, parseStringArray } from "../src/venues/http.js";
import { parsePolymarketResolution } from "../src/venues/polymarket.js";
import { parseKalshiResolution } from "../src/venues/kalshi.js";

test("fixed point money conversion and payout round down exactly", () => {
  assert.equal(parseFixed("12.345678", 6), 12_345_678n);
  assert.equal(parseFixed("1.0000001", 6), null);
  assert.equal(formatFixed(-1_200_000n, 6), "-1.2");
  assert.equal(floorPayout(MONEY_SCALE, 1_234_567_890_123n), 1_234_567n);
  assert.equal(integerRoot(81n, 2), 9n);
});

test("quote is deterministic, expiring and account bound by its signature", () => {
  const quote = createQuote({ userId: "user-1", nonce: "nonce-1", stake: "10", legs: [
    { marketId: "kalshi:a", side: "YES", price: "0.50000000" },
    { marketId: "polymarket:b", side: "NO", price: "0.25000000" },
  ], houseEdge: "0.05", ttlMs: 15000, nowMs: 1_800_000_000_000 });
  assert.ok(quote);
  assert.equal(quote.quote.legs.length, 2);
  assert.ok(Number(quote.quote.multiplier) < Number(quote.quote.fairMultiplier));
  assert.equal(formatFixed(productFactors(quote.quote.legs.map((leg) => leg.factor)), 12), quote.quote.multiplier);
  const token = signQuote(quote.payload, "x".repeat(32));
  assert.deepEqual(verifyQuote(token, "x".repeat(32)), quote.payload);
  assert.equal(verifyQuote(token, "y".repeat(32)), null);
  const [encoded, signature] = token.split(".");
  const tampered = `${encoded}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
  assert.equal(verifyQuote(tampered, "x".repeat(32)), null);
});

test("venue books are sorted and incomplete sides fail closed", () => {
  assert.deepEqual(bidAsk([["0.24", "10"], ["0.31", "2"]], [{ price: "0.40", size: "5" }, { price: "0.35", size: "8" }]), { bid: "0.31", ask: "0.35" });
  assert.equal(bidAsk([], [["0.5", "1"]]), null);
  assert.deepEqual(parseStringArray('["Yes","No"]'), ["Yes", "No"]);
});

test("Polymarket only settles closed binary markets at final payout values", () => {
  const base = { closed: true, umaResolutionStatus: "resolved", outcomes: '["Yes","No"]' };
  assert.equal(parsePolymarketResolution({ ...base, outcomePrices: '["0","1"]' }), "no");
  assert.equal(parsePolymarketResolution({ ...base, outcomePrices: '["1","0"]' }), "yes");
  assert.equal(parsePolymarketResolution({ ...base, outcomePrices: '["0.5","0.5"]' }), "void");
  assert.equal(parsePolymarketResolution({ ...base, outcomePrices: '["0.000001011082052522541417308141468657552","0.9999989889179474774585826918585313"]' }), "pending");
  assert.equal(parsePolymarketResolution({ ...base, outcomePrices: '["0","0"]' }), "pending");
  assert.equal(parsePolymarketResolution({ ...base, closed: false, outcomePrices: '["1","0"]' }), "pending");
  assert.equal(parsePolymarketResolution({ ...base, umaResolutionStatus: "proposed", outcomePrices: '["1","0"]' }), "pending");
});

test("Kalshi only settles confirmed finalized binary results", () => {
  assert.equal(parseKalshiResolution({ market: { status: "finalized", result: "no" } }), "no");
  assert.equal(parseKalshiResolution({ market: { status: "settled", result: "yes" } }), "yes");
  assert.equal(parseKalshiResolution({ market: { status: "finalized", result: "void" } }), "pending");
  assert.equal(parseKalshiResolution({ market: { status: "disputed", result: "yes" } }), "pending");
  assert.equal(parseKalshiResolution(null), "pending");
});
