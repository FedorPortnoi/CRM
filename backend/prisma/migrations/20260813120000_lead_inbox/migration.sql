-- Inbound lead mailboxes: Яндекс Бизнес «Заявки» → воронка.
--
-- LeadInbox is one polled mailbox per organization (credentials encrypted at
-- the application layer, enc:v1: prefix). LeadInboxMessage is the per-email
-- claim: unique on (inbox, uidvalidity, uid) so a crash between "deal created"
-- and "\Seen flag set" cannot turn one заявка into two deals.

-- CreateEnum
CREATE TYPE "LeadInboxStatus" AS ENUM ('active', 'paused', 'error');

-- CreateTable
CREATE TABLE "LeadInbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "imap_host" TEXT NOT NULL DEFAULT 'imap.yandex.ru',
    "imap_port" INTEGER NOT NULL DEFAULT 993,
    "imap_user" TEXT NOT NULL,
    "imap_password_enc" TEXT NOT NULL,
    "pipeline_id" UUID,
    "stage_id" UUID,
    "assigned_to" UUID,
    "source_label" TEXT NOT NULL DEFAULT 'Яндекс Карты',
    "status" "LeadInboxStatus" NOT NULL DEFAULT 'active',
    "last_polled_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadInboxMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inbox_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "uid_validity" BIGINT NOT NULL,
    "message_uid" INTEGER NOT NULL,
    "message_id" TEXT,
    "from_addr" TEXT,
    "subject" TEXT,
    "contact_id" UUID,
    "deal_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "error" TEXT,
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadInboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadInbox_organization_id_key" ON "LeadInbox"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "LeadInboxMessage_inbox_id_uid_validity_message_uid_key" ON "LeadInboxMessage"("inbox_id", "uid_validity", "message_uid");

-- CreateIndex
CREATE INDEX "LeadInboxMessage_organization_id_created_at_idx" ON "LeadInboxMessage"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "LeadInbox" ADD CONSTRAINT "LeadInbox_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadInbox" ADD CONSTRAINT "LeadInbox_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadInboxMessage" ADD CONSTRAINT "LeadInboxMessage_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "LeadInbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadInboxMessage" ADD CONSTRAINT "LeadInboxMessage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
