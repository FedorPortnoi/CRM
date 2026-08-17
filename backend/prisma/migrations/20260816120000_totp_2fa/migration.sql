-- Opt-in TOTP two-factor authentication (RFC 6238).
--
-- Three columns on "User": totp_secret is the encrypted (via encryptField, never
-- plaintext) base32 secret, null until POST /auth/2fa/setup mints a pending one;
-- totp_enabled flips true only once POST /auth/2fa/enable confirms a code against
-- it; totp_confirmed_at records when that happened. See backend/services/totp.ts
-- and the doc comment on the column in schema.prisma.
--
-- "TotpBackupCode" holds single-use backup codes, hashed with sha256 (never
-- plaintext — same digest, different reversibility requirement than
-- totp_secret). Unlike "VerificationCode" these carry no expires_at: a backup
-- code's only lifecycle event is used_at being set. IF NOT EXISTS on the CREATE
-- TABLE/INDEX, matching the durable-rate-limit-buckets migration's style, so this
-- is safely re-runnable. Index name matches exactly what Prisma generates from
-- @@index([user_id]) on this model, so `prisma migrate diff` sees no drift.
ALTER TABLE "User" ADD COLUMN "totp_secret" TEXT;
ALTER TABLE "User" ADD COLUMN "totp_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "totp_confirmed_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "TotpBackupCode" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID         NOT NULL,
  "code_hash"  TEXT         NOT NULL,
  "used_at"    TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TotpBackupCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TotpBackupCode_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TotpBackupCode_user_id_idx" ON "TotpBackupCode"("user_id");
