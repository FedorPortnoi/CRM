-- CreateEnum
CREATE TYPE "ReminderFrequency" AS ENUM ('once', 'daily', 'weekdays', 'weekly', 'custom');

-- CreateEnum
CREATE TYPE "AmoIntegrationStatus" AS ENUM ('active', 'needs_reauth', 'paused');

-- CreateEnum
CREATE TYPE "AmoSyncDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "AmoSyncJobStatus" AS ENUM ('pending', 'processing', 'delivered', 'failed', 'dropped');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow';

-- AlterTable
ALTER TABLE "PipelineStage" ADD COLUMN     "is_archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "probability" INTEGER,
ADD COLUMN     "stale_after_days" INTEGER;

-- CreateTable
CREATE TABLE "TaskReminder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "frequency" "ReminderFrequency" NOT NULL,
    "time_of_day" TEXT NOT NULL,
    "days_of_week" INTEGER[],
    "recurrence_rule" TEXT,
    "timezone" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "next_fire_at" TIMESTAMP(3),
    "last_fired_at" TIMESTAMP(3),
    "fire_count" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDevice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "app_version" TEXT,
    "device_name" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmoIntegration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "subdomain" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_enc" TEXT NOT NULL,
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "redirect_uri" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3),
    "status" "AmoIntegrationStatus" NOT NULL DEFAULT 'active',
    "needs_reauth_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "last_error" TEXT,
    "webhook_ids" TEXT[],
    "connected_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmoIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmoEntityMap" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "local_id" UUID NOT NULL,
    "amo_id" BIGINT NOT NULL,
    "last_synced_at" TIMESTAMP(3),
    "last_local_hash" TEXT,
    "last_remote_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmoEntityMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmoSyncJob" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "direction" "AmoSyncDirection" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "local_id" UUID,
    "amo_id" BIGINT,
    "operation" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "AmoSyncJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "error_message" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmoSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmoSyncConflict" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "local_id" UUID,
    "amo_id" BIGINT,
    "field" TEXT NOT NULL,
    "local_value" TEXT,
    "remote_value" TEXT,
    "winner" TEXT NOT NULL,
    "local_updated_at" TIMESTAMP(3),
    "remote_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmoSyncConflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskReminder_is_active_next_fire_at_idx" ON "TaskReminder"("is_active", "next_fire_at");

-- CreateIndex
CREATE INDEX "TaskReminder_task_id_idx" ON "TaskReminder"("task_id");

-- CreateIndex
CREATE INDEX "TaskReminder_organization_id_recipient_id_idx" ON "TaskReminder"("organization_id", "recipient_id");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_token_key" ON "PushDevice"("token");

-- CreateIndex
CREATE INDEX "PushDevice_user_id_idx" ON "PushDevice"("user_id");

-- CreateIndex
CREATE INDEX "PushDevice_provider_idx" ON "PushDevice"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "AmoIntegration_organization_id_key" ON "AmoIntegration"("organization_id");

-- CreateIndex
CREATE INDEX "AmoEntityMap_organization_id_entity_type_idx" ON "AmoEntityMap"("organization_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "AmoEntityMap_organization_id_entity_type_amo_id_key" ON "AmoEntityMap"("organization_id", "entity_type", "amo_id");

-- CreateIndex
CREATE UNIQUE INDEX "AmoEntityMap_organization_id_entity_type_local_id_key" ON "AmoEntityMap"("organization_id", "entity_type", "local_id");

-- CreateIndex
CREATE INDEX "AmoSyncJob_status_next_attempt_at_idx" ON "AmoSyncJob"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "AmoSyncJob_organization_id_direction_status_idx" ON "AmoSyncJob"("organization_id", "direction", "status");

-- CreateIndex
CREATE INDEX "AmoSyncJob_organization_id_entity_type_local_id_idx" ON "AmoSyncJob"("organization_id", "entity_type", "local_id");

-- CreateIndex
CREATE INDEX "AmoSyncConflict_organization_id_created_at_idx" ON "AmoSyncConflict"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "TaskReminder" ADD CONSTRAINT "TaskReminder_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReminder" ADD CONSTRAINT "TaskReminder_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReminder" ADD CONSTRAINT "TaskReminder_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmoIntegration" ADD CONSTRAINT "AmoIntegration_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmoIntegration" ADD CONSTRAINT "AmoIntegration_connected_by_fkey" FOREIGN KEY ("connected_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmoEntityMap" ADD CONSTRAINT "AmoEntityMap_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmoSyncJob" ADD CONSTRAINT "AmoSyncJob_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmoSyncConflict" ADD CONSTRAINT "AmoSyncConflict_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written additions ───────────────────────────────────────────────────
-- Everything above is `prisma migrate diff` output. Everything below is the part
-- the diff cannot know about: invariants that live in the database rather than in
-- application code, and the backfill of the two columns this migration supersedes.

-- At most one won stage and one lost stage per pipeline.
--
-- reporting.ts and pipelineHealthScore both resolve "won" by finding THE stage with
-- is_won_stage set. With stage editing exposed to users, an org that ticks the box on
-- a second stage would not get an error — it would get quietly wrong revenue figures
-- on every report. A partial unique index makes that a write that fails loudly instead.
CREATE UNIQUE INDEX "pipeline_stage_one_won_per_pipeline"
  ON "PipelineStage" ("pipeline_id") WHERE "is_won_stage";
CREATE UNIQUE INDEX "pipeline_stage_one_lost_per_pipeline"
  ON "PipelineStage" ("pipeline_id") WHERE "is_lost_stage";

-- Backfill: every existing one-shot reminder becomes a `once` TaskReminder.
--
-- Task.reminder_at is NOT dropped here. It stays as the field the public API and the
-- client-side local notification still read, and it is the rollback path: if this
-- release is reverted, the old scheduler finds its rows exactly where it left them.
-- The timezone is the market default rather than the user's, because at the moment
-- this runs every user was implicitly on it — User.timezone did not exist until the
-- ALTER TABLE above, so claiming to know any other zone would be inventing history.
INSERT INTO "TaskReminder" (
  "task_id", "organization_id", "recipient_id", "frequency", "time_of_day",
  "days_of_week", "timezone", "starts_at", "next_fire_at", "is_active", "updated_at"
)
SELECT
  t."id", t."organization_id", t."assigned_to", 'once'::"ReminderFrequency",
  -- Prisma stores UTC instants in PostgreSQL TIMESTAMP WITHOUT TIME ZONE
  -- columns. Interpret that wall value as UTC first, then render it in Moscow;
  -- a single AT TIME ZONE would instead interpret the UTC digits as Moscow and
  -- backfill the wrong wall-clock time.
  to_char(t."reminder_at" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow', 'HH24:MI'),
  ARRAY[]::INTEGER[], 'Europe/Moscow', t."reminder_at", t."reminder_at",
  (t."status" NOT IN ('done', 'cancelled')), NOW()
FROM "Task" t
WHERE t."reminder_at" IS NOT NULL AND t."assigned_to" IS NOT NULL;

-- Backfill: every live push token becomes a PushDevice row.
--
-- Provider is recorded as 'expo' because that is what the running build hands out; the
-- RuStore and APNs rows arrive as clients re-register after upgrading. User.push_token
-- is likewise left in place for one release so a rollback does not mute every device.
INSERT INTO "PushDevice" ("user_id", "token", "provider", "platform")
SELECT u."id", u."push_token", 'expo', 'unknown'
FROM "User" u
WHERE u."push_token" IS NOT NULL
ON CONFLICT ("token") DO NOTHING;
