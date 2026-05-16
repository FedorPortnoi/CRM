-- Contacts (core entity — customers, leads, partners)
CREATE TABLE contacts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    first_name      TEXT NOT NULL,
    last_name       TEXT,
    company         TEXT,
    email           TEXT, -- encrypted at application layer
    phone           TEXT, -- encrypted at application layer
    mobile          TEXT, -- encrypted at application layer
    address         JSONB DEFAULT '{}', -- {street, city, state, country, postal_code}
    tags            TEXT[] DEFAULT '{}',
    source          TEXT,
    notes           TEXT,
    avatar_url      TEXT,
    assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,
    type            TEXT NOT NULL DEFAULT 'lead' CHECK (type IN ('lead', 'customer', 'partner', 'other')),
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    is_example_data BOOLEAN NOT NULL DEFAULT FALSE,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Full-text search vector (updated via trigger)
    fts             TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('english',
            coalesce(first_name, '') || ' ' ||
            coalesce(last_name, '') || ' ' ||
            coalesce(company, '') || ' ' ||
            coalesce(notes, '')
        )
    ) STORED
);

CREATE INDEX idx_contacts_organization_id ON contacts(organization_id);
CREATE INDEX idx_contacts_assigned_to ON contacts(organization_id, assigned_to);
CREATE INDEX idx_contacts_status ON contacts(organization_id, status);
CREATE INDEX idx_contacts_type ON contacts(organization_id, type);
CREATE INDEX idx_contacts_tags ON contacts USING GIN(tags);
CREATE INDEX idx_contacts_custom_fields ON contacts USING GIN(custom_fields jsonb_path_ops);
CREATE INDEX idx_contacts_fts ON contacts USING GIN(fts);
CREATE INDEX idx_contacts_created_at ON contacts(organization_id, created_at DESC);

-- Activity log (append-only — no updates or deletes)
CREATE TABLE activity_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id      UUID REFERENCES contacts(id) ON DELETE CASCADE,
    deal_id         UUID, -- FK added after deals table
    task_id         UUID, -- FK added after tasks table
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    type            TEXT NOT NULL CHECK (type IN (
                        'call', 'message', 'meeting', 'note',
                        'task_created', 'task_completed',
                        'deal_created', 'deal_stage_changed', 'deal_won', 'deal_lost',
                        'contact_created', 'contact_updated',
                        'email', 'file_uploaded'
                    )),
    description     TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    source_id       TEXT, -- external ID for idempotency (SMS.ru ID, Yandex event ID, etc.)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_log_contact ON activity_log(organization_id, contact_id, created_at DESC);
CREATE INDEX idx_activity_log_deal ON activity_log(organization_id, deal_id, created_at DESC);
CREATE INDEX idx_activity_log_user ON activity_log(organization_id, user_id, created_at DESC);
CREATE INDEX idx_activity_log_type ON activity_log(organization_id, type, created_at DESC);
CREATE UNIQUE INDEX idx_activity_log_source_id ON activity_log(organization_id, source_id)
    WHERE source_id IS NOT NULL;

-- Attachments
CREATE TABLE attachments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('contact', 'deal', 'task', 'message', 'event')),
    entity_id       UUID NOT NULL,
    uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    filename        TEXT NOT NULL,
    content_type    TEXT NOT NULL,
    size_bytes      INTEGER,
    s3_key          TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_attachments_entity ON attachments(organization_id, entity_type, entity_id);

-- RLS
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY contacts_org_isolation ON contacts
    USING (organization_id = current_setting('app.organization_id')::UUID);

CREATE POLICY activity_log_org_isolation ON activity_log
    USING (organization_id = current_setting('app.organization_id')::UUID);

CREATE POLICY attachments_org_isolation ON attachments
    USING (organization_id = current_setting('app.organization_id')::UUID);

-- Block deletes/updates on activity_log for all but superuser
CREATE RULE activity_log_no_update AS ON UPDATE TO activity_log DO INSTEAD NOTHING;
CREATE RULE activity_log_no_delete AS ON DELETE TO activity_log DO INSTEAD NOTHING;

CREATE TRIGGER contacts_updated_at
    BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
