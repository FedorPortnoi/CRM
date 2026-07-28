/**
 * model-projection.ts
 *
 * The one place where data on its way to a language model gets shaped.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * `User.name` in this product holds an OPERATOR's ФИО. It is a second data
 * subject: it rides along in payloads that are about a CUSTOMER, and under the
 * repository's own privacy policy (§4.2.1, §4.2.2) it is a category where the
 * Operator is an independent controller rather than a processor acting on a
 * client's instruction. ФЗ-152 ч. 5 ст. 5 says the composition of processed
 * data must not exceed the purpose, and a summary of a customer does not need
 * the name of the person who happens to be assigned to them.
 *
 * The provider today is YandexGPT — domestic — so ст. 12 (трансграничная
 * передача) does NOT apply to this path yet. It begins to apply the moment
 * Wave A repoints backend/services/yandex-gpt.ts at OpenAI through
 * workers/openai-proxy/, and it does so with no diff in any tool file. That is
 * why this is worth fixing now rather than at the seam.
 *
 * ---------------------------------------------------------------------------
 * WHY HERE AND NOT AT THE SOURCE
 * ---------------------------------------------------------------------------
 * Two earlier fixes deleted the field outright: c456e0f took «Ответственный
 * менеджер: ФИО» off the contact-summary prompt, cb88ba9 dropped the whole
 * `include` from merge_contacts. Both could, because nothing else read the
 * field.
 *
 * Three remaining reads cannot be deleted, because the APP renders them:
 *
 *   - backend/services/contact-domain.ts  getContactForUser
 *   - backend/services/task-domain.ts     getTaskForUser
 *
 * Those functions are SHARED. The same `include: { assignee: { select: { id,
 * name } } }` feeds GET /contacts/:id and GET /tasks/:id — src/app/task/[id].tsx
 * renders `task.assignee.name`, src/app/task/edit/[id].tsx seeds its picker from
 * it — and also feeds the MCP tools get_contact and get_task. Deleting the
 * select fixes the model and breaks the user interface.
 *
 * So the cut is made where the two audiences diverge: the MCP boundary. Every
 * tool result is projected through `projectModelFacing()` on its way out of
 * `registerTool` in ./server.ts, which is the single door in front of BOTH
 * model transports — the stdio MCP server (`startMcp`) and the in-process
 * `invokeMcpTool` the assistant uses. The REST controllers never pass through
 * it, so the app keeps its names.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT redactToolResult()
 * ---------------------------------------------------------------------------
 * backend/services/assistant.ts already masks PII on tool results, and it is
 * structurally incapable of covering this one. It matches by key name, and its
 * REDACTED_KEYS / PII_KEY_FRAGMENTS are the encrypted contact columns only —
 * email, phone, mobile. A bare `name` key cannot be added to that set:
 * `keyLooksLikePii` is a SUBSTRING test, so a `name` fragment would eat
 * `pipeline_name`, `stage_name`, `first_name` and `last_name` across every
 * tool, and even an exact-match entry would eat the legitimate `pipeline: {
 * name }` and `stage: { name }` that get_deals and move_deal_to_stage return.
 * It is also in the wrong place: it sits inside the assistant, so the stdio
 * transport — equally model-facing — bypasses it entirely.
 *
 * This module makes the decision structurally instead: it does not ask whether
 * a string looks like a name, it asks whether the object it sits in is a USER.
 *
 * ---------------------------------------------------------------------------
 * HOW IT DECIDES
 * ---------------------------------------------------------------------------
 * Two rules, both keyed on structure rather than on content.
 *
 * 1. CONTAINER KEY. An object reached under a key that names a User relation —
 *    `assignee`, `creator`, `sender`, `owner`, … — loses every name-shaped key
 *    it holds. `USER_RELATION_KEYS` is the exhaustive set of User-typed
 *    relation fields in backend/prisma/schema.prisma, and a test parses that
 *    schema and fails when a new one appears, so the list cannot silently rot.
 *    `USER_CONTAINER_ALIASES` adds the plurals and hand-rolled synonyms a tool
 *    might invent for the same thing without a Prisma relation behind it.
 *
 * 2. ROW SHAPE. An object carrying a column that exists only on User —
 *    `username`, `password_hash`, `push_token`, … — is a User row wherever it
 *    was found, and loses the same keys. This catches the lazy
 *    `db.user.findMany()` with no `select` that a future tool might return
 *    directly.
 *
 * The identifier always survives. `assignee.id`, `assigned_to`, `user_id` are
 * uuids, not names; the model chains tool calls on them and stripping them
 * would break the agent loop for no privacy gain. Same argument cb88ba9 made.
 *
 * The name is DELETED, not masked. `redactToolResult` replaces a contact detail
 * with «[скрыто]» because "this contact has a phone, you just may not see it"
 * is information the model can legitimately report. Here there is nothing to
 * preserve: the assignee's existence is already stated by the id next to it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT COVERED
 * ---------------------------------------------------------------------------
 * A row whose `name` is at the top level with no user-ish container and no User
 * marker column — `{ user_id, name, win_rate }` — is not caught by either rule.
 * That is exactly the shape of `get_rep_performance`, where the name IS the
 * answer rather than a passenger, and it is an open product decision recorded
 * in docs/decisions/002-operator-names-in-model-facing-analytics.md. That tool
 * declares `{ operatorNames: 'allowed' }` at its registration so the exemption
 * is explicit and greppable rather than an accident of shape.
 *
 * The CONTACT's own `first_name` / `last_name` are untouched wherever they are
 * not inside a user container. They are the subject the model is asked about,
 * and that is a separate, already-made decision (see contact-ai.ts).
 */

/**
 * Every field in backend/prisma/schema.prisma whose type is `User`, `User?` or
 * `User[]`. An object found under one of these keys is a person.
 *
 * Kept in sync by tests/unit/backend/mcp-operator-name-projection.test.ts,
 * which re-derives the set from the schema file and fails if this list is
 * missing one. Add the new relation here when that test goes red — do not
 * relax the test.
 */
export const USER_RELATION_KEYS: ReadonlySet<string> = new Set([
  'assignee', // Contact / Deal / Task -> assigned_to
  'completer', // Task -> completed_by
  'creator', // Contact / Deal / Task / CalendarEvent / Pipeline / Workflow / ApiKey / WebhookEndpoint / EmailTemplate / Sequence -> created_by
  'enroller', // SequenceEnrollment -> enrolled_by
  'invitees', // User[] (reverse of inviter)
  'inviter', // User -> invited_by
  'manager', // User -> manager_id
  'owner', // Org -> owner_id
  'recipient', // Notification -> recipient_id
  'reports', // User[] (reverse of manager)
  'sender', // ChatMessage -> sender_id
  'uploader', // Attachment -> uploaded_by
  'user', // Session / ActivityLog / ChatReadReceipt / AssistantConversation / …
  'users', // Org -> User[]
]);

/**
 * Not Prisma relations — names a hand-written tool result could plausibly use
 * for the same thing. Cheap to carry, and each one is a leak that would
 * otherwise sail through rule 1.
 */
export const USER_CONTAINER_ALIASES: ReadonlySet<string> = new Set([
  'assignees',
  'assigned_user',
  'author',
  'authors',
  'actor',
  'colleague',
  'colleagues',
  'completed_by_user',
  'created_by_user',
  'creators',
  'employee',
  'employees',
  'managers',
  'member',
  'members',
  'operator',
  'operators',
  'owners',
  'recipients',
  'rep',
  'reps',
  'senders',
  'staff',
  'teammate',
  'teammates',
  'updated_by_user',
  'uploaders',
]);

/**
 * Keys dropped inside a user container. `User` only has `name` today; the rest
 * are here so a hand-assembled operator object cannot route around the one key
 * this module knows about.
 */
export const OPERATOR_NAME_KEYS: ReadonlySet<string> = new Set([
  'name',
  'full_name',
  'fullname',
  'display_name',
  'displayname',
  'first_name',
  'last_name',
  'middle_name',
  'patronymic',
  'fio',
]);

/**
 * Columns that exist on `User` and on no other model in the schema. One of
 * these present means the object IS a user row, whatever key it arrived under.
 * Verified against backend/prisma/schema.prisma by the same test that checks
 * USER_RELATION_KEYS; `role` and `avatar_url` are deliberately absent because
 * other models carry them too.
 */
export const USER_ROW_MARKER_KEYS: ReadonlySet<string> = new Set([
  'username',
  'password_hash',
  'push_token',
  'failed_login_count',
  'must_change_password',
  'must_change_email',
  'is_verified',
]);

// Tool results are Prisma rows: a handful of levels at most. The cap only
// exists so a pathological structure cannot blow the stack, and it matches the
// one redactToolResult uses.
const MAX_PROJECTION_DEPTH = 12;

/** Prisma hands back Date and Decimal instances; only literal objects are walked. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isUserContainerKey(key: string | undefined): boolean {
  if (key === undefined) return false;
  const lower = key.toLowerCase();
  return USER_RELATION_KEYS.has(lower) || USER_CONTAINER_ALIASES.has(lower);
}

function looksLikeUserRow(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => USER_ROW_MARKER_KEYS.has(key.toLowerCase()));
}

/**
 * `containerKey` is the key this value was found under. Array elements inherit
 * their array's key, so `reports: [{ name }]` and `report: { name }` are
 * treated identically.
 */
function project(value: unknown, containerKey: string | undefined, depth: number): unknown {
  if (Array.isArray(value)) {
    return depth >= MAX_PROJECTION_DEPTH
      ? null
      : value.map((entry) => project(entry, containerKey, depth + 1));
  }

  // Date / Decimal / anything with its own prototype is passed through: it
  // cannot hold a name and rewriting it would corrupt the value.
  if (!isPlainObject(value)) {
    return value;
  }

  if (depth >= MAX_PROJECTION_DEPTH) {
    return null;
  }

  const isUser = isUserContainerKey(containerKey) || looksLikeUserRow(value);

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isUser && OPERATOR_NAME_KEYS.has(key.toLowerCase())) {
      // Dropped, not blanked: the id sitting beside it already says an operator
      // is attached, so there is no fact left to preserve.
      continue;
    }
    out[key] = project(entry, key, depth + 1);
  }

  return out;
}

/**
 * Strip operator names out of a tool result, at any depth and in any shape.
 *
 * Applied once, by `registerTool` in ./server.ts, so every tool is covered the
 * day it is written and both model transports get the same treatment. A tool
 * that genuinely needs to emit an operator name has to say so at registration.
 */
export function projectModelFacing(result: unknown): unknown {
  return project(result, undefined, 0);
}
