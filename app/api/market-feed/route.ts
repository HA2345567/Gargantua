import { NextResponse } from "next/server";

export const revalidate = 15;

type ExternalMarket = Record<string, unknown>;

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function string(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function categoryFor(value: unknown, title: string): string {
  const category = `${string(value)} ${title}`.toLowerCase();
  if (category.includes("sport") || /\b(nba|nfl|mlb|nhl|wnba|ufc|championship|match|game|score|win the|vs\.?\s)/.test(category)) return "Sports";
  if (/\b(bitcoin|btc|ethereum|ether|eth|solana|xrp|crypto|dogecoin)\b/.test(category)) return "Crypto";
  if (/\b(election|president|senate|congress|parliament|prime minister|trump|iran|war|invasion|ceasefire|bolsonaro)\b/.test(category)) return "Politics";
  if (/\b(openai|anthropic|chatgpt|gemini|ai model|artificial intelligence|technology)\b/.test(category)) return "Tech";
  if (/\b(fed|interest rate|inflation|gdp|cpi|unemployment|recession|treasury)\b/.test(category)) return "Economics";
  if (category.includes("weather")) return "Weather";
  if (category.includes("entertain")) return "Entertainment";
  if (category.includes("econom")) return "Economics";
  return "Finance";
}

function imageUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = string(value);
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:") return parsed.toString();
    } catch { /* Ignore malformed upstream image URLs. */ }
  }
  return undefined;
}

function eventFor(row: ExternalMarket): ExternalMarket | undefined {
  const event = Array.isArray(row.events) ? row.events[0] as ExternalMarket | undefined : undefined;
  return event;
}

function eventImage(row: ExternalMarket): string | undefined {
  const event = eventFor(row);
  return imageUrl(row.image, row.icon, event?.image, event?.icon);
}

function volumeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function volumeLabel(value: unknown): string {
  const volume = volumeNumber(value);
  if (!volume) return "—";
  if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `$${(volume / 1_000).toFixed(0)}K`;
  return `$${Math.round(volume)}`;
}

function validClose(value: unknown): Date | null {
  const date = new Date(string(value));
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now() ? date : null;
}

function displayDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function polymarketCards(rows: ExternalMarket[]) {
  return rows.flatMap((row) => {
    const outcomes = stringArray(row.outcomes);
    const tokens = stringArray(row.clobTokenIds);
    const yesIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "yes");
    const noIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "no");
    const id = string(row.id);
    const title = string(row.question).trim();
    const close = validClose(row.endDate);
    if (!id || !title || !close || row.active !== true || row.closed !== false || row.enableOrderBook === false || yesIndex < 0 || noIndex < 0 || tokens.length !== 2) return [];

    const category = categoryFor(row.category, title);
    const slug = string(row.slug);
    return [{
      id: `polymarket:${id}`, title, category, venue: "Polymarket" as const,
      date: displayDate(close), expires: displayDate(close), closeTime: close.toISOString(),
      volume: volumeLabel(row.volumeNum ?? row.volume),
      volume24h: volumeLabel(row.volume24hr), volumeSort: volumeNumber(row.volume24hr ?? row.volumeNum ?? row.volume),
      marketCount: 1, image: category === "Sports" ? "sports" : category === "Crypto" ? "bitcoin" : category === "Weather" ? "weather" : "chart",
      imageUrl: eventImage(row), description: [string(row.description) || string(eventFor(row)?.description), string(row.resolutionSource || eventFor(row)?.resolutionSource)].filter(Boolean).join("\n\n"),
      sourceUrl: slug ? `https://polymarket.com/market/${encodeURIComponent(slug)}` : "https://polymarket.com/",
      conditionId: string(row.conditionId), yesTokenId: tokens[yesIndex], noTokenId: tokens[noIndex], displayType: "thresholds" as const,
      outcomes: [{ label: "Yes" }],
    }];
  });
}

function kalshiCards(rows: ExternalMarket[]) {
  return rows.flatMap((row) => {
    const ticker = string(row.ticker);
    const title = string(row.title).trim();
    const close = validClose(row.close_time ?? row.expected_expiration_time);
    const status = string(row.status).toLowerCase();
    if (!ticker || !title || !close || ["closed", "settled", "inactive"].includes(status) || row.market_type !== "binary" || row.mve_collection_ticker || row.mve_selected_legs) return [];

    const category = categoryFor(row.category, title);
    const description = [string(row.rules_primary), string(row.rules_secondary)].filter(Boolean).join("\n\n");
    const volume24h = row.volume_24h_fp ?? row.volume_24h ?? row.volume_24hr;
    const volume = row.volume_fp ?? row.volume;
    return [{
      id: `kalshi:${ticker}`, title, category, venue: "Kalshi" as const,
      date: displayDate(close), expires: displayDate(close), closeTime: close.toISOString(),
      volume: volumeLabel(volume), volume24h: volumeLabel(volume24h), volumeSort: volumeNumber(volume24h ?? volume),
      marketCount: 1, image: category === "Sports" ? "sports" : category === "Crypto" ? "bitcoin" : category === "Weather" ? "weather" : "chart",
      imageUrl: imageUrl(row.image_url, row.image, row.icon_url), description,
      sourceUrl: "https://kalshi.com/", displayType: "thresholds" as const,
      outcomes: [{ label: "Yes" }],
    }];
  });
}

async function fetchRows(url: URL, key: string): Promise<ExternalMarket[]> {
  const response = await fetch(url, { next: { revalidate: 15 }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${key} market feed returned ${response.status}`);
  const payload = await response.json() as Record<string, unknown> | ExternalMarket[];
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload[key]) ? payload[key] as ExternalMarket[] : [];
}

export async function GET() {
  const polymarketUrl = new URL("https://gamma-api.polymarket.com/markets");
  polymarketUrl.searchParams.set("active", "true");
  polymarketUrl.searchParams.set("closed", "false");
  polymarketUrl.searchParams.set("limit", "100");
  polymarketUrl.searchParams.set("order", "volume24hr");
  polymarketUrl.searchParams.set("ascending", "false");

  const kalshiUrl = new URL("https://external-api.kalshi.com/trade-api/v2/markets");
  kalshiUrl.searchParams.set("status", "open");
  kalshiUrl.searchParams.set("mve_filter", "exclude");
  kalshiUrl.searchParams.set("limit", "100");

  const [polymarket, kalshi] = await Promise.allSettled([
    fetchRows(polymarketUrl, "markets"),
    fetchRows(kalshiUrl, "markets"),
  ]);
  const polyMarkets = polymarket.status === "fulfilled" ? polymarketCards(polymarket.value) : [];
  const kalshiMarkets = kalshi.status === "fulfilled" ? kalshiCards(kalshi.value) : [];
  // Balance the first screen so both venues stay visible even when one has much larger volume.
  const rankedPolymarket = polyMarkets.sort((a, b) => b.volumeSort - a.volumeSort).slice(0, 50);
  const rankedKalshi = kalshiMarkets.sort((a, b) => b.volumeSort - a.volumeSort).slice(0, 50);
  const markets = Array.from({ length: Math.max(rankedPolymarket.length, rankedKalshi.length) }, (_, index) => [rankedPolymarket[index], rankedKalshi[index]])
    .flat()
    .filter((market): market is (typeof rankedPolymarket)[number] => Boolean(market))

  if (!markets.length) {
    console.error("Both live market feeds failed", {
      polymarket: polymarket.status === "rejected" ? polymarket.reason : "no eligible markets",
      kalshi: kalshi.status === "rejected" ? kalshi.reason : "no eligible markets",
    });
    return NextResponse.json({ error: "Live market feeds unavailable" }, { status: 502 });
  }

  return NextResponse.json({ markets, sources: { polymarket: polyMarkets.length, kalshi: kalshiMarkets.length } }, {
    headers: { "Cache-Control": "s-maxage=15, stale-while-revalidate=45" },
  });
}
