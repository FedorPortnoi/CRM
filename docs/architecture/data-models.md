# Data Models

All tables live in a single PostgreSQL schema. Every table has `organization_id` for multi-tenant isolation enforced via Row-Level Security. Timestamps are stored in UTC. UUIDs are used for all primary keys.

## Core Entities

### Organization
The top-level tenant. All other entities belong to an organization.

```
organizations
  id              UUID PK
  name            TEXT NOT NULL
  slug            TEXT UNIQUE NOT NULL       -- URL-safe identifier
  plan            ENUM(solo, micro, small, medium)
  owner_id        UUID FK → users.id
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ
```

### User
A person who logs into the CRM. Users belong to one organization.

```
users
  id              UUID PK
  organization_id UUID FK → organizations.id
  email           TEXT UNIQUE NOT NULL
  password_hash   TEXT NOT NULL
  name            TEXT NOT NULL
  role            ENUM(owner, admin, member, viewer)
  avatar_url      TEXT
  phone           TEXT (encrypted at rest)
  is_active       BOOLEAN DEFAULT true
  last_seen_at    TIMESTAMPTZ
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ
```

### Contact
The central entity. Every customer, lead, or partner.

```
contacts
  id              UUID PK
  organization_id UUID FK → organizations.id
  first_name      TEXT NOT NULL
  last_name       TEXT
  company         TEXT
  email           TEXT (encrypted)
  phone           TEXT (encrypted)
  mobile          TEXT (encrypted)
  address         JSONB                      -- {street, city, country, postal_code}
  tags            TEXT[]
  source          TEXT                       -- e.g. "website", "referral", "import"
  notes           TEXT
  avatar_url      TEXT
  assigned_to     UUID FK → users.id
  type            ENUM(lead, customer, partner, other)
  status          ENUM(active, inactive, archived)
  custom_fields   JSONB                      -- flexible key-value pairs
  created_by      UUID FK → users.id
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ

INDEXES: organization_id, assigned_to, tags GIN, status, type
```

### Pipeline
A customizable sales pipeline (can have multiple per org).

```
pipelines
  id              UUID PK
  organization_id UUID FK → organizations.id
  name            TEXT NOT NULL
  description     TEXT
  is_default      BOOLEAN DEFAULT false
  created_by      UUID FK → users.id
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ
```

### Pipeline Stage
One stage within a pipeline (e.g., "Lead", "Qualified", "Proposal", "Closed Won").

```
pipeline_stages
  id              UUID PK
  pipeline_id     UUID FK → pipelines.id
  organization_id UUID FK → organizations.id
  name            TEXT NOT NULL
  position        INTEGER NOT NULL           -- display order
  color           TEXT                       -- hex color for UI
  is_won_stage    BOOLEAN DEFAULT false
  is_lost_stage   BOOLEAN DEFAULT false
  created_at      TIMESTAMPTZ
```

### Deal
A sales opportunity tracked through a pipeline.

```
deals
  id              UUID PK
  organization_id UUID FK → organizations.id
  title           TEXT NOT NULL
  contact_id      UUID FK → contacts.id
  pipeline_id     UUID FK → pipelines.id
  stage_id        UUID FK → pipeline_stages.id
  value           NUMERIC(15,2)
  currency        CHAR(3) DEFAULT 'USD'
  expected_close  DATE
  actual_close    DATE
  probability     SMALLINT                   -- 0-100
  status          ENUM(open, won, lost, archived)
  lost_reason     TEXT
  source          TEXT                       -- lead source
  assigned_to     UUID FK → users.id
  custom_fields   JSONB
  created_by      UUID FK → users.id
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ

INDEXES: organization_id, contact_id, stage_id, assigned_to, status, expected_close
```

### Task
A to-do item linked to a contact or deal.

```
tasks
  id              UUID PK
  organization_id UUID FK → organizations.id
  title           TEXT NOT NULL
  description     TEXT
  contact_id      UUID FK → contacts.id (nullable)
  deal_id         UUID FK → deals.id (nullable)
  assigned_to     UUID FK → users.id
  created_by      UUID FK → users.id
  due_date        TIMESTAMPTZ
  priority        ENUM(low, medium, high, urgent)
  status          ENUM(pending, in_progress, done, cancelled)
  is_recurring    BOOLEAN DEFAULT false
  recurrence_rule TEXT                       -- iCal RRULE string
  reminder_at     TIMESTAMPTZ
  completed_at    TIMESTAMPTZ
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ

INDEXES: organization_id, assigned_to, due_date, status, contact_id, deal_id
```

### Message
An SMS or in-app message sent or received.

```
messages
  id              UUID PK
  organization_id UUID FK → organizations.id
  contact_id      UUID FK → contacts.id
  user_id         UUID FK → users.id        -- who sent/received
  direction       ENUM(inbound, outbound)
  channel         ENUM(sms, in_app, email)
  body            TEXT NOT NULL
  status          ENUM(sent, delivered, read, failed)
  twilio_sid      TEXT                       -- for SMS tracking
  read_at         TIMESTAMPTZ
  created_at      TIMESTAMPTZ

INDEXES: organization_id, contact_id, created_at
```

### Calendar Event / Appointment
```
calendar_events
  id              UUID PK
  organization_id UUID FK → organizations.id
  title           TEXT NOT NULL
  description     TEXT
  contact_id      UUID FK → contacts.id (nullable)
  deal_id         UUID FK → deals.id (nullable)
  created_by      UUID FK → users.id
  attendees       UUID[]                     -- array of user IDs
  start_time      TIMESTAMPTZ NOT NULL
  end_time        TIMESTAMPTZ NOT NULL
  location        TEXT
  google_event_id TEXT                       -- for calendar sync
  apple_event_id  TEXT
  notes           TEXT
  reminder_minutes INTEGER DEFAULT 30
  status          ENUM(scheduled, completed, cancelled)
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ
```

### Activity Log
Append-only log of every interaction event. Powers the Interaction History feature.

```
activity_log
  id              UUID PK
  organization_id UUID FK → organizations.id
  contact_id      UUID FK → contacts.id (nullable)
  deal_id         UUID FK → deals.id (nullable)
  task_id         UUID FK → tasks.id (nullable)
  user_id         UUID FK → users.id
  type            ENUM(call, message, meeting, note, task_created, task_completed,
                       deal_created, deal_stage_changed, contact_created,
                       email, file_uploaded)
  description     TEXT
  metadata        JSONB                      -- type-specific data
  created_at      TIMESTAMPTZ

INDEXES: organization_id, contact_id, deal_id, type, created_at DESC
-- This table is append-only. No updates or deletes.
```

### Attachment
Files linked to any entity.

```
attachments
  id              UUID PK
  organization_id UUID FK → organizations.id
  entity_type     TEXT NOT NULL              -- 'contact', 'deal', 'task', 'message'
  entity_id       UUID NOT NULL
  uploaded_by     UUID FK → users.id
  filename        TEXT NOT NULL
  content_type    TEXT NOT NULL
  size_bytes      INTEGER
  s3_key          TEXT NOT NULL
  created_at      TIMESTAMPTZ
```

### Refresh Token
For JWT revocation support.

```
refresh_tokens
  id              UUID PK
  user_id         UUID FK → users.id
  token_hash      TEXT UNIQUE NOT NULL
  expires_at      TIMESTAMPTZ
  revoked_at      TIMESTAMPTZ
  created_at      TIMESTAMPTZ
```

## Key Relationships

```
Organization (1) ──< Users (many)
Organization (1) ──< Contacts (many)
Organization (1) ──< Pipelines (many)
Pipeline (1) ──< Pipeline Stages (many)
Contact (1) ──< Deals (many)
Contact (1) ──< Tasks (many)
Contact (1) ──< Messages (many)
Contact (1) ──< Activity Log (many)
Deal (1) ──< Tasks (many)
Deal (1) ──< Activity Log (many)
Pipeline Stage (1) ──< Deals (many)
```

## Custom Fields Strategy

Rather than altering schemas for every customization, `custom_fields JSONB` columns store user-defined key-value pairs on Contacts and Deals. A `custom_field_definitions` table (future) will define available fields per organization with types and validation rules.

## Data Retention

Activity log is never deleted (audit trail). All other data follows soft-delete pattern via `status = archived` or `is_active = false`. Hard deletion available only for GDPR compliance requests.
