# Frontend and trading-data contract

**Reviewed:** 2026-10-02

## Current behavior

- `app/` routes render the shared client application in `components/market-app.tsx`.
- Market names, venue, close time, reported volume, category, rules, and source links come from the live Polymarket Gamma and Kalshi market catalogs through `/api/market-feed`.
- The market-feed response contains catalog metadata only. It does not expose last-trade prices as execution prices, infer a missing price as 50%, or fabricate a YES/NO price pair.
- The UI validates feed records, removes expired/malformed markets, refreshes every 30 seconds, and clears the visible catalog after a failed refresh.
- Outcome selection is a draft only. The UI does not calculate an estimated multiplier or return from catalog probabilities.
- Suggested parlays and leaderboard rankings are not connected to verified services and are not displayed.
- Solana portfolio values are Devnet test-token units. They are not dollars, USDC, or withdrawable value.

## Trading is not enabled

The frontend currently hard-codes authentication as unavailable, returns no access token, and exposes no Privy wallet. The quote and transaction handler therefore cannot run from the UI, and the place-quote control remains disabled. This is intentional fail-closed behavior until a real identity, wallet, quote, and transaction-confirmation journey is configured and verified.

The backend quote service can request fresh order books from venue adapters, issue a signed quote, and confirm a Devnet escrow transaction. The backend does not place orders on Kalshi or Polymarket. The Solana program uses a configured test mint on localnet/Devnet and is not a production custody contract. Do not describe the current app as live-money trading.

## Data and price rules

1. Catalog fields must be traceable to an upstream venue response. If an optional field is missing, show it as unavailable; do not invent a volume, price, close time, count, or market.
2. A catalog mark, last trade, or probability is not an executable quote. Display execution prices only from a fresh side-specific order book (`yes.ask` or `no.ask`) with source/fetch timestamps.
3. `/api/quote` must fetch and validate prices again when issuing the signed quote. Any quote shown in the slip must be discarded when a leg or stake changes or the quote expires.
4. Settlement and portfolio figures must come from confirmed backend/chain records. Label Devnet test-token units explicitly; never format them as dollars without a verified conversion source.
5. Public rankings require an approved privacy/display-name policy and an endpoint based on settled positions. Until then, show the unavailable state.
6. Authentication, deposits, withdrawals, and order placement must stay disabled unless their complete production contract is implemented and verified.

## Existing endpoints and responsibilities

| Flow | Current source | Important boundary |
|---|---|---|
| Market catalog | Next route `/api/market-feed` calling public venue catalogs | Listing metadata only; not an order book or trade confirmation. |
| Market quote | Backend `POST /api/quote` | Requires authenticated user, valid markets, fresh order books, and configured quote signing. |
| Solana confirmation | Backend `POST /api/solana/parlays/confirm` | Confirms a signed Devnet transaction against RPC evidence. |
| Portfolio | Backend `GET /api/solana/parlays` | Returns recorded on-chain test-token positions for an authenticated account. |
| Leaderboard | No endpoint | No rankings are shown. |
| Deposit/withdraw | No endpoint | Controls remain disabled and are not represented as available funds. |

## Verification gates before enabling the UI flow

- Configure and validate Privy against a real app ID, verification key, access token, and wallet-binding signature.
- Validate the quote API's user/session identity and that all selected market IDs resolve to the intended venue records.
- Verify side-specific fresh-book prices and quote expiry/tamper/account binding.
- Verify wallet chain, program ID, mint, token decimals, quote signer, and Devnet RPC against the on-chain configuration.
- Exercise transaction signing, confirmation, duplicate submission, RPC timeout, and rejected/expired quote paths.
- Confirm confirmed positions and settlements reconcile exactly with on-chain token units and backend records.
- Keep the controls disabled if any required service/configuration/verification step fails.

---

*This contract describes the current code, not a production readiness claim.*
