# Gargantua backend plan

## Current milestone: B6 — hardening and acceptance

**Status:** B1–B6 source is implemented. Build, typecheck, all 9 unit/integration tests, embedded Postgres-wire API integration, operator market curation, capped catalog protection and full-snapshot reconciliation, live catalog/book checks, live signed-quote/virtual-acceptance, and live Kalshi/Polymarket resolution checks pass. PostgreSQL 16/Docker deployment acceptance remains pending.

### Implemented core flow

The backend implements account registration and virtual grants → catalog-backed market search and live-price endpoint → authenticated account-bound signed quote → transactional quote acceptance, balance debit and ledger entry → position reads → venue result polling and settlement. The Next.js UI now loads live catalog metadata, but frontend authentication and wallet signing are disabled; the quote/accept journey is therefore not end-to-end reachable from the UI.

The latest live core check sampled 20 consecutive quote requests; p95 was 454 ms, below the 3-second target, and verified admin metrics after live venue requests. The resolution check confirmed Kalshi finalized list/detail agreement and Polymarket's closed-market final payout mapping. Nightly (24-hour default) paginated full catalog reconciliation is implemented. Remaining deployment acceptance: run the documented PostgreSQL 16 compose flow on a Docker-enabled host and monitor Kalshi void-result behavior.

The user's latest direction starts Phase 2 before PostgreSQL 16 deployment acceptance. Phase 2 now has an Anchor SPL-token escrow scaffold and an optional backend quote-signing bridge. It remains localnet/devnet-only; Phase 1 Postgres deployment acceptance is still pending and remains a separate operational check.

## Milestone sequence

1. **B0 — Frontend contract:** complete; frontend data and API gaps documented.
2. **B1 — Foundation:** implemented; migrations and registration run through `pg` against embedded PostgreSQL.
3. **B2 — Real market data:** adapters/catalog/routes implemented; live read-only catalog and two-sided price checks pass; combos excluded.
4. **B3 — Core quote engine:** implemented with integer fixed-point arithmetic and HMAC-signed expiring quotes.
5. **B4 — Parlays and ledger:** implemented with balance row locks and atomic writes.
6. **B5 — Settlement:** implemented with idempotent wins, losses and void refunds plus source payload audit; live Kalshi finalized list/detail and Polymarket UMA-final Gamma payout mappings were verified. Unconfirmed Kalshi result encodings remain pending.
7. **B6 — Hardening:** operational runbook, stable errors, redacted auth logging, per-process request limits and admin-protected metrics added; PostgreSQL 16 deployment acceptance remains pending.
8. **S1 — Solana escrow scaffold:** Anchor program for signed quote acceptance, PDA token vaults and threshold settlement; backend produces contract-compatible signed quote packets when explicitly requested. Compilation is verified offline. Local-validator deployment, client transaction assembly, on-chain tests, security audit and production controls remain outstanding; see `docs/solana-core.md`.

## B0 decisions applied

- Backend is isolated under `backend/`.
- MVP balance controls stay virtual; no real-money routes are added.
- Price requests are lazy and quote-time pricing is always refetched.
- Operator equivalence-group curation is available through a separate `ADMIN_API_TOKEN` protected route. Leaderboard backend support is deferred: no public-name/privacy contract was approved. The frontend hides rankings until verified data and a privacy contract exist.
- Portfolio display aggregates can be derived from account, parlay, and ledger APIs.

The current repository is a Next.js frontend. The isolated `backend/` package has separate dependencies, scripts, environment example, SQL and Docker Compose configuration. Shared implementation and integration notes are under `docs/`.

## Frontend data-integrity audit (2026-10-02)

- Removed the local sample market catalog, hard-coded suggested parlays, fabricated leaderboard rows, and fixed `$0.00` header balance.
- The frontend catalog now contains metadata only. It does not display catalog marks as executable prices or calculate a return from them.
- Devnet escrow balances/positions are displayed in test-token units, not dollars. Trading remains disabled until authenticated wallet and quote flows are configured and verified.
