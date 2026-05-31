UPDATE "Deal"
SET "currency" = 'RUB'
WHERE "currency" IS NULL;

ALTER TABLE "Deal"
ALTER COLUMN "currency" SET DEFAULT 'RUB';
