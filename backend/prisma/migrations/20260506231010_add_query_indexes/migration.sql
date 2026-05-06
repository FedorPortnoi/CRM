-- CreateIndex
CREATE INDEX "CalendarEvent_organization_id_status_start_time_idx" ON "CalendarEvent"("organization_id", "status", "start_time");

-- CreateIndex
CREATE INDEX "CalendarEvent_organization_id_created_at_idx" ON "CalendarEvent"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "CalendarEvent_organization_id_contact_id_idx" ON "CalendarEvent"("organization_id", "contact_id");

-- CreateIndex
CREATE INDEX "CalendarEvent_organization_id_deal_id_idx" ON "CalendarEvent"("organization_id", "deal_id");

-- CreateIndex
CREATE INDEX "Contact_organization_id_status_idx" ON "Contact"("organization_id", "status");

-- CreateIndex
CREATE INDEX "Contact_organization_id_created_at_idx" ON "Contact"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "Deal_organization_id_status_idx" ON "Deal"("organization_id", "status");

-- CreateIndex
CREATE INDEX "Deal_organization_id_created_at_idx" ON "Deal"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "Deal_organization_id_contact_id_idx" ON "Deal"("organization_id", "contact_id");

-- CreateIndex
CREATE INDEX "Deal_organization_id_pipeline_id_idx" ON "Deal"("organization_id", "pipeline_id");

-- CreateIndex
CREATE INDEX "Message_organization_id_created_at_idx" ON "Message"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "Message_organization_id_contact_id_created_at_idx" ON "Message"("organization_id", "contact_id", "created_at");

-- CreateIndex
CREATE INDEX "Task_organization_id_status_due_date_idx" ON "Task"("organization_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "Task_organization_id_created_at_idx" ON "Task"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "Task_organization_id_contact_id_idx" ON "Task"("organization_id", "contact_id");

-- CreateIndex
CREATE INDEX "Task_organization_id_deal_id_idx" ON "Task"("organization_id", "deal_id");
