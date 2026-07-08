-- CC-65: Add ecash reward tracking columns to orders
-- Privacy: status only — no token data, no bolt11, no proof secrets

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS ecash_reward_status TEXT
    CHECK (ecash_reward_status IN ('pending', 'settled')),
  ADD COLUMN IF NOT EXISTS ecash_reward_settled_at TIMESTAMPTZ;

-- Index for efficient reward-status queries
CREATE INDEX IF NOT EXISTS idx_orders_ecash_reward_status
  ON orders (ecash_reward_status)
  WHERE ecash_reward_status IS NOT NULL;

-- Comment for audit trail
COMMENT ON COLUMN orders.ecash_reward_status IS
  'Ecash loyalty reward state: null=not yet claimed, pending=invoice paid awaiting mint, settled=tokens issued to device. No token data is stored.';
COMMENT ON COLUMN orders.ecash_reward_settled_at IS
  'Timestamp when ecash reward was settled. Token data never persisted server-side.';
