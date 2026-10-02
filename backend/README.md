# Gargantua backend

Independent Fastify API for the existing Next.js client. It does not import or modify frontend code. The only balance is virtual USDC; this service never places venue orders or transfers money.

## Local startup

Requirements: Node.js 22+ and Docker Compose with PostgreSQL 16 for local service startup. The test suite uses embedded Postgres through the real `pg` wire driver and does not require Docker.

1. From this directory, run `docker compose up -d postgres`.
2. Copy `.env.example` to `.env`. Set `QUOTE_SECRET` to at least 32 random characters and keep `.env` private. For Privy mode, set `PRIVY_APP_ID` and the matching ES256 verification key from the Privy dashboard; production refuses to start without both. Set a separate `ADMIN_API_TOKEN` to enable operator curation. Add Kalshi API credentials only if authenticated market reads are required.
3. Run `npm install`, `npm run migrate`, then `npm run dev`.
4. The API listens on `http://127.0.0.1:4000`; `GET /health` reports database, catalog and settlement state.

`npm run build`, `npm run typecheck`, and `npm test` are the local verification commands. `npm start` runs the compiled `dist/index.js` and expects the SQL directory under the backend working directory.

`npm run check:venues` makes read-only requests to both live venue APIs and reports catalog/book availability without database writes. It can use Kalshi credentials from environment variables, but does not print them.

`npm run check:resolutions` makes read-only requests for a finalized Kalshi market and a closed Polymarket market with definitive payout values, then confirms the venue adapters return the same outcomes. This exercises only the resolution adapters; it writes no database state.

`npm run check:live-core` uses disposable embedded Postgres, syncs real venue catalogs, loads fresh live books through the API and exercises a signed cross-venue quote, virtual acceptance, and admin metrics. It makes only read-only venue requests; database state is ephemeral. It reports a 20-sample quote latency p95 (454 ms on the latest run).

## API

- `POST /api/auth/register` is available only when Privy is not configured. It creates a local prototype account and bearer token; never expose it as production identity.
- In Privy mode a configured client must obtain a Privy access token and send it as `Authorization: Bearer <token>`. `POST /api/auth/session` additionally requires a wallet signature over `TOTALIS_PRIVY_WALLET_BIND_V1|<privy-did>|<solana-address>` and links the verified DID to that wallet. `GET /api/me` and `GET /api/ledger` use the same Privy bearer token. The current Next.js Privy provider is disabled, so this frontend-to-backend authentication path is not yet reachable through the UI.
- `GET /api/markets?q=&venue=&limit=&offset=` lists open binary non-combo market metadata. Prices are deliberately absent.
- `GET /api/markets/:id/price` returns fresh two-sided YES/NO books. It returns `503 price_unavailable` if either side is missing, stale or invalid.
- `PUT /api/admin/markets/:id/equivalence-group` accepts `{ "equivalenceGroup": "group-key" }` or `null`. It requires the separate `ADMIN_API_TOKEN` bearer token; repeat it for every market in a curated group. Catalog refresh preserves curation.
- `GET /api/admin/metrics` requires the same admin token and reports quote counts/latency, stale-price refusals, per-venue HTTP errors and client pacing waits, settlement lag samples, and parlay counts by status. Metrics are in-process and reset on restart; settlement lag is recorded only when a venue payload supplies a finality timestamp.
- `POST /api/quote` (authenticated) accepts `{ "stake": "10", "legs": [{ "marketId": "...", "side": "YES" }, ...] }`; 2–5 distinct events are required. It returns `{ quote, token, titles, expiresInMs }`.
- `POST /api/parlays` (authenticated) accepts `{ "token": "..." }`. Acceptance checks expiry/account binding, locks the balance, writes the parlay and legs, debits the virtual balance and records the stake in one transaction; insufficient virtual balance returns `402 insufficient_balance`.
- `GET /api/parlays` and `GET /api/parlays/:id` return the authenticated account's positions with per-leg market titles, source rules, side, quoted price, factor and result.
- With the Solana program, mint and quote signer configured, `POST /api/quote` also returns a signed on-chain quote for `solanaOwner`. The wallet submits `accept_parlay` itself; `POST /api/solana/parlays/confirm` verifies confirmed RPC evidence and records it idempotently; `GET /api/solana/parlays` lists that account's chain positions.

API errors use `{ "error": { "code": "...", "message": "...", "details": {} } }`. Monetary and price fields are decimal strings; backend arithmetic uses integer fixed-point values.

## Operations and limits

- Catalog synchronization runs a bounded frequent pass (`CATALOG_MAX_MARKETS`) and a full paginated reconciliation every `CATALOG_FULL_SYNC_INTERVAL_MS` (default 24 hours). A capped pass never closes markets merely omitted beyond the cap; a full pass closes stale rows only after the venue fetch completes successfully. Venue failures remain isolated and curated `equivalence_group` values are preserved.
- Quote-time prices are freshly fetched; the visible-price cache is short lived and bounded.
- Settlement records source payload evidence and makes parlay/ledger/balance writes transactionally idempotent. Unknown outcomes remain pending.
- `/health` reports unresolved legs past `SETTLEMENT_ALERT_DAYS` (default 3) for operator review.
- Rate limits in this MVP are per-process memory; use an edge/API gateway and shared limiter before horizontal scaling.
- In development without Privy configuration the legacy unverified email flow remains enabled. Privy sessions still require production review of key rotation, revocation policy, abuse controls and deployment secrets before public launch.
- Deposit, withdrawal, leaderboard, and venue order placement are intentionally outside this backend contract.
