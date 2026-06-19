# CRM Cleanup — Solutions
*Companion to `dead-code-audit-2026-06-18.md`*
*Organized into 4 sprints by effort and risk. Do them in order.*

---

## Sprint A — Safe Deletes
*Estimated effort: 2–3 hours. Zero risk — pure removal.*

### A1. Delete 5 dead frontend screens
Delete these files entirely:
```
src/app/register.tsx
src/app/verify-otp.tsx
src/app/join-company.tsx
src/app/contacts/import.tsx
src/app/contact/[id]/messages.tsx
```
Also remove their `Stack.Screen` registrations in `src/app/_layout.tsx`.
Remove `pendingVerification` state from `userStore.ts` since it only served `verify-otp`.
Remove `register` action from `userStore.ts` and its type in the interface.

### A2. Delete 35+ dead backend routes
In each routes file, delete only the listed route registrations (not the whole file). Also delete the corresponding controller method if it has no other callers.

**`routes/analytics.ts`** — delete everything except `GET /dashboard`:
Remove: `/funnel`, `/conversion-rates`, `/stage-duration`, `/lead-sources`, `/win-loss`, `/revenue`, `/team-activity`, `/rep-performance`, `/export`, `/export/:job_id/status`, `/export/:job_id/download`
Delete matching `controllers/analytics.ts` handlers: `getFunnel`, `getConversionRates`, `getStageDuration`, `getLeadSources`, `getWinLoss`, `getRevenue`, `getTeamActivity`, `getRepPerformance`, `exportReport` (the 900+ line reimplementation).

**`routes/deals.ts`** — delete pipeline management routes:
Remove: `POST /pipelines`, `GET/PATCH/DELETE /pipelines/:id`, `GET/POST /pipelines/:id/stages`, `PATCH/DELETE /stages/:id`, `DELETE /:id`, `POST /stale/evaluate`

**`routes/contacts.ts`** — delete:
Remove: `DELETE /:id`, `GET /:id/messages`, `GET /:id/events`, `POST /import`, `POST /import/phone`, `POST /transcribe-voice`, `POST /bulk-tag`, `POST /:id/merge`
Delete matching controller methods: `archive`, `getMessages`, `getCalendarEvents`, `importFromPhone`, `transcribeVoice`, `bulkTag`, `merge`, `_extractVoiceFields`

**`routes/messages.ts`** — delete: `GET /`, `POST /`, `GET /:id`, `POST /email`
Delete matching controller: `broadcastMessageIfAvailable`

**`routes/auth.ts`** — delete: `GET /onboarding`, `PATCH /onboarding`
Delete matching controller methods: `getOnboarding`, `updateOnboarding` in `controllers/auth.ts`

**`routes/tasks.ts`** — delete: `GET /overdue`, `POST /:id/start`

**`routes/workflows.ts`** — delete: `GET /:id/runs`

**`routes/captures.ts`** — delete: `POST /:id/create-contact`

**`routes/onboarding.ts`** — delete: `POST /example-data`, `DELETE /example-data`

**`routes/notifications.ts`** — delete: `POST /send`

### A3. Delete dead backend functions
```
backend/api/controllers/chat.ts        — delete dmChannel()
backend/api/controllers/messages.ts   — delete broadcastMessageIfAvailable()
backend/api/controllers/contacts.ts   — delete _extractVoiceFields()
backend/config/market.ts              — delete getMarketProfile(); remove all profile fields
                                        except currency; inline it at the one callsite
```

### A4. Delete dead frontend functions and store actions
```
src/utils/sentry.ts          — delete captureError export
src/utils/backgroundSync.ts  — delete runSync; delete the three wrong invalidateQueries calls
src/utils/offlineQueue.ts    — delete dequeue export; delete clear export
src/i18n/index.ts            — delete changeAppLanguage export; delete AppLanguage re-export from storage.ts
src/store/userStore.ts       — delete register action and PendingVerification type
src/store/chatStore.ts       — delete disconnect action; delete clearChannel action
src/store/syncStore.ts       — delete setOffline action; delete offline field
```

### A5. Delete dead state fields
```
src/store/chatStore.ts          — delete connected field
src/store/taskScopeStore.ts     — delete hydrated field
src/store/dealsStore.ts         — delete snapshot variable in moveDeal
src/store/onboardingStore.ts    — delete dismissed_tooltips and example_data_loaded fields
```

### A6. Remove dead React imports from 18 files
Remove `import React from 'react'` (and `import React, {` → `import {`) from:
`contact/[id].tsx`, `contact/edit/[id].tsx`, `contact/scan-card.tsx`, `contact/import-csv.tsx`,
`contact/[id]/messages.tsx`, `contacts/import.tsx`, `deal/[id].tsx`, `deal/edit/[id].tsx`,
`task/[id].tsx`, `task/edit/[id].tsx`, `calendar/CalendarScreen.tsx`, `calendar/[id].tsx`,
`calendar/edit/[id].tsx`, `calendar/new.tsx`, `import/telegram.tsx`, `import/vcard.tsx`,
`import/whatsapp.tsx`, `import/bitrix24.tsx`

Also remove unused `Modal`, `TextInput` from `src/app/contact/[id].tsx:2`.
Remove unused `TgContact` import from `backend/api/controllers/imports.ts:3`.

### A7. Dead i18n cleanup

**Add 4 missing keys** to both `en.ts` and `ru.ts` (these are referenced in code but absent):
```typescript
auth: {
  joinTitle: 'Join your team',       // ru: 'Присоединиться к команде'
  joinSubtitle: 'Enter your code',   // ru: 'Введите код'
  tempPassword: 'Temporary password', // ru: 'Временный пароль'
},
errors: {
  unknown: 'Something went wrong',   // ru: 'Что-то пошло не так'
}
```

**Delete ~60 unused keys** from both locale files. The full list is in the audit report.
Safe to bulk-delete entire dead sections: `tabs.dashboard`, `tabs.messages`, `tabs.deals`,
`messages.*`, `messaging.*`, `dashboard.*`, and most of the listed keys under `auth.*`, `contacts.*`, `deals.*`, `tasks.*`, `calendar.*`, `settings.*`, `common.*`, `errors.*`, `workflows.*`, `captures.*`.

Verify each key with `grep -r "t('" src/` before deleting.

### A8. Fix dead config / env vars
```typescript
// backend/config/security.ts — remove these two validations:
REDIS_URL       // no Redis client exists; remove entirely or leave as optional undocumented
EXPO_PUBLIC_API_URL  // backend never reads this; it's a frontend-only var

// backend/services/db.ts:13 — YANDEX_DB_SSL_CA
// Either wire it into the Prisma datasource as sslCert, or remove the log warning.
// Current state (log-only) gives false confidence. Pick one.
```

### A9. Fix duplicate SIGTERM/SIGINT in `backend/index.ts`
```typescript
// Replace the two handlers with one:
const shutdown = async () => {
  await fastify.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
```

### A10. Minor UI fixes
```typescript
// src/screens/LoginScreen.tsx
// Either implement forgot-password or remove the Pressable:
// <TouchableOpacity onPress={() => router.push('/forgot-password' as never)}>
// Delete COLORS.terracotta constant (line ~30)

// src/components/ContactCard.tsx
// Delete COLORS.cream constant (line ~42)

// src/screens/RegisterScreen.tsx
// Remove KeyboardAvoidingView wrapper — screen has no inputs
```

---

## Sprint B — Small Structural Fixes
*Estimated effort: 1 day. Targeted changes, low risk.*

### B1. Cache S3Client at module level
`backend/services/storage.ts` currently constructs a new `S3Client` on every operation.

```typescript
// Replace getClient() function with a module-level singleton:
const client = new S3Client({
  region: process.env.S3_REGION ?? 'ru-central1',
  endpoint: process.env.S3_ENDPOINT ?? 'https://storage.yandexcloud.net',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
});

// Use client directly in generateUploadUrl and deleteFile.
// Delete getClient().
```

### B2. Shared auth preHandler — replace 15 inline copies
Create `backend/api/preHandlers.ts`:
```typescript
import { FastifyRequest, FastifyReply } from 'fastify';

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await request.jwtVerify();
}
```

In all 15 route files, replace the locally defined `authenticate` function with:
```typescript
import { authenticate } from '../preHandlers';
```

Delete the 15 local definitions.

### B3. Shared org-membership guards
Create `backend/services/db-guards.ts`:
```typescript
import { db } from './db';
import { AppError } from './errors'; // or however you throw 404s

export async function assertContactBelongsToOrg(id: string, orgId: string) {
  const row = await db.contact.findFirst({ where: { id, organization_id: orgId }, select: { id: true } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Contact not found');
}

export async function assertUserBelongsToOrg(id: string, orgId: string) {
  const row = await db.user.findFirst({ where: { id, organization_id: orgId }, select: { id: true } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'User not found');
}

export async function assertDealBelongsToOrg(id: string, orgId: string) {
  const row = await db.deal.findFirst({ where: { id, organization_id: orgId }, select: { id: true } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Deal not found');
}
```

Replace the 9 inline copies across `controllers/calendar.ts`, `deals.ts`, `messages.ts`, `tasks.ts`, `contacts.ts`.

### B4. Shared paginate helper
Create `backend/services/db-paginate.ts`:
```typescript
export async function paginate<T>(
  count: () => Promise<number>,
  find: () => Promise<T[]>,
): Promise<{ data: T[]; total: number }> {
  const [total, data] = await Promise.all([count(), find()]);
  return { data, total };
}
```

Replace the 8 manual `Promise.all([db.X.count(...), db.X.findMany(...)])` blocks across the controllers with `paginate(() => db.X.count(...), () => db.X.findMany(...))`.

### B5. Fix duplicate SHA-256 hashing
Create `backend/services/crypto.ts`:
```typescript
import { createHash } from 'crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
```

Replace the two inline implementations in `services/sessions.ts:31` and `services/verification.ts:10`.

### B6. Frontend — centralize auth token lookup
`src/utils/api.ts` is already imported by all stores. Add one helper:
```typescript
// src/utils/api.ts
import * as SecureStore from 'expo-secure-store';

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await SecureStore.getItemAsync('crm_auth_token');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` };
}
```

Replace the 6 inline `SecureStore.getItemAsync('crm_auth_token')` calls in `chatStore`, `dealsStore`, `pipelinesStore`, `backgroundSync`, `offlineQueue` with `await authHeaders()`.
`userStore` can read from its own Zustand state since it holds `token` in memory.

### B7. Fix or remove the offline branch
`syncStore.setOffline` is never called, making `SyncStatusBar`'s offline UI permanently unreachable. Two options:

**Option A (wire it up):** In `src/utils/network.ts`, subscribe to `NetInfo` and call `setOffline` when `isConnected === false`. Then `useNetworkStatus` becomes useful again instead of dead.

**Option B (remove it):** Delete `offline` field from `syncStore`, delete the offline UI branch in `SyncStatusBar`, rename `OfflineBanner` to `SyncStatusBar` at all callsites (it's already just an alias).

Pick A if you want offline UX. Pick B if the offline state is aspirational and you want clarity now.

### B8. Consolidate duplicate session revocation
`backend/services/sessions.ts` has two revocation methods that differ only by selector. Extract:
```typescript
async function revokeWhere(where: Prisma.SessionWhereInput): Promise<void> {
  await db.session.updateMany({ where, data: { revoked_at: new Date() } });
}

export async function revokeSession(sessionId: string) {
  return revokeWhere({ id: sessionId });
}
export async function revokeAllUserSessions(userId: string) {
  return revokeWhere({ user_id: userId, revoked_at: null });
}
```

### B9. Fix password-strength schema duplication in `routes/auth.ts`
```typescript
// Define once at the top of the file:
const PasswordSchema = z.string()
  .min(8)
  .regex(/[A-Z]/, 'Must contain uppercase')
  .regex(/[0-9]/, 'Must contain number');

// Reuse in all three places that currently copy the same z.string().min(8)... block.
```

### B10. Rename OfflineBanner
`src/components/OfflineBanner.tsx` is a one-line misleading alias. Either:
- Delete it and update the two import sites to import `SyncStatusBar` directly, or
- Expand it with real offline-specific behavior (pairs with B7 Option A).

---

## Sprint C — Pattern Consolidation
*Estimated effort: 2–3 days. Medium refactors, each self-contained.*

### C1. Frontend create/edit mutation hooks
The create-form and edit-form flows are copy-pasted 4 times each across the CRM entity screens. Extract two hooks:

```typescript
// src/hooks/useEntityMutation.ts

export function useCreateMutation<T>(options: {
  endpoint: string;
  validate: (data: T) => string | null;   // returns error message or null
  buildPayload: (data: T) => unknown;
  onSuccess: (id: string) => void;
}) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (data: T) => {
    const validationError = options.validate(data);
    if (validationError) { setError(validationError); return; }
    setLoading(true);
    try {
      // sendOrQueue logic
      const result = await sendOrQueueMutation(options.endpoint, options.buildPayload(data));
      options.onSuccess(result.id);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return { submit, error, loading, clearError: () => setError('') };
}

export function useEditMutation<T>(options: {
  endpoint: string;
  buildPayload: (data: T) => unknown;
  onSuccess: () => void;
}) { /* same pattern */ }
```

Replace the 4 create-form copies in `contact/new`, `deal/new`, `task/new`, `calendar/new` and the 4 edit copies.

### C2. Contact search hook
The debounce/fetch/reset contact-lookup is copy-pasted 5 times across new/edit screens:

```typescript
// src/hooks/useContactSearch.ts
export function useContactSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContactSummary[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const data = await searchContacts(query);
      setResults(data);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  return { query, setQuery, results, clearResults: () => setResults([]) };
}
```

Replace the 5 inline copies in `deal/new`, `task/new`, `deal/edit/[id]`, `task/edit/[id]`, `calendar/edit/[id]`.

### C3. Merge import/vcard and import/whatsapp into one screen
`vcard.tsx` and `whatsapp.tsx` share ~80% of their code. Create a generic file-import screen:

```typescript
// src/app/import/FileImportScreen.tsx
interface ImportConfig<T> {
  title: string;
  subtitle: string;
  mimeTypes: string[];
  color: string;
  parse: (content: string) => T[];
  endpoint: string;
  renderPreviewItem: (item: T, selected: boolean, onToggle: () => void) => ReactNode;
  getKey: (item: T) => string;
}

export default function FileImportScreen<T>({ config }: { config: ImportConfig<T> }) {
  // One implementation of: pick → parse → preview → select/deselect → import → done
}
```

Then:
```typescript
// src/app/import/vcard.tsx — becomes 30 lines:
export default function VCardImportScreen() {
  return <FileImportScreen config={{ title: 'Файл контактов', mimeTypes: ['text/vcard', ...],
    color: '#8B5CF6', parse: parseVCards, endpoint: '/import/vcard',
    getKey: (_, i) => String(i), renderPreviewItem: renderVCard }} />;
}
```

The 4 import screens also share identical `StyleSheet` blocks — move those into `FileImportScreen`.
`telegram.tsx` and `bitrix24.tsx` are different enough (multi-step auth flow, webhook input) to stay as-is, but they can import shared `styles` from a `importStyles.ts` constants file.

### C4. Audit log fetch hook
Three detail screens (`contact/[id]`, `deal/[id]`, `task/[id]`) duplicate the audit-log fetch:

```typescript
// src/hooks/useAuditLog.ts
export function useAuditLog(entityType: 'contact' | 'deal' | 'task', id: string) {
  return useQuery({
    queryKey: ['audit-log', entityType, id],
    queryFn: () => fetchAuditLog(entityType, id),
  });
}
```

### C5. Consolidate onboarding into one system
Currently two systems exist: `userStore.completeOnboarding()` + the `onboardingStore` + `OnboardingWalkthrough` component all track overlapping state.

- `onboardingStore.dismissed_tooltips` and `example_data_loaded` are never read — delete them.
- `OnboardingWalkthrough` uses `onboardingStore` for step state; `src/app/onboarding.tsx` uses local state — merge so `onboarding.tsx` uses `onboardingStore`.
- There are two separate backend API paths for onboarding completion (`auth.ts:485` and `controllers/onboarding.ts:31`). Delete the one in `auth.ts` (it's already flagged dead); keep the dedicated `/onboarding` controller. Ensure `userStore.completeOnboarding()` calls the dedicated route.

### C6. Consolidate header extraction into one place
`services/audit.ts:47` and `services/sessions.ts:27` both extract request headers the same way. Move to `backend/services/request-utils.ts`:
```typescript
export function extractClientInfo(request: FastifyRequest) {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}
```

### C7. Fix duplicate push notification logic
`services/notificationEngine.ts:261` and `services/scheduler.ts:41` both look up push tokens, send, and clear invalid tokens. Extract:
```typescript
// backend/services/push.ts (already exists — consolidate into it)
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  // single implementation: lookup token, send, clear invalid
}
```

`notificationEngine` and `scheduler` both call `sendPushToUser(userId, payload)`.

### C8. Fix `conversionRates` N+1
`controllers/analytics.ts:690` — one deal query per pipeline:
```typescript
// Before: pipelines.map(p => db.deal.findMany({ where: { pipeline_id: p.id } }))

// After: one query
const deals = await db.deal.findMany({
  where: { organization_id: orgId, ...dateFilter },
  select: { pipeline_id: true, status: true, stage_id: true, ... },
});
const byPipeline = Map.groupBy(deals, d => d.pipeline_id);
// then iterate pipelines over the in-memory map
```

### C9. Fix manager cycle detection N+1
`controllers/auth.ts:752` — one query per hierarchy level:
```typescript
// Replace iterative query with one recursive CTE:
const result = await db.$queryRaw`
  WITH RECURSIVE chain AS (
    SELECT id, manager_id FROM users WHERE id = ${newManagerId}
    UNION ALL
    SELECT u.id, u.manager_id FROM users u INNER JOIN chain c ON u.id = c.manager_id
  )
  SELECT id FROM chain WHERE id = ${userId}
  LIMIT 1
`;
const hasCycle = result.length > 0;
```

---

## Sprint D — Architecture Cleanup
*Estimated effort: 1 week. Big structural changes — do after A/B/C are merged.*

### D1. Split contacts controller (1,178 lines)
Extract into 4 focused files:

| New file | Responsibility | Methods |
|---|---|---|
| `controllers/contacts.ts` | CRUD only | `list`, `getById`, `create`, `update` |
| `services/contact-import.ts` | CSV, phone import | `importCsv`, previously `importFromPhone` |
| `services/contact-recognition.ts` | OCR, speech | `scanBusinessCard` (keep if used; `transcribeVoice` is dead) |
| `services/contact-bulk.ts` | Bulk ops | `bulkAssign`, `bulkArchive` |

Timeline construction (`getActivity`) moves to `services/contact-timeline.ts`. The controller thin-routes to these services.

### D2. Extract analytics report data functions
`controllers/analytics.ts` currently has 5 live report handlers and `exportReport` that duplicates all 5.

Extract one data function per report:
```typescript
// backend/services/analytics-reports.ts
export async function getFunnelData(orgId, filters): Promise<FunnelData> { ... }
export async function getRevenueData(orgId, filters): Promise<RevenueData> { ... }
export async function getTeamActivityData(orgId, filters): Promise<TeamActivityData> { ... }
export async function getWinLossData(orgId, filters): Promise<WinLossData> { ... }
export async function getLeadSourcesData(orgId, filters): Promise<LeadSourcesData> { ... }
```

If you bring the export routes back (Sprint A removed them as dead), `exportReport` becomes:
```typescript
const data = await reportFns[body.report](orgId, filters);
return body.format === 'csv' ? toCsv(data) : toSimplePdf(data);
```

### D3. Extract Yandex calendar sync service
`controllers/calendar.ts` is 990 lines mixing CRUD with full OAuth/CalDAV implementation. Extract:
```typescript
// backend/services/yandex-calendar.ts
export async function initiateYandexOAuth(userId, orgId): Promise<string> { ... }
export async function handleOAuthCallback(code, state): Promise<void> { ... }
export async function syncYandexEvents(userId, orgId): Promise<void> { ... }
export async function handleYandexWebhook(body): Promise<void> { ... }
```

`controllers/calendar.ts` keeps only CRUD. The 4 Yandex routes call the service directly.

### D4. Fix MCP drift — extract domain services
This is the most important structural fix. Currently:
- 30 MCP tools are hand-written copies of controllers
- They've drifted: missing auth hierarchy, encryption, audit logs

**Pattern:** Extract domain functions that both HTTP controllers and MCP tools call:
```typescript
// backend/services/contact-domain.ts
export async function getContactForUser(
  contactId: string,
  orgId: string,
  requesterId: string,
): Promise<DecryptedContact> {
  // visibility check, org scoping, decryption, audit log — one canonical implementation
}
```

HTTP controller:
```typescript
ContactsController.getById = async (request, reply) => {
  const contact = await getContactForUser(params.id, request.user.org_id, request.user.sub);
  reply.send({ data: contact });
};
```

MCP tool:
```typescript
get_contact: async ({ contact_id }, context) => {
  return getContactForUser(contact_id, context.org_id, context.user_id);
}
```

Roll out one domain at a time — contacts first (highest complexity), then deals, then tasks. The MCP layer becomes thin wrappers. Drift becomes impossible.

### D5. Consolidate Bitrix24 import
`services/importBitrix24.ts` mixes API pagination, mapping, persistence, counters, and placeholder creation. Extract a generic paginator:
```typescript
// backend/services/bitrix-paginator.ts
export async function* paginateBitrix<T>(
  fetch: (start: number) => Promise<{ result: T[]; next?: number; total: number }>,
): AsyncGenerator<T[]> {
  let start = 0;
  while (true) {
    const page = await fetch(start);
    yield page.result;
    if (!page.next || page.result.length === 0) break;
    start = page.next;
  }
}
```

The two nearly-identical pagination loops in `importBitrix24.ts:63` and `:118` become `for await (const batch of paginateBitrix(...))`.

### D6. Scheduler N+1 batching
`backend/services/scheduler.ts:152` has 5 near-identical blocks: fetch candidates → loop → N+1 fetch context + user.

Batch the recipient resolution:
```typescript
// Instead of: candidates.map(c => sendNotificationToUser(c.assigned_to, ...))
// Do:
const userIds = [...new Set(candidates.map(c => c.assigned_to))];
const users = await db.user.findMany({
  where: { id: { in: userIds }, organization_id: orgId },
  select: { id: true, push_token: true, language: true },
});
const userMap = new Map(users.map(u => [u.id, u]));
// then use userMap.get(c.assigned_to) inside the loop
```

---

## Execution Order

```
Sprint A  →  Sprint B  →  Sprint C  →  Sprint D
(delete)     (helpers)    (hooks)      (services)
  2–3 h       1 day       2–3 days      1 week
```

Each sprint leaves the app in a working state. A and B are safe to ship independently. C and D should be reviewed together since they touch the same files.

**Start with Sprint A.** It removes ~35 dead routes, 5 dead screens, 14 dead functions, 60 dead i18n keys, and dead React imports — purely subtractive, no logic change, and it shrinks the surface area for every subsequent sprint.
