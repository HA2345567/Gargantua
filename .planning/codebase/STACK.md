# Technology Stack

**Analysis Date:** 2026-10-02

## Languages

**Primary:**
- TypeScript for the Next.js UI, backend API, integrations, and tests (`app/`, `components/`, `lib/`, `backend/src/`, `backend/tests/`).

**Secondary:**
- Rust 2021 for the Anchor escrow program (`programs/gargantua-escrow/src/lib.rs`).
- SQL for PostgreSQL schema and migrations (`backend/sql/`).

## Runtime

**Environment:**
- Next.js 15.5 / React 19 in the root application (`package.json`).
- Node.js 22 or newer for the backend (`backend/package.json`).
- Solana SBF/Anchor toolchain for on-chain builds; the Anchor project pins 0.30.1 (`Anchor.toml`).

**Package Managers:**
- pnpm at the root (`pnpm-lock.yaml`).
- npm in the independent backend package (`backend/package-lock.json`).
- Cargo for the Rust workspace (`Cargo.lock`).

## Frameworks

**Core:**
- Next.js App Router and React for the UI (`app/`, `components/`).
- Fastify 5, Zod, and `pg` for the backend (`backend/src/server.ts`, `backend/src/config.ts`).
- Anchor 0.30.1 and Anchor SPL for the escrow program (`programs/gargantua-escrow/Cargo.toml`).

**Testing:**
- Node's built-in `node:test` runner for backend unit and API integration tests (`backend/tests/`).
- PGlite with a PostgreSQL wire socket for database-backed tests (`backend/tests/integration.test.ts`).
- No frontend test runner or frontend tests were detected.

**Build/Dev:**
- Next build and ESLint scripts are defined in the root `package.json`.
- Backend TypeScript build, typecheck, dev, migration, and live-check scripts are in `backend/package.json`.
- Cargo is configured for an Anchor workspace (`Cargo.toml`, `Anchor.toml`).

## Key Dependencies

**Critical:**
- `next`, `react`, `@privy-io/react-auth`, and Solana web3/SPL packages support the UI (`package.json`).
- `fastify`, `pg`, and `zod` implement and validate the backend (`backend/package.json`).
- `anchor-lang` and `anchor-spl` implement the escrow program (`programs/gargantua-escrow/Cargo.toml`).

**Infrastructure:**
- PostgreSQL 16 is the documented production database target (`backend/docker-compose.yml`, `backend/README.md`).
- PGlite is a development/test-only embedded database (`backend/package.json`).

## Configuration

**Environment:**
- Backend configuration is parsed and cross-validated in `backend/src/config.ts`; variable names include `DATABASE_URL`, `QUOTE_SECRET`, `CORS_ORIGIN`, optional `PRIVY_*`, and optional `SOLANA_*` settings.
- A root `.env.example` exists. Secret-bearing environment files were not read.

**Build:**
- Root TypeScript aliases `@/*` to the project root (`tsconfig.json`).
- Backend uses strict NodeNext ESM compilation (`backend/tsconfig.json`).
- Next and ESLint configuration live in `next.config.mjs` and `eslint.config.mjs`.

## Platform Requirements

**Development:**
- Node.js 22+ for backend workflows; the root frontend has no pinned Node version in its manifest.
- Docker Compose with PostgreSQL 16 for documented backend deployment acceptance.
- Anchor CLI 0.30.1, Solana CLI, and a local validator for on-chain deployment and acceptance.

**Production:**
- Backend expects PostgreSQL and external venue APIs. The escrow design is explicitly localnet/devnet-only and is not production custody (`docs/solana-core.md`).

---

*Stack analysis: 2026-10-02*
