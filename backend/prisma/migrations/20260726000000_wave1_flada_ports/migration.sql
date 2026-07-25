-- Wave 1 ports from the FLADA fork, adapted to 4КУБ conventions.
--
--   1. Contact blind-index columns (email_bidx / phone_bidx / mobile_bidx) — HMAC-SHA256 hex of
--      the normalized value, so encrypted PII stays searchable without decrypting every row.
--      Nullable and backfilled by application code; existing rows are untouched.
--   2. ApiKey           — credentials for the public REST API.
--   3. WebhookEndpoint  — per-org outbound webhook subscriptions.
--   4. WebhookDelivery  — one row per delivery attempt queue entry.
--   5. IdempotencyKey   — replay protection for mutating API calls.
--
-- Additive only: no column is dropped, no row is rewritten. Safe against a populated database.

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('active', 'paused');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'success', 'failed');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "email_bidx" TEXT;
ALTER TABLE "Contact" ADD COLUMN "phone_bidx" TEXT;
ALTER TABLE "Contact" ADD COLUMN "mobile_bidx" TEXT;

-- CreateIndex
CREATE INDEX "Contact_organization_id_email_bidx_idx" ON "Contact"("organization_id", "email_bidx");
CREATE INDEX "Contact_organization_id_phone_bidx_idx" ON "Contact"("organization_id", "phone_bidx");
CREATE INDEX "Contact_organization_id_mobile_bidx_idx" ON "Contact"("organization_id", "mobile_bidx");
CREATE INDEX "Contact_email_bidx_idx" ON "Contact"("email_bidx");
CREATE INDEX "Contact_phone_bidx_idx" ON "Contact"("phone_bidx");
CREATE INDEX "Contact_mobile_bidx_idx" ON "Contact"("mobile_bidx");

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" JSONB,
    "created_by" UUID,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "last_delivery_at" TIMESTAMP(3),
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
    "response_status" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_body" JSONB,
    "status_code" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_hash_key" ON "ApiKey"("key_hash");
CREATE INDEX "ApiKey_organization_id_revoked_at_idx" ON "ApiKey"("organization_id", "revoked_at");
CREATE INDEX "ApiKey_organization_id_created_at_idx" ON "ApiKey"("organization_id", "created_at");
CREATE INDEX "ApiKey_key_prefix_idx" ON "ApiKey"("key_prefix");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_organization_id_status_idx" ON "WebhookEndpoint"("organization_id", "status");
CREATE INDEX "WebhookEndpoint_organization_id_created_at_idx" ON "WebhookEndpoint"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "WebhookDelivery_organization_id_status_created_at_idx" ON "WebhookDelivery"("organization_id", "status", "created_at");
CREATE INDEX "WebhookDelivery_organization_id_endpoint_id_created_at_idx" ON "WebhookDelivery"("organization_id", "endpoint_id", "created_at" DESC);
CREATE INDEX "WebhookDelivery_status_next_attempt_at_idx" ON "WebhookDelivery"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_organization_id_key_key" ON "IdempotencyKey"("organization_id", "key");
CREATE INDEX "IdempotencyKey_expires_at_idx" ON "IdempotencyKey"("expires_at");

-- AddForeignKey
ALTER TABLE "ApiKey"
    ADD CONSTRAINT "ApiKey_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey"
    ADD CONSTRAINT "ApiKey_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint"
    ADD CONSTRAINT "WebhookEndpoint_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint"
    ADD CONSTRAINT "WebhookEndpoint_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery"
    ADD CONSTRAINT "WebhookDelivery_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery"
    ADD CONSTRAINT "WebhookDelivery_endpoint_id_fkey"
    FOREIGN KEY ("endpoint_id") REFERENCES "WebhookEndpoint"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyKey"
    ADD CONSTRAINT "IdempotencyKey_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
