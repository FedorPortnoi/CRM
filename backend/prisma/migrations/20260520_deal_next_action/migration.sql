-- Add next_action fields to Deal
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "next_action" TEXT;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "next_action_due" TIMESTAMP(3);
