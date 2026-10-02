# Codebase Structure

**Analysis Date:** 2026-10-02

## Directory Layout

```text
Gogo/
├── app/                 # Next.js App Router pages, layout, styles, and API route
├── components/          # Shared UI and market application
├── lib/                 # Shared UI helpers, demo market data, Solana tx builder
├── public/              # Static logos and images
├── backend/             # Independent Fastify service, SQL, scripts, and tests
├── programs/            # Anchor/Solana workspace; escrow program source
├── docs/                # Frontend contract, implementation notes, and milestones
├── Cargo.toml           # Rust workspace configuration
└── package.json         # Next.js app package and root scripts
```

## Directory Purposes

**`app/`:**
- Purpose: Next.js App Router pages and server route handlers.
- Key files: `app/page.tsx`, `app/markets/page.tsx`, `app/api/market-feed/route.ts`.

**`components/`:**
- Purpose: Client UI and reusable controls.
- Key files: `components/market-app.tsx`, `components/privy-provider.tsx`, `components/ui/button.tsx`.

**`lib/`:**
- Purpose: Shared types, demo data, class helper, and Solana transaction assembly.
- Key files: `lib/markets.ts`, `lib/utils.ts`, `lib/solana-transaction.ts`.

**`backend/`:**
- Purpose: Independent API package, database, integrations, and checks.
- Key files: `backend/src/index.ts`, `backend/src/server.ts`, `backend/sql/`, `backend/tests/`.

**`programs/gargantua-escrow/`:**
- Purpose: Anchor program for test-token parlay escrow (`programs/gargantua-escrow/src/lib.rs`).

**`docs/`:**
- Purpose: Implementation plans and integration contracts.
- Key files: `docs/PLAN.md`, `docs/NOTES.md`, `docs/frontend-contract.md`, `docs/solana-core.md`.

## Key File Locations

**Entry Points:**
- `app/page.tsx`: landing page.
- `backend/src/index.ts`: API process startup.
- `programs/gargantua-escrow/src/lib.rs`: on-chain instruction handlers.

**Configuration:**
- `package.json`, `tsconfig.json`, `next.config.mjs`, `eslint.config.mjs`: frontend configuration.
- `backend/package.json`, `backend/tsconfig.json`, `backend/src/config.ts`: backend configuration.
- `Anchor.toml`, `Cargo.toml`, `programs/gargantua-escrow/Cargo.toml`: Solana program configuration.

**Core Logic:**
- `components/market-app.tsx`: UI state and user actions.
- `backend/src/core/parlay.ts`: quote arithmetic.
- `backend/src/services/`: persistence-facing domain operations.
- `backend/src/venues/`: venue adapter implementations.

**Testing:**
- `backend/tests/core.test.ts`, `backend/tests/foundation.test.ts`, `backend/tests/integration.test.ts`.
- No root-level frontend test folder or runner was found.

## Naming Conventions

**Files:**
- Next pages use `page.tsx`; backend modules use kebab-case names such as `quote-token.ts`.
- SQL migrations are numeric-prefixed (`001_init.sql`, `002_privy_solana.sql`).

**Directories:**
- Backend domain modules group under `auth/`, `core/`, `db/`, `services/`, `solana/`, and `venues/`.

## Where to Add New Code

**New UI route or screen:**
- Page entry: `app/<route>/page.tsx`; reusable screen elements: `components/`.
- Shared view models or helpers: `lib/`.

**New API or backend behavior:**
- Route and auth orchestration: `backend/src/server.ts`.
- Domain logic: `backend/src/core/` or `backend/src/services/`.
- External venue behavior: implement `backend/src/venues/adapter.ts` in `backend/src/venues/`.
- Database changes: add a new ordered migration under `backend/sql/`.

**Tests:**
- Add backend tests under `backend/tests/`; use the root package only for UI/build tooling.

## Special Directories

**`.next/`, `node_modules/`, `backend/node_modules/`, and `target/`:**
- Generated build/dependency output; do not add hand-maintained source there.

**`public/`:**
- Static image assets served by Next.js; not code-generated during normal app builds.

---

*Structure analysis: 2026-10-02*
