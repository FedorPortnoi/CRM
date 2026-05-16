-- Rename Google Calendar fields to provider-neutral ext_ names in CalendarEvent
ALTER TABLE "CalendarEvent"
  RENAME COLUMN "google_event_id" TO "ext_event_uid";

ALTER TABLE "CalendarEvent"
  RENAME COLUMN "google_calendar_id" TO "ext_calendar_uid";

-- Rename and add Yandex fields in UserCalendarSync
ALTER TABLE "UserCalendarSync"
  RENAME COLUMN "google_calendar_id" TO "ext_calendar_uid";

ALTER TABLE "UserCalendarSync"
  DROP COLUMN IF EXISTS "webhook_channel_id";

ALTER TABLE "UserCalendarSync"
  DROP COLUMN IF EXISTS "webhook_resource_id";

ALTER TABLE "UserCalendarSync"
  DROP COLUMN IF EXISTS "webhook_expiry";

ALTER TABLE "UserCalendarSync"
  ADD COLUMN IF NOT EXISTS "yandex_username" TEXT;

ALTER TABLE "UserCalendarSync"
  ADD COLUMN IF NOT EXISTS "yandex_calendar_slug" TEXT;
