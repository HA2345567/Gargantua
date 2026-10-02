# Testing

**Analysis Date:** 2026-10-02

## Test Framework

**Backend:** Node.js built-in `node:test` with TypeScript execution through `tsx` (`backend/package.json`).
- Test files: `backend/tests/*.test.ts`.
- Integration database: PGlite plus a PostgreSQL wire socket (`backend/tests/integration.test.ts`).
- Current suite contains nine tests according to package/workflow inspection.

**Frontend:** No frontend test runner or frontend test files were detected.

**On-chain:** Anchor tests/tooling are configured in the workspace, but no successful validator-backed acceptance run was observed during this mapping pass.

## Running Tests

```bash
cd backend
npm test
```

Backend type checking and build are available separately:

```bash
cd backend
npm run typecheck
npm run build
```

The root package exposes lint and production build scripts:

```bash
pnpm lint
pnpm build
```

## Coverage Areas

- Core quote arithmetic, fixed-point values, and signed quote validation (`backend/tests/core.test.ts`).
- Configuration validation, authentication tokens, and foundational utilities (`backend/tests/foundation.test.ts`).
- API behavior with a temporary embedded PostgreSQL-compatible database (`backend/tests/integration.test.ts`).
- Venue market normalization, book handling, and resolution behavior in backend tests.

## Test Conventions

- Use `node:test` and strict assertions for backend tests.
- Prefer isolated temporary database state for integration coverage; do not depend on a developer's live database.
- Inject adapters and services to make failure cases deterministic.
- Keep test credentials and signing material synthetic; do not copy production secrets into fixtures.
- For schema changes, exercise migrations and transaction behavior through integration coverage.

## Gaps

- No browser-level end-to-end tests were detected.
- No frontend component test setup was detected.
- No CI workflow was found to run builds or backend tests automatically.
- Solana transaction submission and settlement still require local-validator or devnet verification beyond unit tests.
- Live venue checks depend on external services and should be distinguished from deterministic tests.

---

*Testing analysis: 2026-10-02*
