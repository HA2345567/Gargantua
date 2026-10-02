export type Outcome = { label: string };

export type Market = {
  id: string;
  title: string;
  category: string;
  venue: "Kalshi" | "Polymarket";
  date: string;
  expires: string;
  closeTime: string;
  volume: string;
  marketCount: number;
  volumeSort: number;
  image: string;
  imageUrl?: string;
  description?: string;
  sourceUrl?: string;
  volume24h?: string;
  yesTokenId?: string;
  noTokenId?: string;
  conditionId?: string;
  displayType: "teams" | "thresholds";
  outcomes: Outcome[];
};

export type ParlayLeg = {
  marketId: string;
  title: string;
  outcome: string;
  side: "Yes" | "No";
};

export const categories = ["All", "Crypto", "Finance", "Economics", "Sports", "Politics", "Tech", "Entertainment", "Weather"];
