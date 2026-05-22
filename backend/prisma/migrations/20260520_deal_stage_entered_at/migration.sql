-- Track when a deal entered its current stage
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "stage_entered_at" TIMESTAMP(3) NOT NULL DEFAULT NOW();
