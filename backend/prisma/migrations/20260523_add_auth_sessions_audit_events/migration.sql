CREATE TABLE "AuthSession" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "user_agent" TEXT,
  "ip_address" TEXT,
  "revoked_at" TIMESTAMP(3),
  "revoked_reason" TEXT,
  "last_seen_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID,
  "user_id" UUID,
  "action" TEXT NOT NULL,
  "outcome" TEXT NOT NULL DEFAULT 'success',
  "target_type" TEXT,
  "target_id" TEXT,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthSession_token_hash_key" ON "AuthSession"("token_hash");
CREATE INDEX "AuthSession_user_id_revoked_at_idx" ON "AuthSession"("user_id", "revoked_at");
CREATE INDEX "AuthSession_organization_id_created_at_idx" ON "AuthSession"("organization_id", "created_at");

CREATE INDEX "AuditEvent_organization_id_created_at_idx" ON "AuditEvent"("organization_id", "created_at");
CREATE INDEX "AuditEvent_user_id_created_at_idx" ON "AuditEvent"("user_id", "created_at");
CREATE INDEX "AuditEvent_action_created_at_idx" ON "AuditEvent"("action", "created_at");

ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
