-- Adds a self-referential reporting hierarchy to User: each user optionally
-- reports to one manager (manager_id -> User.id). Drives role/hierarchy-based
-- visibility scoping. Additive and nullable — safe, no backfill required.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "manager_id" UUID;

-- AddForeignKey
ALTER TABLE "User"
  ADD CONSTRAINT "User_manager_id_fkey"
  FOREIGN KEY ("manager_id") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "User_manager_id_idx" ON "User"("manager_id");
