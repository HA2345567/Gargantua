# Gargantua implementation notes

## Decisions

- Keep the existing Next.js frontend package and the backend in a separate Node.js package under `backend/`. The original decision to leave the UI unchanged was superseded by the 2026-10-02 data-integrity audit.
- Money is stored as Postgres `numeric(18,6)` decimal strings. No real-money deposit, withdrawal, or venue-order path is included.
- User bearer tokens are generated randomly, returned at registration once, and stored only as SHA-256 hashes.
- Use Fastify, `@fastify/cors`, Zod, `pg`, TypeScript, and `tsx`. Reasons: Fastify is the required HTTP stack; CORS controls the frontend origin; Zod validates config and request bodies; `pg` is the required PostgreSQL driver; TypeScript/tsx support strict ESM development and node:test.
- Leaderboard data is not added to the backend until its public display-name, privacy/opt-out, and ranking contract is approved. No user email is exposed as a trader name.
- Portfolio aggregate values can be derived from account, parlay, and ledger responses initially; do not store a second computed balance.
- Operator equivalence groups are curated using a separate optional admin bearer secret; the normal user token cannot access the admin route.
- User direction supersedes the PRD's original Phase 2 deferral: Rust/Anchor Solana escrow is next after Phase 1 (B0–B6) acceptance. Keep it sequenced behind PostgreSQL 16 deployment acceptance; do not mix it into the virtual-USDC MVP acceptance.

## Frontend data-integrity audit (2026-10-02)

- Removed fabricated markets, suggested parlay prices/returns, leaderboard accounts/results, and the hard-coded `$0.00` header balance.
- Frontend market-feed data is catalog metadata only. UI selection does not show an executable price; the signed quote service must use a fresh side-specific venue order book.
- The frontend Privy provider is still disabled. The UI must keep quote acceptance and wallet actions unavailable until authentication, wallet signing, quote expiry, and transaction confirmation are verified end to end.
- Solana values represent Devnet test-token units, not fiat value. No deposit, withdrawal, mainnet custody, or venue order placement is implemented.

## Latest verification (2026-10-02)

- `pnpm build`: passed. Next.js emitted two remote `<img>` optimization warnings; no compile/type errors.
- Root `pnpm exec tsc --noEmit` and backend `npm run typecheck`: passed.
- Backend `npm test`: all 9 unit/integration tests passed, including PGlite/Postgres-wire route and settlement coverage.
- `npm run check:live-core`: passed against both live venue catalogs/books; signed quote, virtual acceptance, and admin metrics passed; 20-sample quote p95 was 455 ms. This is not an exchange order or a real-money trade.
- `npm run check:venues`: passed; both venues returned a catalog market and two-sided book.
- Production-build route smoke check: `/`, `/markets`, `/portfolio`, `/leaderboard`, and `/api/market-feed` returned HTTP 200; 100 valid future-closing catalog listings contained no price fields or former hard-coded catalog IDs (79 Polymarket and 100 Kalshi eligible source records during the final check).
- `npm run check:resolutions`: unable to complete because the current first 20 Kalshi settled records contained no finalized binary result. Parser unit tests passed; this live data-dependent check remains unverified for this run.
- Next.js frontend-to-wallet trade acceptance remains unverified and disabled because Privy/wallet integration is not configured. The Solana program remains a Devnet test-token scaffold.

## Verification state

- **B1–B6 source implemented.** `npm run build`, `npm run typecheck`, and `npm test` pass (9 tests), including operator equivalence-group curation, admin metrics, and an API integration run through `pg` over the PGlite PostgreSQL wire socket. The integration suite confirms all account, ledger, quote and parlay routes reject unauthenticated requests; simulates a Polymarket catalog outage and confirms Kalshi sync continues while `/health` reports degraded; and verifies portfolio list/detail per-leg titles, rules and outcomes plus HTTP 402 for insufficient balance. Quote tests reject tampering and cross-account acceptance. Settlement integration forces a stale conflicting resolution after the winning leg is committed and confirms it cannot overturn that result; it also verifies the final account balance exactly equals the sum of its ledger entries. The latest `npm run check:live-core` passed against live Kalshi and Polymarket data, including a signed quote, virtual acceptance, admin metrics, and a 20-sample quote p95 of 454 ms (under the 3-second target). `npm run check:resolutions` confirmed a live Kalshi finalized listing/detail match and a closed Polymarket UMA-final payout match. PostgreSQL 16/Docker deployment acceptance remains pending.
- This host has no `docker`, `psql` or native PostgreSQL executable. The integration test uses embedded PostgreSQL for schema/query/transaction coverage; it does not claim the PostgreSQL 16 container was run.
- `npm run check:venues` passed against live read-only sources: both adapters returned an eligible catalog item and a complete two-sided book.
- The production Kalshi excluded-combo market-list response had binary market fields and `mve_collection_ticker`/`mve_selected_legs`; the sampled current orderbook had an empty YES bid side. The adapter rejects incomplete books.
- Polymarket's sampled Gamma record had JSON-string `outcomes`, `clobTokenIds`, `conditionId`, and an `events` array. A live CLOB YES-token book had `asset_id`, market id, timestamp, bids and asks.

## VERIFIED resolution field behavior

- Kalshi's public settled list returned `status: finalized` / `result: no`, and the individual market detail returned the same values. The adapter maps these confirmed binary outcomes; unconfirmed result encodings (including `void`) stay pending.
- Polymarket's public Gamma response for closed market `3244610` has `closed: true`, `umaResolutionStatus: "resolved"`, binary Yes/No outcomes, and payout prices `[0, 1]`. The adapter requires a final UMA state (`resolved` or `settled`) as well as exact binary payout values (`1/0`, `0/1`, or `0.5/0.5` for unknown/50-50); `proposed`/`disputed` states and near-terminal prices remain pending. This matches Polymarket's documented resolution lifecycle and redemption values ([Resolution docs](https://docs.polymarket.com/concepts/resolution), [Gamma API schema](https://gamma-api.polymarket.com/docs)); the live adapter returned `no`.

## UNVERIFIED venue details

- Kalshi's cents-vs-dollar orderbook compatibility shape, auth edge cases when keys are configured, and settled void-result representation.
- Kalshi orderbook top-of-book behavior for a market with both YES and NO sides populated; the sample production book verified so far had an empty side, which the adapter rejects.
- Venue-specific event/category identifiers and production rate-limit response behavior.

Official documentation references reviewed for B2/B5:

- Kalshi API docs: <https://docs.kalshi.com/>
- Polymarket Gamma Markets API: <https://docs.polymarket.com/developers/gamma-markets-api/overview>
- Polymarket CLOB API: <https://docs.polymarket.com/developers/CLOB/introduction>

## Open operational limits

- Docker Compose targets PostgreSQL 16. Run PostgreSQL API acceptance checks where Docker/Postgres is available.
- The `.env.example` values are local-development examples only. Replace `QUOTE_SECRET` with a secure environment-provided secret; never commit a real `.env`.
- Registration currently accepts an unverified email. It is limited to 10 requests per IP and 5 per normalized email per minute; add verified identity and token rotation/revocation before public launch.
- Request limits are in-process memory and do not coordinate across backend replicas.
- Frequent catalog passes are capped and therefore do not mark omitted rows closed. A separate paginated full-snapshot job runs every 24 hours by default and only closes omitted rows after a successful complete venue fetch.
- P1 work still open: email verification and WebSocket books. WebSocket prices are also listed as a non-goal for the MVP; REST remains the quote-time source of truth.
- The admin metrics route reports in-process counters and rolling latency/lag samples; counters reset on restart. Settlement lag is counted only when a venue payload exposes a finality timestamp. The confirmed Kalshi `settlement_ts` supports this; the sampled Polymarket Gamma record did not expose `umaResolutionStatusTimestamp`, so no Polymarket lag sample is fabricated.
- The PGlite socket server is a development-only test dependency; production uses the standard `pg` pool and PostgreSQL service.
- The API integration test uses deterministic adapter fixtures; the separate live core check verifies real catalog/book parsing, quote creation, and virtual acceptance with disposable database state. Resolution parsing has unit coverage for final wins, 50/50 voids, near-terminal prices, and non-final markets.
