-- Notification inbox + deduplication tracker
-- Run on Yandex Cloud PostgreSQL via psql or Prisma Studio

CREATE TABLE IF NOT EXISTS "Notification" (
  "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID        NOT NULL,
  "recipient_id"    UUID        NOT NULL,
  "event_type"      TEXT        NOT NULL,
  "role"            TEXT        NOT NULL,
  "title"           TEXT        NOT NULL,
  "body"            TEXT        NOT NULL,
  "entity_type"     TEXT        NOT NULL,
  "entity_id"       UUID        NOT NULL,
  "data"            JSONB,
  "is_read"         BOOLEAN     NOT NULL DEFAULT false,
  "read_at"         TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Notification_recipient_id_is_read_created_at_idx"
  ON "Notification" ("recipient_id", "is_read", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "Notification_organization_id_created_at_idx"
  ON "Notification" ("organization_id", "created_at");

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Notification_recipient_id_fkey"
    FOREIGN KEY ("recipient_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "NotificationSent" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "event_type"   TEXT         NOT NULL,
  "entity_id"    UUID         NOT NULL,
  "recipient_id" UUID         NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationSent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationSent_event_type_entity_id_recipient_id_key"
    UNIQUE ("event_type", "entity_id", "recipient_id")
);

CREATE INDEX IF NOT EXISTS "NotificationSent_created_at_idx"
  ON "NotificationSent" ("created_at");
