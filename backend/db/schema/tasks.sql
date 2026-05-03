-- Tasks
CREATE TABLE tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT,
    contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
    deal_id         UUID REFERENCES deals(id) ON DELETE SET NULL,
    assigned_to     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    due_date        TIMESTAMPTZ,
    priority        TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
    is_recurring    BOOLEAN NOT NULL DEFAULT FALSE,
    recurrence_rule TEXT, -- iCal RRULE string (RFC 5545)
    parent_task_id  UUID REFERENCES tasks(id) ON DELETE CASCADE, -- recurring series parent
    reminder_at     TIMESTAMPTZ,
    reminder_job_id TEXT, -- Bull job ID for cancellation
    completed_at    TIMESTAMPTZ,
    completed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    is_example_data BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tasks_org ON tasks(organization_id);
CREATE INDEX idx_tasks_assigned ON tasks(organization_id, assigned_to);
CREATE INDEX idx_tasks_status ON tasks(organization_id, status);
CREATE INDEX idx_tasks_due_date ON tasks(organization_id, due_date ASC NULLS LAST);
CREATE INDEX idx_tasks_contact ON tasks(organization_id, contact_id);
CREATE INDEX idx_tasks_deal ON tasks(organization_id, deal_id);
CREATE INDEX idx_tasks_priority ON tasks(organization_id, priority);

-- Calendar Events / Appointments
CREATE TABLE calendar_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    description         TEXT,
    contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
    deal_id             UUID REFERENCES deals(id) ON DELETE SET NULL,
    created_by          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    attendees           UUID[] DEFAULT '{}', -- array of user IDs
    start_time          TIMESTAMPTZ NOT NULL,
    end_time            TIMESTAMPTZ NOT NULL,
    location            TEXT,
    latitude            NUMERIC(9, 6),
    longitude           NUMERIC(9, 6),
    meeting_url         TEXT,
    google_event_id     TEXT,
    apple_event_id      TEXT,
    notes               TEXT,
    reminder_minutes    INTEGER NOT NULL DEFAULT 30,
    reminder_sent       BOOLEAN NOT NULL DEFAULT FALSE,
    status              TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
    post_meeting_prompted BOOLEAN NOT NULL DEFAULT FALSE,
    is_example_data     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_calendar_events_org ON calendar_events(organization_id);
CREATE INDEX idx_calendar_events_start ON calendar_events(organization_id, start_time);
CREATE INDEX idx_calendar_events_contact ON calendar_events(organization_id, contact_id);
CREATE INDEX idx_calendar_events_created_by ON calendar_events(organization_id, created_by);
CREATE UNIQUE INDEX idx_calendar_events_google ON calendar_events(organization_id, google_event_id)
    WHERE google_event_id IS NOT NULL;

-- Google Calendar sync tokens per user
CREATE TABLE google_calendar_sync (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    access_token    TEXT NOT NULL, -- encrypted
    refresh_token   TEXT NOT NULL, -- encrypted
    token_expires_at TIMESTAMPTZ,
    sync_token      TEXT, -- Google's page token for delta sync
    calendar_id     TEXT DEFAULT 'primary',
    last_synced_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tasks_org ON tasks USING (organization_id = current_setting('app.organization_id')::UUID);
CREATE POLICY calendar_events_org ON calendar_events USING (organization_id = current_setting('app.organization_id')::UUID);

-- Add FK references from activity_log (added after tasks table exists)
ALTER TABLE activity_log ADD CONSTRAINT fk_activity_log_task
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;

CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER calendar_events_updated_at BEFORE UPDATE ON calendar_events FOR EACH ROW EXECUTE FUNCTION update_updated_at();
