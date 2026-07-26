-- Wave 2: ФЗ-38 marketing consent, email sequences, and the AI assistant log.
--
--   1. Contact consent columns (marketing_consent / _at / _source, unsubscribed_at,
--      unsubscribe_token) — ФЗ-38 «О рекламе» ст. 18 requires PRIOR consent for
--      advertising mailings and fines are per message, so these columns are the
--      legal evidence. Existing rows default to marketing_consent = FALSE, i.e.
--      nobody becomes mailable by running this migration.
--   2. EmailTemplate      — reusable subject/body with {{placeholders}}.
--   3. Sequence           — an ordered set of steps.
--   4. SequenceStep       — one step: delay + template or inline content.
--   5. SequenceEnrollment — one contact in one sequence (unique pair).
--   6. EmailSend          — the per-message ledger + open-tracking token.
--   7. AssistantConversation / AssistantMessage — org-scoped AI chat history.
--
-- Additive only: no DROP, no column is rewritten, no row is deleted. Safe against
-- a populated production database.

-- CreateEnum
CREATE TYPE "SequenceStatus" AS ENUM ('draft', 'active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "SequenceEnrollmentStatus" AS ENUM ('active', 'completed', 'unsubscribed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "EmailSendStatus" AS ENUM ('queued', 'sent', 'failed', 'opened');

-- CreateEnum
CREATE TYPE "AssistantMessageRole" AS ENUM ('user', 'assistant', 'tool');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "marketing_consent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contact" ADD COLUMN "marketing_consent_at" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "marketing_consent_source" TEXT;
ALTER TABLE "Contact" ADD COLUMN "unsubscribed_at" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "unsubscribe_token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Contact_unsubscribe_token_key" ON "Contact"("unsubscribe_token");
-- The sequence sender filters exactly on this triple before queueing a message.
CREATE INDEX "Contact_organization_id_marketing_consent_unsubscribed_at_idx" ON "Contact"("organization_id", "marketing_consent", "unsubscribed_at");

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "SequenceStatus" NOT NULL DEFAULT 'draft',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceStep" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sequence_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "delay_days" INTEGER NOT NULL DEFAULT 0,
    "template_id" UUID,
    "subject" TEXT,
    "body" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceEnrollment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sequence_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "status" "SequenceEnrollmentStatus" NOT NULL DEFAULT 'active',
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "next_send_at" TIMESTAMP(3),
    "enrolled_by" UUID,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SequenceEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSend" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "enrollment_id" UUID,
    "step_id" UUID,
    "contact_id" UUID NOT NULL,
    "template_id" UUID,
    "subject" TEXT NOT NULL,
    "status" "EmailSendStatus" NOT NULL DEFAULT 'queued',
    "provider_message_id" TEXT,
    "error_message" TEXT,
    "sent_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "open_token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantConversation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "AssistantMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "tool_calls" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailTemplate_organization_id_created_at_idx" ON "EmailTemplate"("organization_id", "created_at");
CREATE INDEX "EmailTemplate_organization_id_name_idx" ON "EmailTemplate"("organization_id", "name");

-- CreateIndex
CREATE INDEX "Sequence_organization_id_status_idx" ON "Sequence"("organization_id", "status");
CREATE INDEX "Sequence_organization_id_created_at_idx" ON "Sequence"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "SequenceStep_sequence_id_position_idx" ON "SequenceStep"("sequence_id", "position");
CREATE INDEX "SequenceStep_organization_id_sequence_id_idx" ON "SequenceStep"("organization_id", "sequence_id");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceEnrollment_sequence_id_contact_id_key" ON "SequenceEnrollment"("sequence_id", "contact_id");
-- The scheduler polls exactly this triple.
CREATE INDEX "SequenceEnrollment_organization_id_status_next_send_at_idx" ON "SequenceEnrollment"("organization_id", "status", "next_send_at");
CREATE INDEX "SequenceEnrollment_organization_id_contact_id_idx" ON "SequenceEnrollment"("organization_id", "contact_id");
CREATE INDEX "SequenceEnrollment_sequence_id_status_idx" ON "SequenceEnrollment"("sequence_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSend_open_token_key" ON "EmailSend"("open_token");
CREATE INDEX "EmailSend_organization_id_status_created_at_idx" ON "EmailSend"("organization_id", "status", "created_at");
CREATE INDEX "EmailSend_organization_id_contact_id_created_at_idx" ON "EmailSend"("organization_id", "contact_id", "created_at");
CREATE INDEX "EmailSend_enrollment_id_created_at_idx" ON "EmailSend"("enrollment_id", "created_at");

-- CreateIndex
CREATE INDEX "AssistantConversation_organization_id_user_id_updated_at_idx" ON "AssistantConversation"("organization_id", "user_id", "updated_at" DESC);
CREATE INDEX "AssistantConversation_organization_id_created_at_idx" ON "AssistantConversation"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "AssistantMessage_conversation_id_created_at_idx" ON "AssistantMessage"("conversation_id", "created_at");
CREATE INDEX "AssistantMessage_organization_id_created_at_idx" ON "AssistantMessage"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "EmailTemplate"
    ADD CONSTRAINT "EmailTemplate_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTemplate"
    ADD CONSTRAINT "EmailTemplate_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sequence"
    ADD CONSTRAINT "Sequence_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sequence"
    ADD CONSTRAINT "Sequence_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep"
    ADD CONSTRAINT "SequenceStep_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep"
    ADD CONSTRAINT "SequenceStep_sequence_id_fkey"
    FOREIGN KEY ("sequence_id") REFERENCES "Sequence"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep"
    ADD CONSTRAINT "SequenceStep_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "EmailTemplate"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceEnrollment"
    ADD CONSTRAINT "SequenceEnrollment_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceEnrollment"
    ADD CONSTRAINT "SequenceEnrollment_sequence_id_fkey"
    FOREIGN KEY ("sequence_id") REFERENCES "Sequence"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceEnrollment"
    ADD CONSTRAINT "SequenceEnrollment_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "Contact"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceEnrollment"
    ADD CONSTRAINT "SequenceEnrollment_enrolled_by_fkey"
    FOREIGN KEY ("enrolled_by") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSend"
    ADD CONSTRAINT "EmailSend_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSend"
    ADD CONSTRAINT "EmailSend_enrollment_id_fkey"
    FOREIGN KEY ("enrollment_id") REFERENCES "SequenceEnrollment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSend"
    ADD CONSTRAINT "EmailSend_step_id_fkey"
    FOREIGN KEY ("step_id") REFERENCES "SequenceStep"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSend"
    ADD CONSTRAINT "EmailSend_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "Contact"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSend"
    ADD CONSTRAINT "EmailSend_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "EmailTemplate"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantConversation"
    ADD CONSTRAINT "AssistantConversation_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantConversation"
    ADD CONSTRAINT "AssistantConversation_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantMessage"
    ADD CONSTRAINT "AssistantMessage_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantMessage"
    ADD CONSTRAINT "AssistantMessage_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "AssistantConversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
