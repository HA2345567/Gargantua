import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { createBearerToken, hashBearerToken } from "./auth/token.js";
import { withTx } from "./db/pool.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { PriceService } from "./services/prices.js";
import type { VenueAdapter } from "./venues/adapter.js";
import { complementPrice, formatFixed, parseFixed } from "./core/parlay.js";
import { signQuote, verifyQuote } from "./services/quote-token.js";
import { HouseMaker, type QuoteProvider } from "./services/quote-provider.js";
import { PostgresVirtualLedger } from "./services/ledger.js";
import { setEquivalenceGroup } from "./services/catalog.js";
import { OperationalMetrics } from "./services/metrics.js";
import { createSolanaQuote } from "./solana/quote.js";
import { verifyPrivyAccessToken } from "./auth/privy.js";
import { decodeSolanaAddress, verifySolanaWalletBinding } from "./auth/solana-wallet.js";
import { confirmSolanaAcceptance } from "./solana/confirm.js";

declare module "fastify" {
  interface FastifyRequest { userId: string | null; privyDid: string | null; quoteStartedAt: number | null }
  interface FastifyInstance { metrics: OperationalMetrics; config: AppConfig }
}

const registerSchema = z.object({ email: z.string().trim().email().max(254) }).strict();
const equivalenceGroupSchema = z.object({ equivalenceGroup: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9:_-]{0,63}$/).nullable() }).strict();
function rateLimit(limit: number, windowMs: number, keyFor: (request: FastifyRequest) => string = (request) => request.ip) {
  const clients = new Map<string, { count: number; resetAt: number }>();
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = Date.now(), key = keyFor(request);
    let entry = clients.get(key);
    if (!entry || entry.resetAt <= now) { entry = { count: 0, resetAt: now + windowMs }; clients.set(key, entry); }
    entry.count += 1;
    if (clients.size > 10_000) for (const [ip, value] of clients) if (value.resetAt <= now) clients.delete(ip);
    if (entry.count > limit) {
      reply.header("retry-after", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      apiError(reply, 429, "rate_limited", "too many requests");
    }
  };
}

function apiError(reply: FastifyReply, status: number, code: string, message: string, details: unknown = {}): FastifyReply {
  return reply.code(status).send({ error: { code, message, details } });
}

function isPgUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    apiError(reply, 401, "unauthorized", "bearer token required");
    return;
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (token.length < 32 || token.length > 8192) {
    apiError(reply, 401, "unauthorized", "invalid bearer token");
    return;
  }
  const config = request.server.config;
  if (config.PRIVY_APP_ID && config.PRIVY_VERIFICATION_KEY) {
    try {
      const claims = verifyPrivyAccessToken(token, config.PRIVY_APP_ID, config.PRIVY_VERIFICATION_KEY);
      request.privyDid = claims.sub;
    } catch {
      apiError(reply, 401, "unauthorized", "invalid or expired Privy access token");
      return;
    }
    const user = await request.server.pg.query<{ id: string }>("SELECT id FROM users WHERE privy_did = $1", [request.privyDid]);
    if (!user.rows[0]) {
      apiError(reply, 401, "session_not_initialized", "bind your Solana wallet to initialize your account");
      return;
    }
    request.userId = user.rows[0].id;
    return;
  }
  const user = await request.server.pg.query<{ id: string }>("SELECT id FROM users WHERE token_hash = $1", [hashBearerToken(token)]);
  if (!user.rows[0]) {
    apiError(reply, 401, "unauthorized", "invalid bearer token");
    return;
  }
  request.userId = user.rows[0].id;
}

function authenticatePrivy(config: AppConfig) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    if (!config.PRIVY_APP_ID || !config.PRIVY_VERIFICATION_KEY) return void apiError(reply, 503, "privy_unavailable", "Privy authentication is not configured");
    if (token.length < 32 || token.length > 8192) return void apiError(reply, 401, "unauthorized", "Privy access token required");
    try { request.privyDid = verifyPrivyAccessToken(token, config.PRIVY_APP_ID, config.PRIVY_VERIFICATION_KEY).sub; }
    catch { return void apiError(reply, 401, "unauthorized", "invalid or expired Privy access token"); }
  };
}

function authenticateAdmin(config: AppConfig) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!config.ADMIN_API_TOKEN) { apiError(reply, 404, "not_found", "not found"); return; }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    const suppliedHash = createHash("sha256").update(token).digest();
    const expectedHash = createHash("sha256").update(config.ADMIN_API_TOKEN).digest();
    if (!token || !timingSafeEqual(suppliedHash, expectedHash)) { apiError(reply, 401, "unauthorized", "admin bearer token required"); return; }
  };
}

export function buildServer(config: AppConfig, pool: Pool, adapters: VenueAdapter[] = [], quoteProvider: QuoteProvider = new HouseMaker()): FastifyInstance {
  const app = Fastify({
    logger: { level: config.NODE_ENV === "test" ? "silent" : "info", redact: ["req.headers.authorization", "req.headers.cookie"] },
    bodyLimit: 16_384,
  });
  app.decorate("pg", pool);
  app.decorate("config", config);
  const prices = new PriceService(pool, adapters, config.PRICE_CACHE_TTL_MS, config.MAX_PRICE_AGE_MS);
  const ledger = new PostgresVirtualLedger();
  const metrics = new OperationalMetrics();
  const registrationByEmailLimit = rateLimit(5, 60_000, (request) => {
    const parsed = registerSchema.safeParse(request.body);
    return parsed.success ? `email:${parsed.data.email.toLowerCase()}` : request.ip;
  });
  app.decorateRequest("userId", null);
  app.decorateRequest("privyDid", null);
  app.decorateRequest("quoteStartedAt", null);
  app.decorate("metrics", metrics);
  app.register(cors, { origin: config.CORS_ORIGIN, methods: ["GET", "POST", "PUT", "OPTIONS"] });

  app.addHook("onRequest", async (request) => {
    if (request.method === "POST" && (request.url.split("?")[0] ?? "") === "/api/quote") request.quoteStartedAt = performance.now();
  });
  app.addHook("onResponse", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (request.quoteStartedAt !== null) metrics.observeQuote(reply.statusCode, performance.now() - request.quoteStartedAt);
    if (reply.statusCode === 503 && (path === "/api/quote" || /^\/api\/markets\/[^/]+\/price$/.test(path))) metrics.observeStalePriceRefusal();
  });

  app.setErrorHandler((error, request, reply) => {
    const typedError = error as Error & { validation?: unknown };
    if (typedError.validation) {
      apiError(reply, 400, "invalid_request", "request validation failed", { issues: typedError.validation });
      return;
    }
    request.log.error({ err: error }, "request failed");
    apiError(reply, 500, "internal_error", "internal server error");
  });

  app.get("/health", async (_request, reply) => {
    try {
      const [dbResult, marketResult, venueResult, settlementResult, unresolvedResult] = await Promise.all([
        pool.query<{ now: Date }>("SELECT now() AS now"),
        pool.query<{ count: string }>("SELECT count(*)::text AS count FROM markets WHERE status = 'open' AND is_combo = false"),
        pool.query<{ venue: string; last_succeeded_at: Date | null; last_error: string | null; markets_seen: number }>("SELECT venue, last_succeeded_at, last_error, markets_seen FROM venue_sync_state ORDER BY venue"),
        pool.query<{ value: { lastRunAt?: string; lastError?: string } }>("SELECT value FROM system_state WHERE key = 'settlement'").catch(() => ({ rows: [] as { value: { lastRunAt?: string; lastError?: string } }[] })),
        pool.query<{ count: string; oldest_close_time: Date | null }>("SELECT count(DISTINCT m.id)::text AS count,min(m.close_time) AS oldest_close_time FROM markets m JOIN parlay_legs l ON l.market_id=m.id JOIN parlays p ON p.id=l.parlay_id WHERE p.status='open' AND l.result='pending' AND m.close_time < now()-($1 * interval '1 day')", [config.SETTLEMENT_ALERT_DAYS]),
      ]);
      const venueErrors = venueResult.rows.filter((venue) => venue.last_error !== null);
      const settlement = settlementResult.rows[0]?.value ?? { lastRunAt: null, lastError: null };
      const status = venueErrors.length > 0 || settlement.lastError ? "degraded" : "ok";
      return reply.send({
        status,
        database: { status: "ok", checkedAt: dbResult.rows[0]?.now ?? new Date().toISOString() },
        openMarketCount: Number(marketResult.rows[0]?.count ?? 0),
        venues: Object.fromEntries(venueResult.rows.map((row) => [row.venue, {
          lastSuccessAt: row.last_succeeded_at,
          lastError: row.last_error,
          marketsSeen: row.markets_seen,
        }])),
        settlement,
        unresolvedMarkets: { alertAfterDays: config.SETTLEMENT_ALERT_DAYS, count: Number(unresolvedResult.rows[0]?.count ?? 0), oldestCloseTime: unresolvedResult.rows[0]?.oldest_close_time ?? null },
      });
    } catch (error) {
      requestLogError(app, error);
      return apiError(reply, 503, "database_unavailable", "database unavailable");
    }
  });

  app.post("/api/auth/register", { preHandler: [rateLimit(10, 60_000), registrationByEmailLimit] }, async (request, reply) => {
    if (config.PRIVY_APP_ID) return apiError(reply, 404, "not_found", "not found");
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return apiError(reply, 400, "invalid_request", "valid email is required", { issues: parsed.error.issues });
    }
    const email = parsed.data.email.toLowerCase();
    const token = createBearerToken();
    const tokenHash = hashBearerToken(token);
    try {
      const user = await withTx(pool, async (client) => {
        const inserted = await client.query<{ id: string; email: string; balance: string; created_at: Date }>(
          "INSERT INTO users (email, token_hash, balance) VALUES ($1, $2, $3) RETURNING id, email, balance::text AS balance, created_at",
          [email, tokenHash, config.STARTING_BALANCE],
        );
        const created = inserted.rows[0];
        if (!created) throw new Error("user insert did not return a row");
        if (parseFixed(config.STARTING_BALANCE, 6)! > 0n) {
          await client.query(
            "INSERT INTO ledger_entries (user_id, kind, amount, idempotency_key) VALUES ($1, 'grant', $2, $3)",
            [created.id, config.STARTING_BALANCE, `register-grant:${created.id}`],
          );
        }
        return created;
      });
      return reply.code(201).send({ user: { id: user.id, email: user.email, balance: user.balance, createdAt: user.created_at }, token });
    } catch (error) {
      if (isPgUniqueViolation(error)) return apiError(reply, 409, "email_taken", "email is already registered");
      throw error;
    }
  });

  app.post("/api/auth/session", { preHandler: [authenticatePrivy(config), rateLimit(20, 60_000)] }, async (request, reply) => {
    const body = z.object({ solanaAddress: z.string().min(32).max(44), signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(256) }).strict().safeParse(request.body);
    if (!body.success || !request.privyDid) return apiError(reply, 400, "invalid_request", "a Solana wallet signature is required");
    const message = `TOTALIS_PRIVY_WALLET_BIND_V1|${request.privyDid}|${body.data.solanaAddress}`;
    try { decodeSolanaAddress(body.data.solanaAddress); }
    catch { return apiError(reply, 400, "invalid_wallet", "invalid Solana address"); }
    if (!verifySolanaWalletBinding(body.data.solanaAddress, message, body.data.signature)) return apiError(reply, 401, "wallet_signature_invalid", "wallet signature does not match the Privy identity");
    const user = await withTx(pool, async (client) => {
      const existing = await client.query<{ id: string; balance: string; created_at: Date }>("SELECT id,balance::text AS balance,created_at FROM users WHERE privy_did=$1 FOR UPDATE", [request.privyDid]);
      if (existing.rows[0]) {
        await client.query("UPDATE users SET solana_address=$2 WHERE id=$1", [existing.rows[0].id, body.data.solanaAddress]);
        return existing.rows[0];
      }
      const inserted = await client.query<{ id: string; balance: string; created_at: Date }>("INSERT INTO users (privy_did,solana_address,balance) VALUES ($1,$2,$3) RETURNING id,balance::text AS balance,created_at", [request.privyDid, body.data.solanaAddress, config.STARTING_BALANCE]);
      const created = inserted.rows[0];
      if (!created) throw new Error("Privy account insert did not return a row");
      if (parseFixed(config.STARTING_BALANCE, 6)! > 0n) await client.query("INSERT INTO ledger_entries (user_id,kind,amount,idempotency_key) VALUES ($1,'grant',$2,$3)", [created.id, config.STARTING_BALANCE, `register-grant:${created.id}`]);
      return created;
    });
    return reply.send({ user: { id: user.id, privyDid: request.privyDid, solanaAddress: body.data.solanaAddress, balance: user.balance, createdAt: user.created_at } });
  });

  app.get("/api/me", { preHandler: authenticate }, async (request, reply) => {
    const result = await pool.query<{ id: string; email: string; balance: string; created_at: Date }>(
      "SELECT id, email, balance::text AS balance, created_at FROM users WHERE id = $1", [request.userId],
    );
    const user = result.rows[0];
    if (!user) return apiError(reply, 401, "unauthorized", "user account unavailable");
    return reply.send({ user: { id: user.id, email: user.email, balance: user.balance, createdAt: user.created_at } });
  });

  app.get("/api/ledger", { preHandler: authenticate }, async (request, reply) => {
    const result = await pool.query(
      "SELECT id, kind, amount::text AS amount, parlay_id AS \"parlayId\", created_at AS \"createdAt\" FROM ledger_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
      [request.userId],
    );
    return reply.send({ entries: result.rows });
  });

  app.put("/api/admin/markets/:id/equivalence-group", { preHandler: [rateLimit(30, 60_000), authenticateAdmin(config)] }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(200) }).safeParse(request.params);
    const body = equivalenceGroupSchema.safeParse(request.body);
    if (!params.success || !body.success) return apiError(reply, 400, "invalid_request", "market id or equivalence group is invalid", { issues: [...(params.success ? [] : params.error.issues), ...(body.success ? [] : body.error.issues)] });
    const market = await setEquivalenceGroup(pool, params.data.id, body.data.equivalenceGroup);
    if (!market) return apiError(reply, 404, "market_not_found", "market not found");
    return reply.send({ market });
  });

  app.get("/api/admin/metrics", { preHandler: [rateLimit(60, 60_000), authenticateAdmin(config)] }, async (_request, reply) => {
    const result = await pool.query<{ status: string; count: string }>("SELECT status,count(*)::text AS count FROM parlays GROUP BY status");
    const statuses: Record<string, number> = { open: 0, won: 0, lost: 0, void: 0 };
    for (const row of result.rows) statuses[row.status] = Number(row.count);
    return reply.send({ metrics: metrics.snapshot(statuses) });
  });

  app.get("/api/markets", async (request, reply) => {
    const query = z.object({ q: z.string().trim().max(120).optional(), venue: z.enum(["kalshi", "polymarket"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).max(100_000).default(0) }).safeParse(request.query);
    if (!query.success) return apiError(reply, 400, "invalid_request", "invalid market search parameters", { issues: query.error.issues });
    const { q, venue, limit, offset } = query.data;
    const values: unknown[] = []; const conditions = ["status='open'", "is_combo=false", "close_time > now()"];
    if (q) { values.push(q); conditions.push(`(title ILIKE '%' || $${values.length} || '%' OR category ILIKE '%' || $${values.length} || '%')`); }
    if (venue) { values.push(venue); conditions.push(`venue=$${values.length}`); }
    values.push(limit, offset);
    const result = await pool.query(`SELECT id,venue,venue_market_id AS "venueMarketId",event_id AS "eventId",title,category,rules_text AS "rulesText",close_time AS "closeTime",status,yes_token_id AS "yesTokenId",no_token_id AS "noTokenId",condition_id AS "conditionId",equivalence_group AS "equivalenceGroup" FROM markets WHERE ${conditions.join(" AND ")} ORDER BY close_time ASC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return reply.send({ markets: result.rows, limit, offset });
  });

  app.get("/api/markets/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(200) }).safeParse(request.params);
    if (!params.success) return apiError(reply, 400, "invalid_request", "invalid market id");
    const result = await pool.query("SELECT id,venue,venue_market_id AS \"venueMarketId\",event_id AS \"eventId\",title,category,rules_text AS \"rulesText\",close_time AS \"closeTime\",status,yes_token_id AS \"yesTokenId\",no_token_id AS \"noTokenId\",condition_id AS \"conditionId\",equivalence_group AS \"equivalenceGroup\" FROM markets WHERE id=$1 AND status='open' AND is_combo=false AND close_time > now()", [params.data.id]);
    if (!result.rows[0]) return apiError(reply, 404, "market_not_found", "market not found or no longer open");
    return reply.send({ market: result.rows[0] });
  });

  app.get("/api/markets/:id/price", async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(200) }).safeParse(request.params);
    if (!params.success) return apiError(reply, 400, "invalid_request", "invalid market id");
    const result = await prices.get(params.data.id);
    if (!result) {
      const exists = await pool.query("SELECT id FROM markets WHERE id=$1", [params.data.id]);
      if (!exists.rows[0]) return apiError(reply, 404, "market_not_found", "market not found");
      return apiError(reply, 503, "price_unavailable", "a fresh two-sided book is unavailable");
    }
    const { market, price, ageMs } = result;
    return reply.send({ marketId: market.id, venue: market.venue, yes: { bid: price.yesBid, ask: price.yesAsk }, no: { bid: price.noBid, ask: price.noAsk }, sourceTs: price.sourceTs, ingestedTs: price.ingestedTs, ageMs, source: "rest" });
  });

  app.post("/api/quote", { preHandler: [authenticate, rateLimit(60, 60_000), rateLimit(30, 60_000, (request) => request.userId ?? request.ip)] }, async (request, reply) => {
    const body = z.object({ stake: z.string().regex(/^(0|[1-9]\d*)(?:\.\d{1,6})?$/), legs: z.array(z.object({ marketId: z.string().min(1).max(200), side: z.enum(["YES", "NO"]) }).strict()).min(2).max(5), solanaOwner: z.string().min(32).max(44).optional() }).strict().safeParse(request.body);
    if (!body.success) return apiError(reply, 400, "invalid_request", "quote request is invalid", { issues: body.error.issues });
    const invalid: { marketId: string; code: string; message: string }[] = [];
    const ids = body.data.legs.map((leg) => leg.marketId);
    if (new Set(ids).size !== ids.length) invalid.push({ marketId: "", code: "duplicate_market", message: "a market may appear only once" });
    const stake = parseFixed(body.data.stake, 6)!;
    const minStake = parseFixed(config.MIN_STAKE, 6)!, maxStake = parseFixed(config.MAX_STAKE, 6)!;
    if (stake < minStake || stake > maxStake) invalid.push({ marketId: "", code: "stake_limit", message: `stake must be between ${config.MIN_STAKE} and ${config.MAX_STAKE}` });
    const selected: { marketId: string; side: "YES" | "NO"; price: string; eventId: string; equivalenceGroup: string | null }[] = [];
    const fresh = await Promise.all(body.data.legs.map((leg) => prices.get(leg.marketId, true)));
    const unavailable = body.data.legs.flatMap((leg, index) => fresh[index] ? [] : [leg.marketId]);
    if (unavailable.length) return apiError(reply, 503, "price_unavailable", "fresh two-sided prices are unavailable", { errors: unavailable.map((id) => `${id}: fresh price unavailable`) });
    for (const [index, leg] of body.data.legs.entries()) {
      const result = fresh[index]!;
      if (result.market.closeTime.getTime() <= Date.now()) invalid.push({ marketId: leg.marketId, code: "market_closed", message: "market is no longer open" });
      if (result.market.closeTime.getTime() - Date.now() > config.MAX_HORIZON_DAYS * 86_400_000) invalid.push({ marketId: leg.marketId, code: "horizon_exceeded", message: "market closes beyond the supported horizon" });
      const bid = parseFixed(result.price.yesBid, 8)!, ask = parseFixed(result.price.yesAsk, 8)!;
      const price = leg.side === "YES" ? result.price.yesAsk : complementPrice(result.price.yesBid)!;
      const scaledPrice = parseFixed(price, 8)!;
      if (scaledPrice < 2_000_000n || scaledPrice > 98_000_000n) invalid.push({ marketId: leg.marketId, code: "price_range", message: "selected-side ask must be between 0.02 and 0.98" });
      if (ask - bid > 15_000_000n) invalid.push({ marketId: leg.marketId, code: "yes_spread", message: "YES spread must not exceed 0.15" });
      selected.push({ marketId: leg.marketId, side: leg.side, price, eventId: result.market.eventId, equivalenceGroup: result.market.equivalenceGroup });
    }
    const events = selected.map((leg) => leg.eventId);
    if (new Set(events).size !== events.length) invalid.push({ marketId: "", code: "same_event", message: "parlay legs must come from distinct events" });
    const groups = selected.map((leg) => leg.equivalenceGroup).filter((group): group is string => group !== null);
    if (new Set(groups).size !== groups.length) invalid.push({ marketId: "", code: "equivalent_markets", message: "parlay legs cannot share an equivalence group" });
    if (invalid.length) return apiError(reply, 422, "invalid_parlay", "one or more parlay rules failed", { errors: invalid.map((item) => `${item.marketId ? `${item.marketId}: ` : ""}${item.message}`), issues: invalid });
    const quote = quoteProvider.quote({ userId: request.userId!, nonce: randomUUID(), stake: body.data.stake, legs: selected.map(({ marketId, side, price }) => ({ marketId, side, price })), houseEdge: config.HOUSE_EDGE, ttlMs: config.QUOTE_TTL_MS, nowMs: Date.now() });
    if (!quote) return apiError(reply, 422, "invalid_parlay", "quote inputs are invalid");
    if (parseFixed(quote.payload.payout, 6)! > parseFixed(config.MAX_PAYOUT, 6)!) return apiError(reply, 422, "invalid_parlay", "potential payout exceeds the configured limit", { maxPayout: config.MAX_PAYOUT });
    const expiresInMs = Math.max(0, Date.parse(quote.quote.expiresAt) - Date.now());
    const titles = Object.fromEntries(fresh.map((result) => [result!.market.id, result!.market.title]));
    if (body.data.solanaOwner && !config.SOLANA_PROGRAM_ID) return apiError(reply, 503, "solana_unavailable", "Solana quote signing is not configured");
    let solanaQuote;
    if (body.data.solanaOwner && config.SOLANA_PROGRAM_ID && config.SOLANA_ESCROW_MINT && config.SOLANA_QUOTE_SIGNER_PRIVATE_KEY_PEM) {
      try {
        solanaQuote = createSolanaQuote(quote.payload, body.data.solanaOwner, {
          programId: config.SOLANA_PROGRAM_ID,
          mint: config.SOLANA_ESCROW_MINT,
          privateKeyPem: config.SOLANA_QUOTE_SIGNER_PRIVATE_KEY_PEM,
        });
      } catch (error) {
        request.log.warn({ err: error }, "failed to create Solana quote");
        return apiError(reply, 400, "invalid_solana_owner", "Solana owner address or quote signing configuration is invalid");
      }
    }
    return reply.send({ quote: quote.quote, token: signQuote(quote.payload, config.QUOTE_SECRET), titles, expiresInMs, ...(solanaQuote ? { solanaQuote } : {}) });
  });

  app.post("/api/solana/parlays/confirm", { preHandler: [authenticate, rateLimit(20, 60_000, (request) => request.userId ?? request.ip)] }, async (request, reply) => {
    const body = z.object({ token: z.string().min(32).max(8192), transactionSignature: z.string().min(80).max(100), parlayAddress: z.string().min(32).max(44) }).strict().safeParse(request.body);
    if (!body.success || !request.userId) return apiError(reply, 400, "invalid_request", "valid quote token, transaction signature, and parlay address are required");
    if (!config.SOLANA_PROGRAM_ID || !config.SOLANA_ESCROW_MINT || !config.SOLANA_QUOTE_SIGNER_PRIVATE_KEY_PEM) return apiError(reply, 503, "solana_unavailable", "Solana escrow is not configured");
    const signedQuote = verifyQuote(body.data.token, config.QUOTE_SECRET);
    if (!signedQuote || signedQuote.userId !== request.userId) return apiError(reply, 409, "quote_invalid", "the signed quote is invalid or belongs to another account");
    const user = await pool.query<{ solana_address: string | null }>("SELECT solana_address FROM users WHERE id=$1", [request.userId]);
    const walletAddress = user.rows[0]?.solana_address;
    if (!walletAddress) return apiError(reply, 409, "wallet_not_bound", "bind a Solana wallet to your Privy account first");
    try {
      await confirmSolanaAcceptance({
        rpcUrl: config.SOLANA_RPC_URL,
        quote: signedQuote,
        owner: walletAddress,
        parlayAddress: body.data.parlayAddress,
        transactionSignature: body.data.transactionSignature,
        config: { programId: config.SOLANA_PROGRAM_ID, mint: config.SOLANA_ESCROW_MINT, privateKeyPem: config.SOLANA_QUOTE_SIGNER_PRIVATE_KEY_PEM },
      });
    } catch (error) {
      request.log.warn({ err: error }, "Solana parlay confirmation failed");
      return apiError(reply, 409, "solana_transaction_unconfirmed", error instanceof Error ? error.message : "Solana transaction could not be confirmed");
    }
    try {
      const parlay = await withTx(pool, async (client) => {
        const inserted = await client.query<{ id: string; status: string; stake: string; quoted_payout: string }>(
          "INSERT INTO solana_parlays (user_id,wallet_address,quote_nonce,program_id,mint,parlay_address,accept_signature,stake,multiplier,quoted_payout) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,status,stake::text AS stake,quoted_payout::text AS quoted_payout",
          [request.userId, walletAddress, signedQuote.nonce, config.SOLANA_PROGRAM_ID, config.SOLANA_ESCROW_MINT, body.data.parlayAddress, body.data.transactionSignature, signedQuote.stake, signedQuote.multiplier, signedQuote.payout],
        );
        const created = inserted.rows[0];
        if (!created) throw new Error("Solana parlay insert did not return a row");
        for (const [index, leg] of signedQuote.legs.entries()) await client.query(
          "INSERT INTO solana_parlay_legs (parlay_id,idx,market_id,side,quoted_price,factor) VALUES ($1,$2,$3,$4,$5,$6)",
          [created.id,index,leg.marketId,leg.side,leg.price,leg.factor],
        );
        return created;
      });
      return reply.code(201).send({ parlay: { id: parlay.id, status: parlay.status, stake: parlay.stake, quotedPayout: parlay.quoted_payout, walletAddress, parlayAddress: body.data.parlayAddress, transactionSignature: body.data.transactionSignature } });
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        const existing = await pool.query<{ id: string; status: string; stake: string; quoted_payout: string }>("SELECT id,status,stake::text AS stake,quoted_payout::text AS quoted_payout FROM solana_parlays WHERE user_id=$1 AND (parlay_address=$2 OR accept_signature=$3)", [request.userId,body.data.parlayAddress,body.data.transactionSignature]);
        if (existing.rows[0]) return reply.code(200).send({ parlay: existing.rows[0] });
        return apiError(reply, 409, "solana_quote_already_used", "this quote or transaction has already been recorded");
      }
      throw error;
    }
  });

  app.get("/api/solana/parlays", { preHandler: authenticate }, async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100_000).default(0) }).safeParse(request.query);
    if (!query.success) return apiError(reply, 400, "invalid_request", "invalid pagination parameters");
    const { limit, offset } = query.data;
    const result = await pool.query(
      `SELECT p.id,p.wallet_address AS "walletAddress",p.mint,p.parlay_address AS "parlayAddress",p.accept_signature AS "acceptSignature",p.settlement_signature AS "settlementSignature",p.stake::text AS stake,p.multiplier::text AS multiplier,p.quoted_payout::text AS "quotedPayout",p.payout::text AS payout,p.status,p.created_at AS "createdAt",p.settled_at AS "settledAt",COALESCE(jsonb_agg(jsonb_build_object('idx',l.idx,'marketId',m.id,'title',m.title,'venue',m.venue,'side',l.side,'quotedPrice',l.quoted_price::text,'result',l.result) ORDER BY l.idx) FILTER (WHERE l.idx IS NOT NULL),'[]'::jsonb) AS legs FROM solana_parlays p LEFT JOIN solana_parlay_legs l ON l.parlay_id=p.id LEFT JOIN markets m ON m.id=l.market_id WHERE p.user_id=$1 GROUP BY p.id ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
      [request.userId, limit, offset],
    );
    return reply.send({ parlays: result.rows, limit, offset });
  });

  app.post("/api/parlays", { preHandler: authenticate }, async (request, reply) => {
    const body = z.object({ token: z.string().min(32).max(8192) }).strict().safeParse(request.body);
    if (!body.success) return apiError(reply, 400, "invalid_request", "a signed quote token is required");
    const quote = verifyQuote(body.data.token, config.QUOTE_SECRET);
    if (!quote || quote.userId !== request.userId || Date.parse(quote.expiresAt) <= Date.now()) return apiError(reply, 409, "quote_expired", "quote is invalid, expired, or belongs to another account");
    try {
      const parlay = await withTx(pool, async (client) => {
        const account = await client.query<{ balance: string }>("SELECT balance::text AS balance FROM users WHERE id=$1 FOR UPDATE", [request.userId]);
        const balance = parseFixed(account.rows[0]?.balance ?? "0", 6)!; const stake = parseFixed(quote.stake, 6)!;
        if (balance < stake) throw Object.assign(new Error("insufficient virtual balance"), { code: "insufficient_balance" });
        const openMarkets = await client.query<{ id: string }>("SELECT id FROM markets WHERE id=ANY($1::text[]) AND status='open' AND is_combo=false AND close_time > now() FOR SHARE", [quote.legs.map((leg) => leg.marketId)]);
        if (openMarkets.rowCount !== quote.legs.length) throw Object.assign(new Error("one or more markets are no longer open"), { code: "market_unavailable" });
        const inserted = await client.query<{ id: string }>("INSERT INTO parlays (user_id,quote_nonce,stake,multiplier,quoted_payout) VALUES ($1,$2,$3,$4,$5) RETURNING id", [request.userId, quote.nonce, quote.stake, quote.multiplier, quote.payout]);
        const id = inserted.rows[0]!.id;
        for (const [idx, leg] of quote.legs.entries()) await client.query("INSERT INTO parlay_legs (parlay_id,idx,market_id,side,quoted_price,factor) VALUES ($1,$2,$3,$4,$5,$6)", [id, idx, leg.marketId, leg.side, leg.price, leg.factor]);
        await ledger.lockStake(client, { userId: request.userId!, amount: quote.stake, parlayId: id, quoteNonce: quote.nonce });
        return { id, status: "open", stake: quote.stake, multiplier: quote.multiplier, quotedPayout: quote.payout, createdAt: new Date().toISOString() };
      });
      return reply.code(201).send({ parlay });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "insufficient_balance") return apiError(reply, 402, "insufficient_balance", "virtual balance is insufficient");
      if (typeof error === "object" && error !== null && "code" in error && error.code === "market_unavailable") return apiError(reply, 409, "market_unavailable", "one or more markets are no longer open");
      if (isPgUniqueViolation(error)) return apiError(reply, 409, "quote_already_used", "this quote has already been accepted");
      throw error;
    }
  });

  app.get("/api/parlays", { preHandler: authenticate }, async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100_000).default(0) }).safeParse(request.query);
    if (!query.success) return apiError(reply, 400, "invalid_request", "invalid pagination parameters");
    const { limit, offset } = query.data;
    const result = await pool.query(`SELECT p.id,p.stake::text AS stake,p.multiplier::text AS multiplier,p.quoted_payout::text AS "quotedPayout",p.payout::text AS payout,p.status,p.created_at AS "createdAt",p.settled_at AS "settledAt",count(l.*)::int AS "legCount",COALESCE(jsonb_agg(jsonb_build_object('idx',l.idx,'marketId',m.id,'title',m.title,'rulesText',m.rules_text,'venue',m.venue,'side',l.side,'quotedPrice',l.quoted_price::text,'factor',l.factor::text,'result',l.result) ORDER BY l.idx) FILTER (WHERE l.idx IS NOT NULL),'[]'::jsonb) AS legs FROM parlays p LEFT JOIN parlay_legs l ON l.parlay_id=p.id LEFT JOIN markets m ON m.id=l.market_id WHERE p.user_id=$1 GROUP BY p.id ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`, [request.userId, limit, offset]);
    return reply.send({ parlays: result.rows, limit, offset });
  });

  app.get("/api/parlays/:id", { preHandler: authenticate }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return apiError(reply, 400, "invalid_request", "invalid parlay id");
    const result = await pool.query("SELECT id,stake::text AS stake,multiplier::text AS multiplier,quoted_payout::text AS \"quotedPayout\",payout::text AS payout,status,created_at AS \"createdAt\",settled_at AS \"settledAt\" FROM parlays WHERE id=$1 AND user_id=$2", [params.data.id, request.userId]);
    const row = result.rows[0]; if (!row) return apiError(reply, 404, "parlay_not_found", "parlay not found");
    const legs = await pool.query("SELECT l.idx,m.id AS \"marketId\",m.title,m.rules_text AS \"rulesText\",m.venue,l.side,l.quoted_price::text AS \"quotedPrice\",l.factor::text,l.result FROM parlay_legs l JOIN markets m ON m.id=l.market_id WHERE l.parlay_id=$1 ORDER BY l.idx", [params.data.id]);
    return reply.send({ parlay: { ...row, legs: legs.rows } });
  });

  return app;
}

function requestLogError(app: FastifyInstance, error: unknown): void {
  app.log.error({ err: error }, "health database check failed");
}

declare module "fastify" {
  interface FastifyInstance { pg: Pool }
}
