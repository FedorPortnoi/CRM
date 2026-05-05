-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "decay_factor" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
ADD COLUMN     "stalled_threshold_days" INTEGER NOT NULL DEFAULT 30;
