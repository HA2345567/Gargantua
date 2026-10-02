<!-- refreshed: 2026-10-02 -->
# Architecture

**Analysis Date:** 2026-10-02

## System Overview

```text
Browser
  ├── Next.js App Router pages: /, /markets, /portfolio, /leaderboard
  │      ├── MarketApp UI → Next route /api/market-feed → Polymarket + Kalshi
  │      └── portfolio / quote / Solana confirmation → backend Fastify API
  └── Wallet signs a Solana transaction
          ↓
Backend services → PostgreSQL / venue adapters / Solana RPC
          ↓
Anchor SPL-token escrow program (localnet/devnet scaffold)
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Next route pages | Render the landing page or shared market application | `app/page.tsx`, `app/markets/page.tsx`, `app/portfolio/page.tsx`, `app/leaderboard/page.tsx` |
| Market UI | Market browsing, parlay slip, portfolio and wallet transaction flow | `components/market-app.tsx` |
| Market feed route | Fetch, normalize, and cache Polymarket and Kalshi market cards | `app/api/market-feed/route.ts` |
| Backend API | Auth, market catalog and prices, quote issuance, ledger, parlay and Solana endpoints | `backend/src/server.ts` |
| Venue adapters | Normalize market books and resolution payloads | `backend/src/venues/` |
| Backend services | Catalog synchronization, pricing, quote, settlement, ledger and metrics | `backend/src/services/` |
| Escrow program | Verify signed quote acceptance and settle SPL-token vaults | `programs/gargantua-escrow/src/lib.rs` |

## Pattern Overview

**Overall:** A Next.js presentation layer, an independently packaged Fastify backend, and a separate Anchor program.

**Key Characteristics:**
- Root and backend have separate dependency manifests and lockfiles.
- Backend service functions accept pool/adapters as inputs; routes compose these with auth and rate-limit hooks.
- Venue integrations implement the `VenueAdapter` contract in `backend/src/venues/adapter.ts`.
- PostgreSQL migrations and program code are separately versioned under `backend/sql/` and `programs/`.

## Layers

**Presentation:**
- Purpose: Render user-facing screens and manage local UI state.
- Location: `app/`, `components/`, and `lib/`.
- Depends on: Next.js route handlers, browser fetch, wallet APIs, and optional backend endpoints.

**Backend HTTP and domain:**
- Purpose: Validate requests, authorize users, quote trades, persist state, and reconcile outcomes.
- Location: `backend/src/server.ts`, `backend/src/core/`, `backend/src/services/`, and `backend/src/auth/`.
- Depends on: PostgreSQL pool and venue/chain interfaces.

**Persistence and external adapters:**
- Purpose: Store account/market/ledger records and translate external venue/RPC protocols.
- Location: `backend/sql/`, `backend/src/db/`, and `backend/src/venues/`.

**On-chain:**
- Purpose: Enforce quote-signature acceptance and threshold settlement for test-token escrow.
- Location: `programs/gargantua-escrow/src/lib.rs`.
- Depends on: Anchor, SPL Token, configured signer accounts, and Devnet/localnet RPC.

## Data Flow

### Market discovery

1. `MarketApp` requests `/api/market-feed` (`components/market-app.tsx`).
2. `app/api/market-feed/route.ts` fetches both venues, normalizes eligible markets, and returns a 15-second cached payload.
3. If both sources fail or have no eligible markets, the route returns a 502 response.

### Backend quote and virtual parlay

1. The UI requests a fresh quote from `POST /api/quote` with the user's bearer token (`components/market-app.tsx`).
2. `backend/src/server.ts` authenticates the user and requests fresh prices through `backend/src/services/prices.ts` and venue adapters.
3. Quote arithmetic and signed quote tokens are implemented in `backend/src/core/parlay.ts` and `backend/src/services/quote-token.ts`.
4. `POST /api/parlays` accepts the signed token and persists stake, position, and ledger changes transactionally.

### Solana escrow

1. An optional signed quote is returned when the program, mint, and signer are configured.
2. The client assembles and submits `accept_parlay`; the confirmation route verifies RPC transaction evidence before recording the position.
3. Settlement polls venue resolutions, then threshold signers call the Anchor program.
4. The current UI auth provider is disabled, so this end-to-end user path is not presently reachable from the frontend.

## Key Abstractions

**VenueAdapter:**
- Purpose: Provide a shared catalog, orderbook, and resolution interface.
- Examples: `backend/src/venues/kalshi.ts`, `backend/src/venues/polymarket.ts`.
- Pattern: Inject adapter instances into `buildServer` and settlement/catalog services.

**QuoteProvider:**
- Purpose: Separate quote generation from route orchestration.
- Examples: `backend/src/services/quote-provider.ts`, `backend/src/core/parlay.ts`.

**Database migrations:**
- Purpose: Apply versioned schema changes to PostgreSQL.
- Examples: `backend/sql/001_init.sql`, `backend/sql/002_privy_solana.sql`.

## Entry Points

**Next.js:**
- Location: `app/page.tsx` and route pages under `app/`.
- Triggers: Browser navigation; market data also enters through `app/api/market-feed/route.ts`.

**Backend:**
- Location: `backend/src/index.ts` starts the configured service; `backend/src/server.ts` builds routes.
- Triggers: `npm run dev` or `npm start` in `backend/`.

**Anchor:**
- Location: `programs/gargantua-escrow/src/lib.rs`.
- Triggers: Solana instruction dispatch for `initialize_config`, `accept_parlay`, and `settle_parlay`.

## Architectural Constraints

- PostgreSQL decimal values are passed as strings; arithmetic uses integer fixed-point helpers (`backend/src/core/parlay.ts`).
- Venue prices are refreshed for quote issuance; displayed market feed and backend quote services are separate paths.
- The escrow flow is test-token localnet/devnet only (`docs/solana-core.md`).
- No shared frontend/backend package or common generated API schema was detected.
- No circular dependency chain was detected during this mapping pass.

## Anti-Patterns

### Treating catalog metadata as a live quote

**What happens:** The live route supplies market catalog metadata; it does not provide executable order-book prices or an accepted quote.
**Why it's wrong:** A catalog mark or last trade can be stale, and using it to show stake cost or payout would misrepresent execution.
**Do this instead:** Keep the catalog price-free in the UI and show price/payout only after a fresh signed quote. Fail closed when the quote service, identity, or wallet is unavailable.

---

*Architecture analysis: 2026-10-02*
