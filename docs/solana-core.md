# Solana escrow core (Phase 2)

This milestone introduces an Anchor SPL-token escrow program, Privy authentication, wallet-bound quotes, transaction confirmation, and a threshold-signer settlement worker. It is localnet/devnet infrastructure only. Configure a freshly minted test token as the escrow mint; the program is not connected to USDC, mainnet liquidity, exchange custody, or production settlement.

## Program flow

1. Initialize the config PDA once with the escrow mint, Ed25519 quote-service public key, settlement signer set, and M-of-N threshold. The config PDA owns the house token vault.
2. Request `POST /api/quote` as usual, adding `solanaOwner` with the user's base58 wallet public key. When all three `SOLANA_*` settings are present, the response includes `solanaQuote` with the program, mint, wallet, quote signer, nonce, token-unit amounts, expiry, legs hash, digest, and Ed25519 signature.
3. The wallet client prepends a Solana Ed25519 precompile instruction that verifies the signature over the 32-byte digest, then submits `accept_parlay` with the nonce, stake, payout cap, expiry and legs hash. The contract independently rebuilds that digest, checks that the immediately preceding instruction is the configured signer and digest, and transfers the user's SPL test-token stake into a per-parlay PDA ATA.
4. The backend settlement worker polls the configured venue resolution adapters and an M-of-N set of configured settlement keys invokes `settle_parlay`. Loss routes escrowed stake to the house vault; win routes the signed gross payout to the owner (with house top-up if needed); a voided leg voids the whole parlay and returns stake. The per-parlay vault closes after settlement.

Privy mode requires `PRIVY_APP_ID` and `PRIVY_VERIFICATION_KEY`. The client sends the Privy access token as a bearer token and proves control of its Solana wallet by signing the wallet-binding message. The backend verifies the token's signature and claims before it maps the DID to a wallet account. The dashboard verification key format must match the verifier's accepted PEM or raw P-256 point format; this flow has not yet been validated against a live Privy app token.

The quote signature commits to `SHA256(JSON.stringify(quote.legs))`, where the API emits legs in quote order. Nonce is `SHA256(UTF8(quote.nonce))`. Stake and payout are integer token base units using six decimals; expiry is the quote ISO timestamp floored to Unix seconds. The digest is SHA-256 over the byte concatenation documented in `programs/gargantua-escrow/src/lib.rs` (`quote_digest`). These encodings are protocol; changing them requires a coordinated program and backend version.

## Configuration

Set these backend environment variables together to enable the optional response field:

- `SOLANA_PROGRAM_ID`: deployed program public key.
- `SOLANA_ESCROW_MINT`: six-decimal localnet/devnet test mint configured in the program.
- `SOLANA_QUOTE_SIGNER_PRIVATE_KEY_PEM`: Ed25519 PKCS#8 PEM whose raw public key equals the on-chain config's `quote_signer`. Keep it in a secret manager outside local development.

The existing `POST /api/parlays` remains the prototype's virtual-balance route. The Solana path uses `POST /api/solana/parlays/confirm` after the user wallet signs and sends the transaction, and `GET /api/solana/parlays` to list chain positions. Never accept both virtual and on-chain stake for one quote.

## Build and local deployment

The workspace root contains `Anchor.toml` and `Cargo.toml`; the program is `programs/gargantua-escrow`. Offline Rust compilation is available with `cargo check --offline -p gargantua-escrow`. Deployment and local validator acceptance require Solana CLI, Anchor CLI 0.30.1, and a local validator; those CLIs were not present on the implementation host. Use a disposable keypair and test mint only. Do not deploy this scaffold to mainnet.

Before any production consideration, validate Privy key parsing against the actual dashboard key/token, add live local-validator coverage for valid/invalid signatures and all terminal outcomes, replay and concurrent-settlement checks, authority rotation/emergency pause controls, settlement-evidence binding, rent/ATA edge cases, explicit signer separation, a mainnet token policy, and independent smart-contract/security review. The current program is a development scaffold, not an audited custody contract. Deployment remains outstanding until a deployer keypair, configured Privy app, funded devnet wallet, escrow mint, and local Anchor/Solana CLIs are available.
