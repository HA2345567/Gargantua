# External Integrations

**Analysis Date:** 2026-10-02

## APIs & External Services

**Prediction-market data:**
- Polymarket Gamma supplies market metadata and resolution data; the backend adapter and Next route also use Polymarket's CLOB orderbook API (`backend/src/venues/polymarket.ts`, `app/api/market-feed/route.ts`).
- Kalshi supplies market metadata, books, and finalized resolution data (`backend/src/venues/kalshi.ts`).
- Venue HTTP calls are paced and bounded by timeouts (`backend/src/venues/http.ts`, `app/api/market-feed/route.ts`).

**Authentication:**
- Optional Privy bearer-token verification uses ES256 claims and a wallet-binding signature (`backend/src/auth/privy.ts`, `backend/src/auth/solana-wallet.ts`).
- The current frontend provider is deliberately a no-op (`components/privy-provider.tsx`); the UI currently reports sign-in as unavailable (`components/market-app.tsx`).
- A local prototype registration route is available when Privy is not configured (`backend/src/server.ts`).

**Blockchain:**
- Solana RPC is used by the wallet client and backend confirmation path; the default is Devnet (`components/market-app.tsx`, `backend/src/config.ts`).
- Anchor escrow uses SPL tokens and a test mint, with quote signatures and threshold settlement signers (`programs/gargantua-escrow/src/lib.rs`, `docs/solana-core.md`).

**Media:**
- The landing page loads a hero video from CloudFront (`app/page.tsx`).

## Data Storage

**Databases:**
- PostgreSQL stores accounts, markets, virtual balances, parlays, ledger entries, sync state, and optional Solana positions (`backend/sql/001_init.sql`, `backend/sql/002_privy_solana.sql`).
- The backend uses the standard `pg` pool in production (`backend/src/db/pool.ts`).
- PGlite and its socket adapter provide disposable test database state (`backend/tests/integration.test.ts`).

**File Storage:**
- Static images are served from `public/`; no remote file-storage integration was detected.

**Caching:**
- Next market-feed responses use a 15-second revalidation window (`app/api/market-feed/route.ts`).
- Backend market prices use an in-process cache (`backend/src/services/prices.ts`).

## Authentication & Identity

- Backend prototype bearer tokens are random and persisted as SHA-256 hashes (`backend/src/auth/token.ts`).
- Privy identity is optional; production configuration requires the Privy app ID and verification key (`backend/src/config.ts`).
- Solana identity is wallet-bound to the verified Privy DID before chain positions are exposed (`backend/src/server.ts`).

## Monitoring and Observability

- Fastify exposes `/health` and admin-protected metrics (`backend/src/server.ts`, `backend/src/services/metrics.ts`).
- Metrics and rate limits are process-local and reset on restart (`backend/README.md`).
- No external error tracking or centralized log service was detected.

## CI/CD and Deployment

- Docker Compose describes the PostgreSQL 16 service (`backend/docker-compose.yml`).
- No CI workflow or deployment pipeline was detected in the repository inventory.

## Environment Configuration

**Required backend variables:**
- `DATABASE_URL`, `QUOTE_SECRET`, and `CORS_ORIGIN` are required by `backend/src/config.ts`.
- `PRIVY_APP_ID` and `PRIVY_VERIFICATION_KEY` must be configured together for Privy mode.
- `SOLANA_PROGRAM_ID`, `SOLANA_ESCROW_MINT`, and `SOLANA_QUOTE_SIGNER_PRIVATE_KEY_PEM` enable the optional on-chain quote response.
- Kalshi credentials and admin token are optional; only variable names were inspected, never secret values.

**Secrets location:**
- Local development values are documented through `.env.example` and `backend/README.md`; production secrets should be provided outside source control.

## Webhooks and Callbacks

**Incoming:**
- No webhook receiver was detected. The backend polls venue APIs for catalog and resolution state.

**Outgoing:**
- No application webhook sender was detected.

---

*Integration audit: 2026-10-02*
