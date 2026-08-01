# amoCRM integration

The integration uses amoCRM API v4 and supports one connected amoCRM account per 4KUB
organization. Connection, reauthorization, and disconnect remain explicit owner/admin actions;
the assistant can inspect status, start an import, inspect conflicts, and retry failed sync jobs,
but cannot handle credentials or disconnect an account.

## Supported data

| 4KUB data | Import | amoCRM → 4KUB | 4KUB → amoCRM |
|---|---:|---:|---:|
| Contacts: name, phone, email | Yes | Yes | Yes |
| Deals/leads: title, value, open/won/lost | Yes | Yes | Yes |
| Pipelines and stages | Yes | Yes | Yes; missing amoCRM pipelines/statuses are created lazily |
| Deal main contact | Yes | Yes | Yes |
| Companies | Name imported into `Contact.company` | No live company entity | No live company entity |
| Responsible salesperson | No mapping | Not synchronized | Not synchronized |
| Tags and arbitrary amoCRM custom fields | Preserved where the importer maps them | Not synchronized live | Not synchronized live |
| Deletion | Imported entities marked deleted are skipped | Lead delete archives locally | Never deletes remotely |

4KUB currently has no Company model and no amoCRM-user-to-4KUB-user identity map. Those are schema
features, not safe fields to guess: live company sync would otherwise flatten several companies into
one contact string, and responsible-user sync could silently assign a deal to the wrong employee.

Outbound deletion is deliberately not implemented. Local archival is reversible; deleting a
customer's amoCRM record is not. Inbound deletes are converted to local archival.

## Consistency and failure behavior

- OAuth tokens are encrypted at rest. Refresh rotation is serialized per organization and the new
  rotating refresh token is persisted before another refresh may use it.
- Webhook subscription URLs carry a signed per-organization token. The receiver requires it before
  tenant lookup, enqueues the event, and returns without doing amoCRM network work.
- `AmoEntityMap` prevents an import and a later webhook from creating the same entity twice.
- Both directions retry with backoff. Failed dependencies—such as a deal referencing a contact that
  has not been mapped yet—remain visible in the queue instead of silently dropping the field.
- Local and remote hashes suppress echo loops. Last-write-wins conflict resolution records every
  discarded field value in `AmoSyncConflict`.
- A nightly remote reconciliation heals missed inbound webhooks.

The current local outbound hook writes to the sync queue immediately after the CRM row commits. It
does not yet share the row's database transaction. A process crash in that narrow interval can miss
one outbound enqueue; a future transactional-outbox migration should close that durability gap.

## Required deployment configuration

Set these only in the deployment secret store / `.env.localprod`, never in the repository:

```text
AMOCRM_CLIENT_ID=
AMOCRM_CLIENT_SECRET=
AMOCRM_REDIRECT_URI=https://4kub.ru/api/v1/amocrm/callback
AMOCRM_WEBHOOK_URL=https://4kub.ru/api/v1/integrations/amocrm/webhook
```

The redirect URI must exactly match the integration registered in amoCRM. After deploying the
database migration and API, connect from **Settings → Integrations → amoCRM**, run an import, then
verify one contact update, one deal stage change, one main-contact change, and one inbound edit before
enabling it for a customer.

Primary API references: [pipelines and statuses](https://www.amocrm.ru/developers/content/crm_platform/leads_pipelines),
[leads](https://www.amocrm.ru/developers/content/crm_platform/leads-api), and
[entity links](https://www.amocrm.ru/developers/content/crm_platform/entity-links-api).
