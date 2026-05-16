-- Messages (SMS, in-app, email channel)
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL, -- who sent or received
    direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    channel         TEXT NOT NULL CHECK (channel IN ('sms', 'in_app', 'email')),
    body            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
    error_message   TEXT,
    smsru_id        TEXT UNIQUE, -- for SMS tracking and idempotency
    google_msg_id   TEXT, -- for email thread tracking
    read_at         TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_org ON messages(organization_id);
CREATE INDEX idx_messages_contact ON messages(organization_id, contact_id, created_at DESC);
CREATE INDEX idx_messages_user ON messages(organization_id, user_id);
CREATE INDEX idx_messages_channel ON messages(organization_id, channel);
CREATE INDEX idx_messages_unread ON messages(organization_id, contact_id, user_id)
    WHERE direction = 'inbound' AND read_at IS NULL;

-- Unread message counts (materialized for performance)
CREATE MATERIALIZED VIEW mv_unread_counts AS
SELECT
    organization_id,
    user_id,
    COUNT(*) AS unread_count
FROM messages
WHERE direction = 'inbound' AND read_at IS NULL
GROUP BY organization_id, user_id;

CREATE UNIQUE INDEX ON mv_unread_counts(organization_id, user_id);

-- Inbound message queue (for webhook idempotency before processing)
CREATE TABLE inbound_webhook_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT NOT NULL CHECK (source IN ('smsru', 'yandex', 'internal')),
    payload         JSONB NOT NULL,
    processed       BOOLEAN NOT NULL DEFAULT FALSE,
    processed_at    TIMESTAMPTZ,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_queue_unprocessed ON inbound_webhook_queue(created_at) WHERE processed = FALSE;

-- Call log (for explicit call records)
CREATE TABLE call_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    duration_seconds INTEGER,
    notes           TEXT,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_call_records_contact ON call_records(organization_id, contact_id, occurred_at DESC);
CREATE INDEX idx_call_records_user ON call_records(organization_id, user_id, occurred_at DESC);

-- Push notification tokens per user device
CREATE TABLE push_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token           TEXT NOT NULL UNIQUE,
    platform        TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'expo')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_push_tokens_user ON push_tokens(user_id, is_active);

-- RLS
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_org ON messages USING (organization_id = current_setting('app.organization_id')::UUID);
CREATE POLICY call_records_org ON call_records USING (organization_id = current_setting('app.organization_id')::UUID);

-- Add FK from activity_log to deals (deferred — deals table must exist first)
ALTER TABLE activity_log ADD CONSTRAINT fk_activity_log_deal
    FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;
