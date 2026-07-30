-- Link-based co-worker invitations.
--
-- Additive only: no existing table is touched, so this is safe to apply to a
-- running production database ahead of the app release that uses it. The old
-- join_code path keeps working untouched until the new one has shipped on both
-- stores.

CREATE TABLE IF NOT EXISTS "Invite" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  UUID         NOT NULL,
  "name"             TEXT         NOT NULL,
  "role"             "UserRole"   NOT NULL,
  "created_by"       UUID         NOT NULL,

  -- Every secret is a SHA-256 digest. Nothing redeemable is stored.
  "token_hash"        TEXT         NOT NULL,
  -- Traded for a lookup only; never resolves an accept.
  "handoff_hash"      TEXT,
  "claim_hash"        TEXT,
  "claim_expires_at"  TIMESTAMP(3),
  -- Minted by a successful lookup, spent by accept.
  "accept_hash"       TEXT,
  "accept_expires_at" TIMESTAMP(3),

  "expires_at"       TIMESTAMP(3) NOT NULL,
  "opened_at"        TIMESTAMP(3),
  "consumed_at"      TIMESTAMP(3),
  "user_id"          UUID,
  "revoked_at"       TIMESTAMP(3),

  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- Unique so a hash collision or a duplicate mint surfaces as an error rather
-- than as two invites redeemable by one string.
CREATE UNIQUE INDEX IF NOT EXISTS "Invite_token_hash_key"   ON "Invite"("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "Invite_handoff_hash_key" ON "Invite"("handoff_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "Invite_accept_hash_key"  ON "Invite"("accept_hash");

CREATE INDEX IF NOT EXISTS "Invite_organization_id_consumed_at_idx" ON "Invite"("organization_id", "consumed_at");

DO $$ BEGIN
  ALTER TABLE "Invite" ADD CONSTRAINT "Invite_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Invite" ADD CONSTRAINT "Invite_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Invite" ADD CONSTRAINT "Invite_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
