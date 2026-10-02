ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privy_did text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS solana_address text;
CREATE UNIQUE INDEX IF NOT EXISTS users_privy_did_uidx ON users(privy_did) WHERE privy_did IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_solana_address_uidx ON users(solana_address) WHERE solana_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS solana_parlays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  wallet_address text NOT NULL,
  quote_nonce uuid NOT NULL UNIQUE,
  program_id text NOT NULL,
  mint text NOT NULL,
  parlay_address text NOT NULL UNIQUE,
  accept_signature text NOT NULL UNIQUE,
  stake numeric(18,6) NOT NULL CHECK (stake > 0),
  multiplier numeric(24,12) NOT NULL CHECK (multiplier > 0),
  quoted_payout numeric(18,6) NOT NULL CHECK (quoted_payout >= 0),
  payout numeric(18,6),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','void')),
  settlement_signature text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS solana_parlays_user_created_idx ON solana_parlays(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS solana_parlay_legs (
  parlay_id uuid NOT NULL REFERENCES solana_parlays(id) ON DELETE CASCADE,
  idx smallint NOT NULL CHECK (idx BETWEEN 0 AND 4),
  market_id text NOT NULL REFERENCES markets(id),
  side leg_side NOT NULL,
  quoted_price numeric(9,8) NOT NULL CHECK (quoted_price > 0 AND quoted_price < 1),
  factor numeric(36,18) NOT NULL CHECK (factor > 0),
  result leg_result NOT NULL DEFAULT 'pending',
  resolved_at timestamptz,
  raw_resolution jsonb,
  PRIMARY KEY(parlay_id,idx),
  UNIQUE(parlay_id,market_id)
);
CREATE INDEX IF NOT EXISTS solana_parlay_legs_pending_market_idx ON solana_parlay_legs(market_id) WHERE result='pending';
