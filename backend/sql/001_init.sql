DO $$ BEGIN CREATE TYPE parlay_status AS ENUM ('open', 'won', 'lost', 'void');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE leg_side AS ENUM ('YES', 'NO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE leg_result AS ENUM ('pending', 'win', 'lose', 'void');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE ledger_kind AS ENUM ('grant', 'stake', 'payout', 'refund');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE,
  balance numeric(18,6) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS markets (
  id text PRIMARY KEY,
  venue text NOT NULL CHECK (venue IN ('kalshi', 'polymarket')),
  venue_market_id text NOT NULL,
  event_id text NOT NULL,
  title text NOT NULL,
  category text NOT NULL DEFAULT '',
  rules_text text NOT NULL DEFAULT '',
  close_time timestamptz NOT NULL,
  status text NOT NULL,
  yes_token_id text,
  no_token_id text,
  condition_id text,
  equivalence_group text,
  is_combo boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue, venue_market_id)
);
CREATE INDEX IF NOT EXISTS markets_open_close_idx ON markets (close_time) WHERE status = 'open' AND is_combo = false;
CREATE INDEX IF NOT EXISTS markets_search_idx ON markets USING gin (to_tsvector('simple', title || ' ' || category));

CREATE TABLE IF NOT EXISTS parlays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  quote_nonce uuid NOT NULL UNIQUE,
  stake numeric(18,6) NOT NULL CHECK (stake > 0),
  multiplier numeric(24,12) NOT NULL CHECK (multiplier > 0),
  quoted_payout numeric(18,6) NOT NULL CHECK (quoted_payout >= 0),
  status parlay_status NOT NULL DEFAULT 'open',
  payout numeric(18,6),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS parlays_user_created_idx ON parlays (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS parlays_open_idx ON parlays (created_at) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS parlay_legs (
  parlay_id uuid NOT NULL REFERENCES parlays(id) ON DELETE CASCADE,
  idx smallint NOT NULL CHECK (idx BETWEEN 0 AND 4),
  market_id text NOT NULL REFERENCES markets(id),
  side leg_side NOT NULL,
  quoted_price numeric(9,8) NOT NULL CHECK (quoted_price > 0 AND quoted_price < 1),
  factor numeric(36,18) NOT NULL CHECK (factor > 0),
  result leg_result NOT NULL DEFAULT 'pending',
  resolved_at timestamptz,
  raw_resolution jsonb,
  PRIMARY KEY (parlay_id, idx),
  UNIQUE (parlay_id, market_id)
);
ALTER TABLE parlay_legs ALTER COLUMN factor TYPE numeric(36,18);
CREATE INDEX IF NOT EXISTS parlay_legs_pending_market_idx ON parlay_legs (market_id) WHERE result = 'pending';

CREATE TABLE IF NOT EXISTS ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind ledger_kind NOT NULL,
  amount numeric(18,6) NOT NULL CHECK (amount <> 0),
  parlay_id uuid REFERENCES parlays(id),
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_created_idx ON ledger_entries (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS venue_sync_state (
  venue text PRIMARY KEY CHECK (venue IN ('kalshi', 'polymarket')),
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_error text,
  markets_seen integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS system_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO venue_sync_state (venue) VALUES ('kalshi'), ('polymarket') ON CONFLICT DO NOTHING;
