import type { Quote, QuoteLeg, Side } from "../types.js";

export const MONEY_SCALE = 1_000_000n;
export const PRICE_SCALE = 100_000_000n;
export const FACTOR_SCALE = 1_000_000_000_000n;
export const LEG_FACTOR_SCALE = 1_000_000_000_000_000_000n;
const MULTIPLIER_PRECISION_RATIO = LEG_FACTOR_SCALE / FACTOR_SCALE;

export function parseFixed(value: string, scaleDigits: number): bigint | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2]?.length ?? 0) > scaleDigits) return null;
  const scale = 10n ** BigInt(scaleDigits);
  return BigInt(match[1]!) * scale + BigInt((match[2] ?? "").padEnd(scaleDigits, "0") || "0");
}
export function formatFixed(value: bigint, scaleDigits: number): string {
  const scale = 10n ** BigInt(scaleDigits), negative = value < 0n, absolute = negative ? -value : value;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(scaleDigits, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
export function integerRoot(value: bigint, degree: number): bigint {
  if (value < 0n || degree < 1) throw new Error("invalid integer root input");
  if (value < 2n || degree === 1) return value;
  let low = 1n, high = value, answer = 1n;
  while (low <= high) {
    const mid = (low + high) >> 1n; let product = 1n;
    for (let i = 0; i < degree && product <= value; i += 1) product *= mid;
    if (product <= value) { answer = mid; low = mid + 1n; } else high = mid - 1n;
  }
  return answer;
}
export function floorPayout(stakeMicros: bigint, multiplierScaled: bigint): bigint {
  return stakeMicros * multiplierScaled / FACTOR_SCALE;
}
export function productFactors(factors: string[]): bigint {
  if (!factors.length) return FACTOR_SCALE;
  const numerator = factors.reduce((acc, factor) => acc * parseFixed(factor, 18)!, 1n);
  const productAtLegPrecision = numerator / (LEG_FACTOR_SCALE ** BigInt(factors.length - 1));
  return productAtLegPrecision / MULTIPLIER_PRECISION_RATIO;
}
export function complementPrice(price: string): string | null {
  const parsed = parseFixed(price, 8);
  if (parsed === null || parsed < 0n || parsed > PRICE_SCALE) return null;
  return formatFixed(PRICE_SCALE - parsed, 8);
}

export type QuoteDraftLeg = { marketId: string; side: Side; price: string };
export function createQuote(input: { userId: string; nonce: string; stake: string; legs: QuoteDraftLeg[]; houseEdge: string; ttlMs: number; nowMs: number }): { quote: Quote; payload: import("../types.js").QuotePayload } | null {
  const stake = parseFixed(input.stake, 6), edge = parseFixed(input.houseEdge, 12);
  if (stake === null || edge === null || stake <= 0n || edge <= 0n || edge >= FACTOR_SCALE || !input.nonce || input.legs.length < 2 || input.legs.length > 5) return null;
  const fairPrices: bigint[] = [];
  for (const leg of input.legs) { const p = parseFixed(leg.price, 8); if (p === null || p <= 0n || p >= PRICE_SCALE) return null; fairPrices.push(p); }
  const n = input.legs.length;
  const edgeAtFactorPrecision = edge * MULTIPLIER_PRECISION_RATIO;
  const rootTarget = (LEG_FACTOR_SCALE - edgeAtFactorPrecision) * (LEG_FACTOR_SCALE ** BigInt(n - 1));
  const perLegHouseFactor = integerRoot(rootTarget, n);
  const legs: QuoteLeg[] = input.legs.map((leg, index) => {
    const p = fairPrices[index]!;
    const fairFactor = PRICE_SCALE * LEG_FACTOR_SCALE / p;
    const factorScaled = fairFactor * perLegHouseFactor / LEG_FACTOR_SCALE;
    return { marketId: leg.marketId, side: leg.side, price: formatFixed(p, 8), factor: formatFixed(factorScaled, 18) };
  });
  const denominator = LEG_FACTOR_SCALE ** BigInt(n - 1);
  const fairProductAtLegPrecision = fairPrices.reduce((acc, price) => acc * (PRICE_SCALE * LEG_FACTOR_SCALE / price), 1n) / denominator;
  const fairMultiplier = fairProductAtLegPrecision / MULTIPLIER_PRECISION_RATIO;
  const multiplierScaled = fairProductAtLegPrecision * (FACTOR_SCALE - edge) / FACTOR_SCALE / MULTIPLIER_PRECISION_RATIO;
  const precedingProduct = legs.slice(0, -1).reduce((acc, leg) => acc * parseFixed(leg.factor, 18)!, 1n);
  const lowerBound = multiplierScaled * MULTIPLIER_PRECISION_RATIO * denominator;
  const lastFactor = (lowerBound + precedingProduct - 1n) / precedingProduct;
  legs[n - 1]!.factor = formatFixed(lastFactor, 18);
  const payout = floorPayout(stake, multiplierScaled);
  const impliedEdge = FACTOR_SCALE - multiplierScaled * FACTOR_SCALE / fairMultiplier;
  const expiresAt = new Date(input.nowMs + input.ttlMs).toISOString();
  const payload = { v: 1 as const, userId: input.userId, nonce: input.nonce, stake: formatFixed(stake, 6), multiplier: formatFixed(multiplierScaled, 12), payout: formatFixed(payout, 6), fairMultiplier: formatFixed(fairMultiplier, 12), impliedEdge: formatFixed(impliedEdge, 12), expiresAt, legs };
  const quote: Quote = { stake: payload.stake, multiplier: payload.multiplier, payout: payload.payout, fairMultiplier: payload.fairMultiplier, impliedEdge: payload.impliedEdge, expiresAt, legs };
  return { quote, payload };
}
