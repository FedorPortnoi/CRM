-- Pipelines
CREATE TABLE pipelines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pipelines_org ON pipelines(organization_id);
CREATE UNIQUE INDEX idx_pipelines_default ON pipelines(organization_id) WHERE is_default = TRUE;

-- Pipeline Stages
CREATE TABLE pipeline_stages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id     UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    position        NUMERIC NOT NULL, -- float for Lexorank ordering
    color           TEXT DEFAULT '#6B7280',
    is_won_stage    BOOLEAN NOT NULL DEFAULT FALSE,
    is_lost_stage   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT one_won_stage_per_pipeline EXCLUDE (pipeline_id WITH =) WHERE (is_won_stage = TRUE),
    CONSTRAINT one_lost_stage_per_pipeline EXCLUDE (pipeline_id WITH =) WHERE (is_lost_stage = TRUE)
);

CREATE INDEX idx_pipeline_stages_pipeline ON pipeline_stages(pipeline_id, position);

-- Deals
CREATE TABLE deals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
    pipeline_id     UUID NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
    stage_id        UUID NOT NULL REFERENCES pipeline_stages(id) ON DELETE RESTRICT,
    value           NUMERIC(15, 2),
    currency        CHAR(3) NOT NULL DEFAULT 'RUB',
    expected_close  DATE,
    actual_close    DATE,
    probability     SMALLINT CHECK (probability >= 0 AND probability <= 100),
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'archived')),
    lost_reason     TEXT,
    source          TEXT,
    assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    is_example_data BOOLEAN NOT NULL DEFAULT FALSE,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deals_org ON deals(organization_id);
CREATE INDEX idx_deals_contact ON deals(organization_id, contact_id);
CREATE INDEX idx_deals_stage ON deals(organization_id, stage_id);
CREATE INDEX idx_deals_assigned ON deals(organization_id, assigned_to);
CREATE INDEX idx_deals_status ON deals(organization_id, status);
CREATE INDEX idx_deals_expected_close ON deals(organization_id, expected_close);
CREATE INDEX idx_deals_created_at ON deals(organization_id, created_at DESC);

-- Deal Stage History (for analytics — time spent per stage)
CREATE TABLE deal_stage_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id     UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    stage_id    UUID NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
    entered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    exited_at   TIMESTAMPTZ -- NULL means deal is currently in this stage
);

CREATE INDEX idx_deal_stage_history_deal ON deal_stage_history(deal_id, entered_at DESC);
CREATE INDEX idx_deal_stage_history_stage ON deal_stage_history(stage_id, entered_at);

-- Automation Rules
CREATE TABLE automation_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    trigger_event       TEXT NOT NULL,
    trigger_conditions  JSONB NOT NULL DEFAULT '{}',
    action_type         TEXT NOT NULL,
    action_payload      JSONB NOT NULL DEFAULT '{}',
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_automation_rules_org ON automation_rules(organization_id, is_active);

-- Custom Field Definitions
CREATE TABLE custom_field_definitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('contact', 'deal')),
    name            TEXT NOT NULL,
    field_key       TEXT NOT NULL, -- URL-safe key used in JSONB
    field_type      TEXT NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'dropdown', 'multi_select', 'checkbox', 'url', 'email', 'phone')),
    options         JSONB DEFAULT '[]', -- for dropdown / multi_select
    required        BOOLEAN NOT NULL DEFAULT FALSE,
    default_value   JSONB,
    position        INTEGER NOT NULL DEFAULT 0,
    is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_custom_fields_key ON custom_field_definitions(organization_id, entity_type, field_key)
    WHERE is_archived = FALSE;

-- RLS
ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY pipelines_org ON pipelines USING (organization_id = current_setting('app.organization_id')::UUID);
CREATE POLICY pipeline_stages_org ON pipeline_stages USING (organization_id = current_setting('app.organization_id')::UUID);
CREATE POLICY deals_org ON deals USING (organization_id = current_setting('app.organization_id')::UUID);
CREATE POLICY automation_rules_org ON automation_rules USING (organization_id = current_setting('app.organization_id')::UUID);
CREATE POLICY custom_field_definitions_org ON custom_field_definitions USING (organization_id = current_setting('app.organization_id')::UUID);

CREATE TRIGGER deals_updated_at BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER pipelines_updated_at BEFORE UPDATE ON pipelines FOR EACH ROW EXECUTE FUNCTION update_updated_at();
