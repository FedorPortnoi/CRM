---
tags: [journal, day-4, sprint-2, tasks, backend]
status: complete
related: ["Sprint Log", "Task Management", "API Design", "Decision Log"]
created: 2026-05-03
---

# Day 4 — May 3, 2026

## What Happened Today

Short session focused entirely on one deliverable: the tasks controller. All 9 handlers written, audited, one defect found and fixed, vault updated, and the project's first git commit pushed.

---

## Sprint 2 — Task S2-1: Tasks Controller

### What Was Built

`backend/api/controllers/tasks.ts` — the first full controller of Sprint 2.

Nine handlers, all org-scoped, all typed (zero `any`):

| Handler | Route | Notes |
|---------|-------|-------|
| `list` | GET /api/v1/tasks | Filter + paginate; findMany + count in parallel |
| `create` | POST /api/v1/tasks | Injects org_id + created_by from JWT |
| `getById` | GET /api/v1/tasks/:id | findFirst with org scope |
| `update` | PATCH /api/v1/tasks/:id | 422 guard if task is cancelled |
| `complete` | POST /api/v1/tasks/:id/complete | Toggle: done↔pending |
| `startProgress` | POST /api/v1/tasks/:id/start | pending→in_progress only |
| `cancel` | DELETE /api/v1/tasks/:id | Soft delete: status='cancelled' |
| `dueToday` | GET /api/v1/tasks/today | UTC midnight range |
| `overdue` | GET /api/v1/tasks/overdue | due_date < now, not done/cancelled |

### Soft Delete Pattern

Tasks use `status: 'cancelled'` as the soft delete signal — consistent with the schema having no `deleted_at` column. The `cancel` handler calls `db.task.update` (not `db.task.delete`), so the row remains queryable for history.

### Complete Toggle

The `complete` handler implements a toggle: if the task is already `done`, it resets to `pending` and clears `completed_at`/`completed_by`. Otherwise it sets `done` and records `completed_at = new Date()` and `completed_by = request.user.sub`. A `cancelled` task returns 422 before any update is attempted.

### dueToday UTC Range

```ts
const startOfDay = new Date(now);
startOfDay.setUTCHours(0, 0, 0, 0);
const endOfDay = new Date(startOfDay);
endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
```

Using UTC methods ensures the "today" boundary is consistent regardless of the server's local timezone.

---

## Defect Found in Audit

The list handler originally had:

```ts
...(due_before && { due_date: { lt: new Date(due_before) } }),
...(due_after && { due_date: { gte: new Date(due_after) } }),
```

When both `due_before` and `due_after` are provided, the second spread overwrites the `due_date` key — the `lt` constraint disappears silently. Fixed to:

```ts
...((due_before || due_after) && {
  due_date: {
    ...(due_before && { lt: new Date(due_before) }),
    ...(due_after && { gte: new Date(due_after) }),
  },
}),
```

This is a class of bug worth watching for: spreading objects with the same key in sequence. The JavaScript spread operator does a shallow merge — last writer wins. When two independent conditions set the same key, they must be explicitly merged inside one object.

---

## Sprint 2 — Task S2-2: Messages Controller

### What Was Built

`backend/api/controllers/messages.ts` — the messages controller implementing an append-only interaction log.

Eight handlers:

| Handler | Route | Notes |
|---------|-------|-------|
| `list` | GET /api/v1/messages | Filterable by contact, channel, direction; paginated desc |
| `getConversation` | GET /api/v1/messages/conversation/:contact_id | Chronological asc; contact ownership verified |
| `sendSms` | POST /api/v1/messages/sms | Outbound SMS; status=pending (Twilio picks up async) |
| `sendInApp` | POST /api/v1/messages/in-app | Outbound in-app; status=sent |
| `logCall` | POST /api/v1/messages/call | Call log; channel=in_app; occurred_at→created_at |
| `markRead` | POST /api/v1/messages/:id/read | Sets status=read + read_at; never mutates body |
| `twilioInboundWebhook` | POST /api/v1/messages/webhooks/twilio/inbound | MVP stub; no HMAC; always 200 |
| `twilioStatusWebhook` | POST /api/v1/messages/webhooks/twilio/status | Updates status/delivered_at/error_message; always 200 |

### Key Design Decisions

**No `call` channel in schema.** `MessageChannel` enum is `sms | in_app | email`. Call logs are stored with `channel: in_app`. A future migration can add a `call` channel value when Twilio voice integration lands.

**occurred_at → created_at.** The Message model has no separate "occurred at" timestamp. When `occurred_at` is supplied to `logCall`, it is passed as `created_at` in the Prisma create, backdating the log entry to when the call actually happened.

**Contact ownership before create.** Every create handler first runs `db.contact.findFirst({ where: { id, organization_id } })`. Org mismatch returns 404 — prevents writing messages to contacts belonging to another org.

**Twilio webhook stubs.** Inbound and status webhooks are functional but skip HMAC signature validation (Sprint 3). Both are wrapped in try/catch and always return HTTP 200 — Twilio retries on non-200.

### Defect Found in Audit

`logCall` body could be `''` when `notes: ''` (Zod has no `.min(1)`) and `duration_seconds` absent — `??` only falls back on `null`/`undefined`, not empty string. Fixed:

```ts
const callBody = (durationPrefix + (notes?.trim() ?? '')).trim() || 'Call logged';
```

---

## First Git Commit

Today is also the project's first commit. The repo was initialized, `.gitignore` added (excludes `.env`, `node_modules`, build artifacts), and everything from Sprint 0 through Sprint 2 tasks controller was committed and pushed.

---

## Files Created This Session

| File | Type | Notes |
|------|------|-------|
| `backend/api/controllers/tasks.ts` | New | 9 handlers, 289 lines |
| `backend/api/controllers/messages.ts` | New | 8 handlers, 297 lines |
| `.gitignore` | New | Node.js + Expo + Prisma patterns |

## Files Updated This Session

| File | Change |
|------|--------|
| `brain/00 - Home.md` | Sprint 2 row added, priorities updated |
| `brain/05 - Decisions/Sprint Log.md` | Session 4 logged |

---

## What's Next (Sprint 2 Continuation)

1. `npm run backend:dev` — verify tasks + messages controllers compile
2. Manual smoke test: POST /api/v1/messages/sms, GET /api/v1/messages/conversation/:id
3. Deals remaining: getById, update, archive, moveStage, markWon, markLost

---

*Previous: [[Day 3]] — Phase 1 + Sprint 1 complete*
*Next: [[Day 5]] — Sprint 2 continuation: deals remaining endpoints*

See [[Sprint Log]] for the full task-by-task log.
