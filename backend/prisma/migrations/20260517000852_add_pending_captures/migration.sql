-- CreateEnum
CREATE TYPE "PendingCaptureType" AS ENUM ('call', 'sms', 'email');

-- CreateEnum
CREATE TYPE "PendingCaptureStatus" AS ENUM ('pending', 'matched', 'dismissed');

-- CreateTable
CREATE TABLE "PendingCapture" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "type" "PendingCaptureType" NOT NULL,
    "raw_data" JSONB NOT NULL,
    "phone_number" TEXT,
    "status" "PendingCaptureStatus" NOT NULL DEFAULT 'pending',
    "contact_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingCapture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingCapture_org_id_status_idx" ON "PendingCapture"("org_id", "status");

-- CreateIndex
CREATE INDEX "PendingCapture_org_id_created_at_idx" ON "PendingCapture"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "PendingCapture" ADD CONSTRAINT "PendingCapture_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingCapture" ADD CONSTRAINT "PendingCapture_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
