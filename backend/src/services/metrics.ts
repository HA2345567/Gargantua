import type { Venue } from "../types.js";
import { getVenueHttpMetrics } from "../venues/http.js";

const SAMPLE_LIMIT = 2_000;

function percentile(samples: number[], ratio: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

export class OperationalMetrics {
  private quotesIssued = 0;
  private stalePriceRefusals = 0;
  private quoteLatenciesMs: number[] = [];
  private settlementLagsMs: number[] = [];

  observeQuote(statusCode: number, latencyMs: number): void {
    if (statusCode === 200) this.quotesIssued += 1;
    this.quoteLatenciesMs.push(Math.max(0, latencyMs));
    if (this.quoteLatenciesMs.length > SAMPLE_LIMIT) this.quoteLatenciesMs.shift();
  }

  observeStalePriceRefusal(): void { this.stalePriceRefusals += 1; }

  observeSettlementLag(lagMs: number): void {
    if (!Number.isFinite(lagMs) || lagMs < 0) return;
    this.settlementLagsMs.push(lagMs);
    if (this.settlementLagsMs.length > SAMPLE_LIMIT) this.settlementLagsMs.shift();
  }

  snapshot(parlaysByStatus: Record<string, number>): Record<string, unknown> {
    const http = getVenueHttpMetrics();
    const venue = (name: Venue) => {
      const item = http[name];
      return { requestCount: item.requestCount, errorCount: item.errorCount, errorRate: item.requestCount ? item.errorCount / item.requestCount : 0, rateLimitWaits: item.rateLimitWaits };
    };
    return {
      quotes: { issued: this.quotesIssued, latencySampleCount: this.quoteLatenciesMs.length, latencyP95Ms: percentile(this.quoteLatenciesMs, 0.95) },
      stalePriceRefusals: this.stalePriceRefusals,
      venues: { kalshi: venue("kalshi"), polymarket: venue("polymarket") },
      settlementLag: { sampleCount: this.settlementLagsMs.length, p95Ms: percentile(this.settlementLagsMs, 0.95), maxMs: this.settlementLagsMs.length ? Math.max(...this.settlementLagsMs) : null },
      parlaysByStatus,
    };
  }
}
