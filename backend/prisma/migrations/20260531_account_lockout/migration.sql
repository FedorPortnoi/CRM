ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_user_locked_until ON "User" (locked_until) WHERE locked_until IS NOT NULL;
