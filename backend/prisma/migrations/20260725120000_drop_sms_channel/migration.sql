-- Drop SMS from the product entirely: the SMS.ru provider is gone, so no code path can
-- produce an SMS message or an SMS capture any more.
--
-- PostgreSQL cannot remove a value from an enum in place, so each type is rebuilt.
-- Existing rows are preserved, not deleted:
--   * Message.channel     'sms' -> 'in_app'  (keeps the contact's communication history;
--                                             body and timestamps are unchanged)
--   * PendingCapture.type 'sms' -> 'email'   (an unmatched touchpoint stays in the inbox)
-- Expected to affect zero rows: SMS sending was never configured in production
-- (SMSRU_API_ID was never set), so no SMS was ever sent or logged.

-- MessageChannel: sms | in_app | email | call  ->  in_app | email | call
UPDATE "Message" SET "channel" = 'in_app' WHERE "channel" = 'sms';

ALTER TYPE "MessageChannel" RENAME TO "MessageChannel_old";
CREATE TYPE "MessageChannel" AS ENUM ('in_app', 'email', 'call');
ALTER TABLE "Message"
  ALTER COLUMN "channel" TYPE "MessageChannel"
  USING ("channel"::text::"MessageChannel");
DROP TYPE "MessageChannel_old";

-- PendingCaptureType: call | sms | email  ->  call | email
UPDATE "PendingCapture" SET "type" = 'email' WHERE "type" = 'sms';

ALTER TYPE "PendingCaptureType" RENAME TO "PendingCaptureType_old";
CREATE TYPE "PendingCaptureType" AS ENUM ('call', 'email');
ALTER TABLE "PendingCapture"
  ALTER COLUMN "type" TYPE "PendingCaptureType"
  USING ("type"::text::"PendingCaptureType");
DROP TYPE "PendingCaptureType_old";
