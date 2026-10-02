# Code Conventions

**Analysis Date:** 2026-10-02

## Language and Formatting

- TypeScript is used in the frontend and backend; backend modules use ESM imports and NodeNext resolution.
- Root TypeScript runs in strict mode and uses the `@/*` alias for project-root imports (`tsconfig.json`).
- Backend TypeScript also enables strict checking (`backend/tsconfig.json`).
- Rust follows the Anchor 0.30.1 workspace conventions and edition 2021 (`Cargo.toml`, `Anchor.toml`).
- No repository-wide formatter configuration was found during this pass.

## Naming

- Next.js route entries are named `page.tsx`; route handlers use `route.ts` (`app/`).
- TypeScript module filenames are generally kebab-case (`backend/src/services/quote-token.ts`).
- Backend tests use descriptive `.test.ts` files in `backend/tests/`.
- SQL migrations use an ordered numeric prefix and a short snake_case description (`backend/sql/001_init.sql`).
- Domain types and interfaces use PascalCase; functions and variables use camelCase.

## TypeScript Patterns

- Validate external request data with Zod schemas before domain operations (`backend/src/`).
- Use integer/fixed-point arithmetic for money-like values; PostgreSQL numerics are represented as strings (`backend/src/core/parlay.ts`).
- Keep route composition in `server.ts` and domain behavior in core/services modules where practical.
- Inject venue adapters and database pools into services to support deterministic tests.
- Avoid using demo data as authoritative live pricing; market feed and demo fixtures have separate sources.

## Error Handling

- Fastify handlers return structured status responses and use shared validation/auth hooks.
- Venue requests are bounded by timeout and response validation (`backend/src/venues/http.ts`).
- Missing or invalid backend configuration is rejected during startup (`backend/src/config.ts`).
- Client fetch paths should handle non-2xx responses explicitly; inspect current UI auth limitations before extending account flows.

## Configuration and Security

- Read configuration through the backend config module rather than directly scattering environment reads.
- Keep secrets in environment configuration; `.env.example` is the template and was not read for secret values.
- Privy and Solana settings are optional integrations with cross-field validation.
- Never log bearer tokens, private keys, or full authorization headers.

## Database Changes

- Add schema changes as a new ordered migration under `backend/sql/`.
- Preserve transactional boundaries around balance, position, and ledger updates.
- Keep fixed-precision amounts exact across API, database, and quote-token boundaries.

---

*Conventions analysis: 2026-10-02*
