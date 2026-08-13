-- Collector mode: one platform-owned mailbox, per-org plus-addressed intake.
--
-- The org's whole onboarding becomes pasting ONE ready-made address into
-- Яндекс Бизнес; credentials for the collector mailbox live in env, never in
-- tenant rows. `custom` keeps the bring-your-own-IMAP path for advanced use.

-- CreateEnum
CREATE TYPE "LeadInboxMode" AS ENUM ('collector', 'custom');

-- AlterTable
ALTER TABLE "LeadInbox" ADD COLUMN "mode" "LeadInboxMode" NOT NULL DEFAULT 'collector';
ALTER TABLE "LeadInbox" ADD COLUMN "intake_token" TEXT;
ALTER TABLE "LeadInbox" ALTER COLUMN "imap_user" DROP NOT NULL;
ALTER TABLE "LeadInbox" ALTER COLUMN "imap_password_enc" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "LeadInbox_intake_token_key" ON "LeadInbox"("intake_token");
