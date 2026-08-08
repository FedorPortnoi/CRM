-- Durable rate-limit buckets for the unauthenticated auth routes.
--
-- WHY
-- ---
-- @fastify/rate-limit kept every bucket in this product in a `toad-cache` LruMap
-- on the plugin instance. That is not a security control:
--
--   * the process owns it, so a pm2 restart, a crash, a deploy, or the
--     `max_memory_restart: '600M'` in deploy/local/ecosystem.config.js handed
--     every key a brand-new budget; and
--   * the LRU is capped at 5000 entries per route and EVICTS, so a blocked key
--     could be flushed out by 5000 throwaway keys with no restart at all.
--
-- The invite claim code is a 6-character secret whose entire defence, stated in
-- writing at backend/services/invites.ts, is the call budget on
-- POST /api/v1/auth/invites/lookup. That budget now lives here.
--
-- Postgres rather than Redis: this deployment is one pm2 fork on one laptop, and
-- Redis would be a second daemon to keep alive, a second thing to back up, and
-- one more component whose silent death changes the security posture. Postgres
-- is already the datastore and is already in deploy/local/backup.js.
--
-- WHAT IS IN A ROW
-- ----------------
-- "id" is a SHA-256 digest of "<scope>|<key>" — never the key itself. The key on
-- POST /auth/login is the client IP joined to the submitted email address, and
-- LoginSchema caps the length of neither, so storing it raw would be a
-- table-bloat vector on an unauthenticated endpoint. It would also make this
-- table a register of who tried to sign in from where, which is personal data
-- under ФЗ-152 that a rate limiter has no reason to create.
--
-- No organization_id: every row is written BEFORE authentication, so there is no
-- tenant to scope to.
--
-- Timestamps are naive TIMESTAMP(3) holding UTC, like every other timestamp in
-- this schema. The application writes and compares them as
-- `now() AT TIME ZONE 'UTC'` explicitly rather than letting a session TimeZone
-- decide — this database ran three hours off once.
--
-- SAFE ON A LIVE DATABASE
-- -----------------------
-- Purely additive: no existing table, column, index or row is touched, and every
-- statement is IF NOT EXISTS, so it is re-runnable and can be applied ahead of
-- the release that uses it. It MUST be applied before that release: the store
-- fails closed, so code deployed against a database without this table answers
-- 503 to every login, register, join, OTP verify and invite redemption.
CREATE TABLE IF NOT EXISTS "RateLimitBucket" (
  "id"           TEXT         NOT NULL,
  "count"        INTEGER      NOT NULL DEFAULT 0,
  "window_start" TIMESTAMP(3) NOT NULL,
  "expires_at"   TIMESTAMP(3) NOT NULL,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- Backs the hourly TTL sweep in services/scheduler.ts ('rate-limit-reaper').
-- Named to match what Prisma generates for @@index([expires_at]) on this model,
-- so `prisma migrate diff` sees no drift.
CREATE INDEX IF NOT EXISTS "RateLimitBucket_expires_at_idx" ON "RateLimitBucket"("expires_at");
