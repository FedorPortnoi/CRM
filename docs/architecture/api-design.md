# API Design

## Conventions

**Base URL:** `https://api.yourcrm.com/api/v1`

All endpoints:
- Return JSON with a consistent envelope: `{ data, meta, error }`
- Require `Authorization: Bearer <access_token>` header (except `/auth/*`)
- Accept `Content-Type: application/json`
- Return HTTP status codes semantically (200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500)

### Response Envelope

```json
// Success (single)
{ "data": { "id": "...", ... }, "meta": {} }

// Success (list)
{ "data": [...], "meta": { "total": 150, "page": 1, "per_page": 50, "pages": 3 } }

// Error
{ "error": { "code": "CONTACT_NOT_FOUND", "message": "Contact not found", "details": {} } }
```

### Pagination
All list endpoints support: `?page=1&per_page=50&sort=created_at&order=desc`

### Filtering
Contacts/Deals support: `?status=active&assigned_to=<user_id>&tag=vip&q=<search_term>`

### Versioning
URI versioning (`/api/v1`). Breaking changes increment the version. Non-breaking additions are backwards-compatible within a version.

---

## Authentication Endpoints

```
POST   /auth/register          Create organization + owner account
POST   /auth/login             Authenticate, get access + refresh tokens
POST   /auth/refresh           Exchange refresh token for new access token
POST   /auth/logout            Revoke refresh token
POST   /auth/forgot-password   Send reset email
POST   /auth/reset-password    Set new password with reset token
GET    /auth/me                Get current user profile
PATCH  /auth/me                Update current user profile
```

---

## Contacts

```
GET    /contacts               List contacts (paginated, filterable, searchable)
POST   /contacts               Create contact
GET    /contacts/:id           Get contact by ID
PATCH  /contacts/:id           Update contact fields
DELETE /contacts/:id           Archive contact (soft delete)

GET    /contacts/:id/activity  Get full activity log for contact
GET    /contacts/:id/deals     Get all deals for contact
GET    /contacts/:id/tasks     Get all tasks for contact
GET    /contacts/:id/messages  Get message history for contact
GET    /contacts/:id/events    Get calendar events for contact

POST   /contacts/import        Bulk import (CSV, phone contacts payload)
POST   /contacts/bulk-assign   Assign multiple contacts to a team member
POST   /contacts/bulk-tag      Add/remove tags from multiple contacts
```

---

## Deals / Sales Pipeline

```
GET    /deals                  List deals (filterable by stage, pipeline, status)
POST   /deals                  Create deal
GET    /deals/:id              Get deal by ID
PATCH  /deals/:id              Update deal
PATCH  /deals/:id/stage        Move deal to a different stage
POST   /deals/:id/won          Mark deal as won
POST   /deals/:id/lost         Mark deal as lost (with reason)
DELETE /deals/:id              Archive deal

GET    /pipelines              List all pipelines for organization
POST   /pipelines              Create pipeline
GET    /pipelines/:id          Get pipeline with stages and deal counts
PATCH  /pipelines/:id          Update pipeline
DELETE /pipelines/:id          Delete pipeline (must not have active deals)

GET    /pipelines/:id/stages   List stages
POST   /pipelines/:id/stages   Create stage
PATCH  /stages/:id             Update stage (name, position, color)
DELETE /stages/:id             Delete stage (must be empty)
```

---

## Tasks

```
GET    /tasks                  List tasks (filter by assignee, status, due date)
POST   /tasks                  Create task
GET    /tasks/:id              Get task
PATCH  /tasks/:id              Update task
POST   /tasks/:id/complete     Mark task as completed
DELETE /tasks/:id              Cancel task

GET    /tasks/today            Tasks due today for current user
GET    /tasks/overdue          Overdue tasks for current user
```

---

## Messages

```
GET    /messages               List messages for org (filterable by contact)
POST   /messages/sms           Send SMS to a contact (via Twilio)
POST   /messages/in-app        Send in-app message to contact
GET    /messages/:contact_id   Conversation history with a contact
POST   /messages/:id/read      Mark message as read

WebSocket: wss://api.yourcrm.com/ws
  Event: message.received      Real-time inbound message notification
  Event: message.status        Delivery status update
```

---

## Calendar / Appointments

```
GET    /calendar/events        List events (filterable by date range, attendee)
POST   /calendar/events        Create appointment
GET    /calendar/events/:id    Get event
PATCH  /calendar/events/:id    Update event
DELETE /calendar/events/:id    Cancel event

GET    /calendar/availability  Get team availability for a date range
POST   /calendar/sync/google   Initiate Google Calendar OAuth flow
POST   /calendar/sync/apple    Configure Apple Calendar sync
GET    /calendar/sync/status   Check sync health
```

---

## Analytics

```
GET    /analytics/funnel            Full funnel conversion data (by pipeline, date range)
GET    /analytics/conversion-rates  Stage-by-stage conversion rates
GET    /analytics/stage-duration    Avg time deals spend per stage
GET    /analytics/lead-sources      Deals grouped by source
GET    /analytics/win-loss          Win/loss breakdown with reasons
GET    /analytics/revenue           Revenue report (monthly, quarterly, custom range)
GET    /analytics/team-activity     Activity summary per team member
GET    /analytics/dashboard         Home dashboard aggregate metrics
```

---

## Sync (Offline Support)

```
GET    /sync/delta?since={iso_timestamp}
       Returns all changes (creates, updates, deletes) since the given timestamp
       Response includes: contacts[], deals[], tasks[], messages[], events[]

POST   /sync/push
       Send a batch of local mutations made while offline
       Server validates, applies, and returns final server state + conflict resolutions
```

---

## Users & Organization

```
GET    /users                  List org members
POST   /users/invite           Invite a new team member
GET    /users/:id              Get user profile
PATCH  /users/:id              Update user
DELETE /users/:id              Deactivate user

GET    /organization           Get org settings
PATCH  /organization           Update org settings
GET    /organization/billing   Get subscription/billing info
```

---

## Files / Attachments

```
POST   /attachments            Upload file (multipart/form-data), get signed S3 URL
GET    /attachments/:id        Get attachment metadata
DELETE /attachments/:id        Delete attachment
```

---

## Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `UNAUTHORIZED` | 401 | Missing or invalid JWT |
| `FORBIDDEN` | 403 | Valid JWT but wrong org/role |
| `NOT_FOUND` | 404 | Resource does not exist in this org |
| `CONFLICT` | 409 | Duplicate email, slug, etc. |
| `VALIDATION_ERROR` | 422 | Request body failed Zod schema |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Rate Limits

- Default: 100 requests / minute per user
- Bulk import endpoints: 10 requests / minute per org
- SMS send: 60 per hour per org (Twilio-enforced upstream as well)
- Analytics: 30 requests / minute (queries are expensive)
