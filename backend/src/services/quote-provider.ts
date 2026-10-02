import type { QuoteDraftLeg } from "../core/parlay.js";
import { createQuote } from "../core/parlay.js";
import type { Quote } from "../types.js";

export type QuoteContext = { userId: string; nonce: string; stake: string; legs: QuoteDraftLeg[]; houseEdge: string; ttlMs: number; nowMs: number };
export interface QuoteProvider { quote(context: QuoteContext): { quote: Quote; payload: import("../types.js").QuotePayload } | null }
export class HouseMaker implements QuoteProvider { quote(context: QuoteContext) { return createQuote(context); } }
