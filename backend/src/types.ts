export type Venue = "kalshi" | "polymarket";
export type Side = "YES" | "NO";
export type LegResult = "pending" | "win" | "lose" | "void";
export type ParlayStatus = "open" | "won" | "lost" | "void";
export type Resolution = "pending" | "yes" | "no" | "void";

export interface MarketRecord {
  id: string;
  venue: Venue;
  venueMarketId: string;
  eventId: string;
  title: string;
  category: string;
  rulesText: string;
  closeTime: Date;
  status: string;
  yesTokenId: string | null;
  noTokenId: string | null;
  conditionId: string | null;
  equivalenceGroup: string | null;
  isCombo: boolean;
}

export interface PricePoint {
  yesBid: string;
  yesAsk: string;
  noBid: string;
  noAsk: string;
  sourceTs: string | null;
  ingestedTs: string;
}

export interface LegInput { marketId: string; side: Side }
export interface QuoteLeg extends LegInput { price: string; factor: string }
export interface Quote {
  stake: string;
  multiplier: string;
  payout: string;
  fairMultiplier: string;
  impliedEdge: string;
  expiresAt: string;
  legs: QuoteLeg[];
}
export interface QuotePayload extends Quote { v: 1; userId: string; nonce: string }
