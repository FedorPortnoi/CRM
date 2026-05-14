-- Add workflow automation models.

CREATE TYPE "WorkflowStatus" AS ENUM ('active', 'paused', 'archived');
CREATE TYPE "WorkflowTrigger" AS ENUM ('contact_created', 'deal_stage_changed', 'task_completed');
CREATE TYPE "WorkflowRunStatus" AS ENUM ('success', 'failed');

CREATE TABLE "Workflow" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" "WorkflowTrigger" NOT NULL,
    "conditions" JSONB,
    "actions" JSONB NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkflowRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "trigger_record_id" TEXT,
    "status" "WorkflowRunStatus" NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Workflow_organization_id_status_trigger_idx" ON "Workflow"("organization_id", "status", "trigger");
CREATE INDEX "WorkflowRun_organization_id_created_at_idx" ON "WorkflowRun"("organization_id", "created_at");
CREATE INDEX "WorkflowRun_workflow_id_created_at_idx" ON "WorkflowRun"("workflow_id", "created_at");

ALTER TABLE "Workflow"
    ADD CONSTRAINT "Workflow_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Workflow"
    ADD CONSTRAINT "Workflow_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkflowRun"
    ADD CONSTRAINT "WorkflowRun_workflow_id_fkey"
    FOREIGN KEY ("workflow_id") REFERENCES "Workflow"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
