type Bucket = { nextAt: number; spacing: number };
const buckets = new Map<string, Bucket>();
type VenueHttpMetrics = { requestCount: number; errorCount: number; rateLimitWaits: number };
const venueHttpMetrics: Record<"kalshi" | "polymarket", VenueHttpMetrics> = {
  kalshi: { requestCount: 0, errorCount: 0, rateLimitWaits: 0 },
  polymarket: { requestCount: 0, errorCount: 0, rateLimitWaits: 0 },
};

function metricVenue(origin: string): "kalshi" | "polymarket" | null {
  if (origin.includes("kalshi.com")) return "kalshi";
  if (origin.includes("polymarket.com")) return "polymarket";
  return null;
}

export function getVenueHttpMetrics(): Record<"kalshi" | "polymarket", VenueHttpMetrics> {
  return { kalshi: { ...venueHttpMetrics.kalshi }, polymarket: { ...venueHttpMetrics.polymarket } };
}

async function pace(origin: string, requestsPerSecond: number): Promise<void> {
  const now = Date.now();
  const bucket = buckets.get(origin) ?? { nextAt: now, spacing: 1000 / requestsPerSecond };
  const wait = Math.max(0, bucket.nextAt - now);
  bucket.nextAt = Math.max(now, bucket.nextAt) + bucket.spacing;
  buckets.set(origin, bucket);
  if (wait) {
    const venue = metricVenue(origin);
    if (venue) venueHttpMetrics[venue].rateLimitWaits += 1;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export async function getJson<T>(url: URL, requestsPerSecond = 5, headers: Record<string, string> = {}): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await pace(url.origin, requestsPerSecond);
    const venue = metricVenue(url.origin);
    if (venue) venueHttpMetrics[venue].requestCount += 1;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json", ...headers } });
      if (!response.ok && venue) venueHttpMetrics[venue].errorCount += 1;
      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3000) : 400));
        continue;
      }
      if (!response.ok) return null;
      return await response.json() as T;
    } catch {
      if (venue) venueHttpMetrics[venue].errorCount += 1;
      if (attempt === 1) return null;
    }
  }
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function asString(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
export function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
  return [];
}

const SCALE = 100_000_000n;
export function priceToScaled(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,8})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const scaled = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
  return scaled > 0n && scaled < SCALE ? scaled : null;
}
export function formatPrice(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
export function bidAsk(bids: unknown, asks: unknown): { bid: string; ask: string } | null {
  const valid = (levels: unknown) => Array.isArray(levels) ? levels.map((level) => {
    if (Array.isArray(level)) return priceToScaled(level[0]);
    const row = asRecord(level); return priceToScaled(row?.price);
  }).filter((price): price is bigint => price !== null) : [];
  const bidPrices = valid(bids), askPrices = valid(asks);
  if (!bidPrices.length || !askPrices.length) return null;
  const bid = bidPrices.reduce((a, b) => a > b ? a : b), ask = askPrices.reduce((a, b) => a < b ? a : b);
  if (ask < bid) return null;
  return { bid: formatPrice(bid), ask: formatPrice(ask) };
}
export function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value); return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
