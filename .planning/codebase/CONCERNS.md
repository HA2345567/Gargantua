# Known Concerns

**Analysis Date:** 2026-10-02

## Integration Gaps

- The frontend Privy provider is intentionally a no-op and the UI reports sign-in as unavailable (`components/privy-provider.tsx`, `components/market-app.tsx`). Account, quote, and parlay actions requiring a bearer token cannot currently be exercised as a complete user journey from the UI.
- Frontend market discovery uses a Next route that calls venue APIs, while backend quote issuance uses its own venue adapters. These paths can diverge in filtering, freshness, or availability.
- Documentation in `docs/PLAN.md` and `docs/NOTES.md` describes the frontend as unconnected; current code has partial API calls. Reconcile docs against actual reachable user flows.
- The initial audit found hard-coded markets, suggested parlays, leaderboard rows, and a fixed balance in the UI. These were removed in the 2026-10-02 data-integrity pass; keep them out of production UI paths.

## Operational Risks

- PostgreSQL 16 deployment/acceptance is documented as pending; verify migrations and startup against the intended deployment database.
- Backend in-memory metrics and rate limits reset on restart and do not coordinate across multiple processes (`backend/README.md`).
- Email registration and verification behavior has not been validated end to end; token revocation and the leaderboard privacy/name contract are documented as deferred.
- No CI workflow or deployment pipeline was detected in the repository inventory.

## Solana and Custody

- The Anchor program is a localnet/devnet test-token scaffold, not production custody (`docs/solana-core.md`).
- Privy token integration has not been validated against a live configured app, and the current UI auth provider is disabled.
- Mainnet asset support, operational key controls, validator-backed acceptance, and independent security review remain outstanding.
- Venue-specific edge cases such as Kalshi void resolution encoding need continued validation against authoritative live behavior.

## Reliability and UX

- The market-feed route returns an error when both venue sources fail or produce no eligible markets; user-visible degraded/offline behavior needs validation.
- No browser end-to-end coverage was found, so route navigation, auth state, and transaction confirmation are not protected as a whole journey.
- Remote landing video availability depends on a CloudFront asset.

## Verification Priorities

1. Restore and validate a real frontend authentication flow, then walk registration/session through quote and parlay confirmation.
2. Run backend integration tests and migrations against the supported PostgreSQL version.
3. Exercise venue failure, stale data, and resolution edge cases with deterministic fixtures and live checks where appropriate.
4. Verify Solana acceptance on local validator/devnet and document the test-token boundary clearly.
5. Add automated browser and CI coverage for the supported user journey.

---

*Concerns analysis: 2026-10-02*
