/**
 * contact-ai.ts
 *
 * AI assistance for the contacts resource, backed by YandexGPT (see
 * ./yandex-gpt). Two capabilities live here:
 *
 *   1. summarizeContact()      — a short Russian-language read on the state of
 *                                the relationship plus one suggested next step.
 *   2. suggestContactFields()  — pulls first/last name, company and position out
 *                                of free text (a note, an email signature block)
 *                                and hands them back as a SUGGESTION. Nothing is
 *                                written to the contact; the user confirms.
 *
 * ---------------------------------------------------------------------------
 * PII MINIMIZATION (ФЗ-152 «О персональных данных», ст. 5 ч. 5 — the volume and
 * nature of processed personal data must not exceed the stated purpose)
 * ---------------------------------------------------------------------------
 * The model is an external processor. It gets the minimum that still lets it
 * write a useful summary: names, company, deal titles/values/stages, task
 * titles and activity headlines. It never gets email, phone or mobile.
 *
 * That is enforced structurally, not by convention:
 *   - the Prisma `select` below simply does not read `email`, `phone`, `mobile`
 *     or their blind-index columns, so the ciphertext never leaves Postgres and
 *     `decryptField` is never called on this path;
 *   - every free-text field that a human could have typed a contact detail into
 *     (notes, message bodies, task and meeting titles, and the caller-supplied
 *     autofill text) goes through `redactContactDetails()` first, which masks
 *     anything shaped like an address or a phone number.
 *
 * The autofill endpoint is the interesting case: the caller hands us a raw
 * signature block that very often contains an address and a phone. We still
 * redact it, because the model is only being asked for name/company/position —
 * sending the contact details as well would be exactly the excess ФЗ-152
 * prohibits, and masking them actually helps the model find the field
 * boundaries. Address/phone capture already has a local, deterministic path in
 * contact-recognition.ts and does not need a language model.
 *
 * ---------------------------------------------------------------------------
 * DEGRADATION
 * ---------------------------------------------------------------------------
 * The service account may not hold `ai.languageModels.user` yet, so every entry
 * point returns a discriminated result instead of throwing: an unconfigured or
 * unauthorized model becomes a structured SERVICE_NOT_CONFIGURED (503), a slow
 * one is abandoned after AI_TIMEOUT_MS (504), and anything else becomes
 * AI_REQUEST_FAILED (502). No path crashes the process and no path can hang a
 * request open indefinitely.
 */

import { TaskStatus } from '@prisma/client';
import { db } from './db';
import { DEFAULT_CURRENCY } from '../config/market';
import { canSeeUser, getAccessibleUserIds } from './visibility';
import { createCompletion } from './yandex-gpt';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard ceiling on how long a request will wait for the model. */
export const AI_TIMEOUT_MS = 20_000;

/**
 * Deadline handed to the YandexGPT client. Deliberately shorter than
 * AI_TIMEOUT_MS so that in the ordinary case the client aborts its own fetch
 * and returns a structured AI_TIMEOUT; the race below is the backstop for a
 * promise that wedges somewhere the client's own timer cannot reach.
 */
const AI_UPSTREAM_TIMEOUT_MS = 18_000;

const AI_TEMPERATURE = 0.2;
const AI_MAX_TOKENS = 800;

/** Longest free text the autofill endpoint accepts. Mirrored by the route schema. */
export const AUTOFILL_MAX_INPUT_CHARS = 4_000;

const MAX_DEALS = 10;
const MAX_TASKS = 10;
const MAX_ACTIVITIES = 10;
const MAX_NOTES_CHARS = 800;
const MAX_ACTIVITY_TEXT_CHARS = 200;

const AI_PROVIDER = 'yandexgpt';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContactAiRequester = {
  sub: string;
  org_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
};

export type GenerateTextResult =
  | { ok: true; text: string }
  | { ok: false; code: string; message: string };

export type GenerateTextFn = (prompt: string) => Promise<GenerateTextResult>;

/**
 * Injection seam. Production callers pass nothing and get the real YandexGPT
 * client; tests pass a stub so no unit test ever reaches the network.
 */
export type ContactAiDeps = {
  generateText?: GenerateTextFn;
  timeoutMs?: number;
  now?: () => Date;
};

export type ContactAiFailure = { ok: false; status: number; code: string; message: string };
export type ContactAiResult<T> = { ok: true; data: T } | ContactAiFailure;

export type ContactAiDealContext = {
  title: string;
  value: string | null;
  currency: string;
  status: string;
  stage: string | null;
  expected_close: string | null;
  next_action: string | null;
};

export type ContactAiTaskContext = {
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
};

export type ContactAiActivityContext = {
  kind: 'message' | 'meeting';
  at: string;
  text: string;
};

/**
 * Everything the model is allowed to see about a contact. Deliberately a flat,
 * PII-free projection rather than the Prisma row — if a field is not on this
 * type it cannot reach the prompt.
 */
export type ContactAiContext = {
  contact_id: string;
  display_name: string;
  company: string | null;
  type: string;
  status: string;
  source: string | null;
  tags: string[];
  owner_name: string | null;
  created_at: string | null;
  notes: string | null;
  deals: ContactAiDealContext[];
  tasks: ContactAiTaskContext[];
  activities: ContactAiActivityContext[];
  last_activity_at: string | null;
};

export type ContactSummary = {
  contact_id: string;
  summary: string;
  next_action: string | null;
  provider: string;
  generated_at: string;
  context_counts: { deals: number; tasks: number; activities: number };
  last_activity_at: string | null;
};

export type ContactFieldSuggestion = {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  position: string | null;
};

export type ContactAutofillResult = {
  suggestion: ContactFieldSuggestion;
  /** Always false. This endpoint never writes; the user confirms in the UI. */
  applied: false;
  provider: string;
  generated_at: string;
};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// Deliberately narrow so that ordinary numbers in prose — a deal value written
// out as "1 200 000", a year, a quantity — survive. Only genuinely phone-shaped
// runs are masked.
const PHONE_PATTERNS: RegExp[] = [
  // Russian national form: +7 / 8 followed by 10 digits in the usual groupings.
  /(?:\+7|(?<!\d)8)[\s().-]*\d{3}[\s().-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/g,
  // Any explicitly international number.
  /\+\d{1,3}[\s().-]*(?:\d[\s().-]*){7,14}\d/g,
  // A bare, unbroken run long enough to be a subscriber number.
  /(?<!\d)\d{10,15}(?!\d)/g,
];

export const EMAIL_MASK = '[email скрыт]';
export const PHONE_MASK = '[телефон скрыт]';

/**
 * Mask anything shaped like an email address or a phone number.
 *
 * Applied to every free-text value on its way into a prompt. Contact details
 * are not needed to describe a relationship or to read a name off a signature,
 * so under ФЗ-152 ст. 5 ч. 5 they must not be handed to an external model.
 */
export function redactContactDetails(value: string): string {
  let out = value.replace(EMAIL_PATTERN, EMAIL_MASK);
  for (const pattern of PHONE_PATTERNS) {
    out = out.replace(pattern, PHONE_MASK);
  }
  return out;
}

function clean(value: string | null | undefined, maxChars: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return null;
  }

  const redacted = redactContactDetails(collapsed);
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * ISO-8601 calendar date. Locale-neutral on purpose: the market profile governs
 * what a *user* sees, and nothing here is user-facing — inventing an en-US date
 * for the model would violate the same rule from the other side.
 */
function isoDate(value: unknown): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function isoInstant(value: unknown): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Prisma hands back a Decimal; a mocked db may hand back a number or a string. */
function decimalToString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function stringTags(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

/** The PII-free projection of a Contact row that this service reads. */
export type ContactAiRow = {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  type: string;
  status: string;
  source: string | null;
  tags: unknown;
  notes: string | null;
  created_at: Date | string | null;
  assigned_to: string | null;
  created_by: string | null;
  assignee?: { name: string | null } | null;
};

/**
 * Load the contact, enforcing BOTH tenant boundaries: `organization_id` on the
 * query (Prisma bypasses RLS) and the visibility cone for member/viewer.
 *
 * Returns null when the contact does not exist, belongs to another org, or sits
 * outside the requester's branch. All three collapse into the same 404 so the
 * endpoint cannot be used to probe for contacts the caller may not see.
 */
async function loadVisibleContact(
  contactId: string,
  requester: ContactAiRequester,
): Promise<ContactAiRow | null> {
  const contact = (await db.contact.findFirst({
    where: { id: contactId, organization_id: requester.org_id },
    // No email / phone / mobile / *_bidx. The ciphertext is not read at all, so
    // there is nothing on this path that could be decrypted into a prompt.
    select: {
      id: true,
      first_name: true,
      last_name: true,
      company: true,
      type: true,
      status: true,
      source: true,
      tags: true,
      notes: true,
      created_at: true,
      assigned_to: true,
      created_by: true,
      assignee: { select: { name: true } },
    },
  })) as ContactAiRow | null;

  if (!contact) {
    return null;
  }

  const accessibleIds = await getAccessibleUserIds({
    sub: requester.sub,
    org_id: requester.org_id,
    role: requester.role,
  });

  if (accessibleIds !== null) {
    const canSeeIt =
      canSeeUser(accessibleIds, contact.assigned_to) || canSeeUser(accessibleIds, contact.created_by);
    if (!canSeeIt) {
      return null;
    }
  }

  return contact;
}

/**
 * Assemble the PII-free projection handed to the model. Every query is
 * org-scoped in its own right rather than relying on the parent contact.
 */
export async function buildContactContext(
  contact: ContactAiRow,
  orgId: string,
): Promise<ContactAiContext> {
  const [deals, tasks, messages, events] = await Promise.all([
    db.deal.findMany({
      where: { contact_id: contact.id, organization_id: orgId },
      select: {
        title: true,
        value: true,
        currency: true,
        status: true,
        expected_close: true,
        next_action: true,
        stage: { select: { name: true } },
      },
      orderBy: { updated_at: 'desc' },
      take: MAX_DEALS,
    }),
    db.task.findMany({
      where: {
        contact_id: contact.id,
        organization_id: orgId,
        status: { not: TaskStatus.cancelled },
      },
      select: { title: true, status: true, priority: true, due_date: true },
      orderBy: { created_at: 'desc' },
      take: MAX_TASKS,
    }),
    db.message.findMany({
      where: { contact_id: contact.id, organization_id: orgId },
      select: { channel: true, direction: true, body: true, created_at: true },
      orderBy: { created_at: 'desc' },
      take: MAX_ACTIVITIES,
    }),
    db.calendarEvent.findMany({
      where: { contact_id: contact.id, organization_id: orgId },
      select: { title: true, start_time: true, status: true },
      orderBy: { start_time: 'desc' },
      take: MAX_ACTIVITIES,
    }),
  ]);

  const activityRows: Array<{ kind: 'message' | 'meeting'; at: Date; text: string }> = [
    ...(messages ?? []).map((m) => ({
      kind: 'message' as const,
      at: new Date(m.created_at as unknown as string),
      // Message bodies are the most likely place for a stray contact detail.
      text: `${m.channel ?? 'сообщение'} (${m.direction ?? '—'}): ${clean(m.body, MAX_ACTIVITY_TEXT_CHARS) ?? '—'}`,
    })),
    ...(events ?? []).map((e) => ({
      kind: 'meeting' as const,
      at: new Date(e.start_time as unknown as string),
      text: `${clean(e.title, MAX_ACTIVITY_TEXT_CHARS) ?? 'встреча'} (${e.status ?? '—'})`,
    })),
  ].filter((row) => !Number.isNaN(row.at.getTime()));

  activityRows.sort((a, b) => b.at.getTime() - a.at.getTime());
  const activities = activityRows.slice(0, MAX_ACTIVITIES);

  const displayName = [contact.first_name, contact.last_name]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ')
    .trim();

  return {
    contact_id: contact.id,
    display_name: displayName || contact.first_name || '—',
    company: clean(contact.company, 200),
    type: contact.type,
    status: contact.status,
    source: clean(contact.source, 100),
    tags: stringTags(contact.tags).slice(0, 20),
    owner_name: clean(contact.assignee?.name ?? null, 100),
    created_at: isoDate(contact.created_at),
    notes: clean(contact.notes, MAX_NOTES_CHARS),
    deals: (deals ?? []).map((d) => ({
      title: clean(d.title, 200) ?? '—',
      value: decimalToString(d.value),
      currency: d.currency ?? DEFAULT_CURRENCY,
      status: String(d.status),
      stage: clean(d.stage?.name ?? null, 100),
      expected_close: isoDate(d.expected_close),
      next_action: clean(d.next_action, 200),
    })),
    tasks: (tasks ?? []).map((t) => ({
      title: clean(t.title, 200) ?? '—',
      status: String(t.status),
      priority: String(t.priority),
      due_date: isoDate(t.due_date),
    })),
    activities: activities.map((a) => ({
      kind: a.kind,
      at: a.at.toISOString().slice(0, 10),
      text: a.text,
    })),
    last_activity_at: activities.length > 0 ? activities[0].at.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildSummaryPrompt(context: ContactAiContext): string {
  const lines: string[] = [];

  lines.push('Ты — ассистент менеджера по продажам в CRM. Проанализируй карточку клиента.');
  lines.push('Ответь СТРОГО одним JSON-объектом без markdown и без пояснений:');
  lines.push('{"summary": "...", "next_action": "..."}');
  lines.push('summary — 2–4 предложения на русском языке о состоянии отношений с клиентом.');
  lines.push('next_action — одно конкретное следующее действие менеджера, одной строкой.');
  lines.push('Опирайся только на приведённые данные, не придумывай факты.');
  lines.push('Контактные данные намеренно скрыты — не запрашивай и не упоминай их.');
  lines.push('');
  lines.push('ДАННЫЕ КЛИЕНТА:');
  lines.push(`Имя: ${context.display_name}`);
  if (context.company) lines.push(`Компания: ${context.company}`);
  lines.push(`Тип: ${context.type}; статус: ${context.status}`);
  if (context.source) lines.push(`Источник: ${context.source}`);
  if (context.tags.length > 0) lines.push(`Теги: ${context.tags.join(', ')}`);
  if (context.owner_name) lines.push(`Ответственный менеджер: ${context.owner_name}`);
  if (context.created_at) lines.push(`В базе с: ${context.created_at}`);
  if (context.notes) lines.push(`Заметки: ${context.notes}`);

  lines.push('');
  lines.push(`Сделки (${context.deals.length}):`);
  if (context.deals.length === 0) {
    lines.push('- нет');
  } else {
    for (const deal of context.deals) {
      const parts = [`статус ${deal.status}`];
      // Amount and ISO currency code, never a symbol — the market profile owns
      // presentation and this string is not presentation.
      if (deal.value) parts.push(`сумма ${deal.value} ${deal.currency}`);
      if (deal.stage) parts.push(`этап «${deal.stage}»`);
      if (deal.expected_close) parts.push(`ожидаемое закрытие ${deal.expected_close}`);
      if (deal.next_action) parts.push(`следующий шаг: ${deal.next_action}`);
      lines.push(`- «${deal.title}» — ${parts.join('; ')}`);
    }
  }

  lines.push('');
  lines.push(`Задачи (${context.tasks.length}):`);
  if (context.tasks.length === 0) {
    lines.push('- нет');
  } else {
    for (const task of context.tasks) {
      const parts = [`статус ${task.status}`, `приоритет ${task.priority}`];
      if (task.due_date) parts.push(`срок ${task.due_date}`);
      lines.push(`- «${task.title}» — ${parts.join('; ')}`);
    }
  }

  lines.push('');
  lines.push(`Последняя активность (${context.activities.length}):`);
  if (context.activities.length === 0) {
    lines.push('- нет');
  } else {
    for (const activity of context.activities) {
      lines.push(`- ${activity.at} ${activity.kind === 'message' ? 'сообщение' : 'встреча'}: ${activity.text}`);
    }
  }

  return lines.join('\n');
}

export function buildAutofillPrompt(redactedText: string): string {
  return [
    'Ты — парсер контактных данных в CRM. Из произвольного текста ниже извлеки поля карточки контакта.',
    'Ответь СТРОГО одним JSON-объектом без markdown и без пояснений:',
    '{"first_name": "...", "last_name": "...", "company": "...", "position": "..."}',
    'Если поле в тексте отсутствует — поставь null. Ничего не выдумывай и не переводи названия.',
    'Имя и фамилию верни в именительном падеже с заглавной буквы.',
    'Email и телефон в тексте скрыты и НЕ являются полями ответа — игнорируй их.',
    '',
    'ТЕКСТ:',
    redactedText,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Model response parsing
// ---------------------------------------------------------------------------

/**
 * Pull a JSON object out of a model reply. Tolerates ```json fences and any
 * prose the model wraps around the object.
 */
export function parseModelJson(text: string): Record<string, unknown> | null {
  const withoutFences = text.replace(/```(?:json)?/gi, '').trim();
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(withoutFences.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const EMPTY_ANSWERS = new Set(['', '-', '—', 'null', 'none', 'n/a', 'нет', 'неизвестно', 'не указано']);

function suggestionField(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (EMPTY_ANSWERS.has(collapsed.toLocaleLowerCase('ru-RU'))) {
    return null;
  }

  // A model that ignored the mask and echoed a contact detail back must not get
  // it into a suggested field either.
  const redacted = redactContactDetails(collapsed);
  if (redacted.includes(EMAIL_MASK) || redacted.includes(PHONE_MASK)) {
    return null;
  }

  return redacted.slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Model invocation
// ---------------------------------------------------------------------------

// Upstream codes that mean "this deployment cannot use the model", as opposed
// to "this particular call went wrong". Both an unset API key and a service
// account missing ai.languageModels.user land here (the latter comes back as
// AI_UNAUTHORIZED), and both are the operator's problem rather than the
// caller's — hence one honest 503.
const NOT_CONFIGURED_CODES = new Set([
  'SERVICE_NOT_CONFIGURED',
  'NOT_CONFIGURED',
  'AI_UNAUTHORIZED',
  'SERVICE_UNAUTHORIZED',
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'FORBIDDEN',
]);

// Upstream codes worth passing through with their own status rather than
// flattening into a generic 502.
const PASSTHROUGH_STATUSES: Record<string, number> = {
  AI_TIMEOUT: 504,
  AI_RATE_LIMITED: 429,
};

const TIMEOUT = Symbol('contact-ai-timeout');

/**
 * Adapter onto backend/services/yandex-gpt. That module speaks a richer,
 * provider-agnostic message/tool protocol; everything here is a single-turn
 * text completion, so the seam this service is written against stays a plain
 * `(prompt) => text` and the shape conversion happens once, here.
 */
async function generateWithYandexGpt(prompt: string): Promise<GenerateTextResult> {
  const result = await createCompletion({
    messages: [{ role: 'user', text: prompt }],
    temperature: AI_TEMPERATURE,
    max_tokens: AI_MAX_TOKENS,
    timeout_ms: AI_UPSTREAM_TIMEOUT_MS,
  });

  if (!result.ok) {
    return { ok: false, code: result.error.code, message: result.error.message };
  }

  return { ok: true, text: result.message.text ?? '' };
}

function resolveGenerator(deps: ContactAiDeps | undefined): GenerateTextFn {
  return deps?.generateText ?? generateWithYandexGpt;
}

/**
 * Run the model with a hard deadline. A hung upstream socket must never hold a
 * Fastify request open, so the race is unconditional even if the client
 * implements its own timeout.
 */
async function callModel(
  prompt: string,
  deps: ContactAiDeps | undefined,
): Promise<{ ok: true; text: string } | ContactAiFailure> {
  const generate = resolveGenerator(deps);
  const timeoutMs = deps?.timeoutMs ?? AI_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: GenerateTextResult | typeof TIMEOUT;

  try {
    const deadline = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });
    outcome = await Promise.race([generate(prompt), deadline]);
  } catch (error) {
    return {
      ok: false,
      status: 502,
      code: 'AI_REQUEST_FAILED',
      message: error instanceof Error ? error.message : 'AI request failed',
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  if (outcome === TIMEOUT) {
    return { ok: false, status: 504, code: 'AI_TIMEOUT', message: 'AI request timed out' };
  }

  if (!outcome || typeof outcome !== 'object' || !('ok' in outcome)) {
    return { ok: false, status: 502, code: 'AI_REQUEST_FAILED', message: 'Unexpected AI response' };
  }

  if (!outcome.ok) {
    const upstreamCode = String(outcome.code ?? '').toUpperCase();
    if (NOT_CONFIGURED_CODES.has(upstreamCode)) {
      return {
        ok: false,
        status: 503,
        code: 'SERVICE_NOT_CONFIGURED',
        message: outcome.message || 'YandexGPT is not configured for this deployment',
      };
    }

    const passthrough = PASSTHROUGH_STATUSES[upstreamCode];
    if (passthrough) {
      return {
        ok: false,
        status: passthrough,
        code: upstreamCode,
        message: outcome.message || 'AI request failed',
      };
    }

    return {
      ok: false,
      status: 502,
      code: 'AI_REQUEST_FAILED',
      message: outcome.message || 'AI request failed',
    };
  }

  const text = typeof outcome.text === 'string' ? outcome.text.trim() : '';
  if (!text) {
    return { ok: false, status: 502, code: 'AI_EMPTY_RESPONSE', message: 'AI returned an empty response' };
  }

  return { ok: true, text };
}

function notFound(): ContactAiFailure {
  return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Contact not found' };
}

function unexpected(error: unknown): ContactAiFailure {
  return {
    ok: false,
    status: 500,
    code: 'AI_REQUEST_FAILED',
    message: error instanceof Error ? error.message : 'AI request failed',
  };
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Summarize the relationship with a contact and suggest a next action.
 *
 * The contact must be inside the caller's org AND inside their visibility cone;
 * a miss on either returns the same 404 as a nonexistent contact.
 */
export async function summarizeContact(params: {
  contactId: string;
  requester: ContactAiRequester;
  deps?: ContactAiDeps;
}): Promise<ContactAiResult<ContactSummary>> {
  const { contactId, requester, deps } = params;

  try {
    const contact = await loadVisibleContact(contactId, requester);
    if (!contact) {
      return notFound();
    }

    const context = await buildContactContext(contact, requester.org_id);
    const result = await callModel(buildSummaryPrompt(context), deps);
    if (!result.ok) {
      return result;
    }

    const parsed = parseModelJson(result.text);
    // A model that ignored the JSON instruction still produced usable prose;
    // treat the whole reply as the summary rather than failing the request.
    const summary =
      (typeof parsed?.summary === 'string' && parsed.summary.trim()) || result.text.trim();
    const nextAction =
      typeof parsed?.next_action === 'string' && parsed.next_action.trim()
        ? parsed.next_action.trim()
        : null;

    const now = deps?.now?.() ?? new Date();

    return {
      ok: true,
      data: {
        contact_id: contact.id,
        summary: redactContactDetails(summary),
        next_action: nextAction ? redactContactDetails(nextAction) : null,
        provider: AI_PROVIDER,
        generated_at: isoInstant(now) ?? new Date().toISOString(),
        context_counts: {
          deals: context.deals.length,
          tasks: context.tasks.length,
          activities: context.activities.length,
        },
        last_activity_at: context.last_activity_at,
      },
    };
  } catch (error) {
    return unexpected(error);
  }
}

/**
 * Extract contact fields from free text and return them as a suggestion.
 *
 * Nothing is persisted — `applied` is always false and the caller is expected
 * to show the values for confirmation before PATCHing the contact.
 */
export async function suggestContactFields(params: {
  text: string;
  deps?: ContactAiDeps;
}): Promise<ContactAiResult<ContactAutofillResult>> {
  const { text, deps } = params;

  try {
    const trimmed = text.trim().slice(0, AUTOFILL_MAX_INPUT_CHARS);
    if (!trimmed) {
      return { ok: false, status: 400, code: 'TEXT_REQUIRED', message: 'text is required' };
    }

    // Redact BEFORE the prompt is built — the model is asked for name, company
    // and position only, so an address or a phone number in the source text is
    // data it has no purpose for (ФЗ-152 ст. 5 ч. 5).
    const redacted = redactContactDetails(trimmed);
    const result = await callModel(buildAutofillPrompt(redacted), deps);
    if (!result.ok) {
      return result;
    }

    const parsed = parseModelJson(result.text);
    if (!parsed) {
      return {
        ok: false,
        status: 502,
        code: 'AI_INVALID_RESPONSE',
        message: 'AI returned an unparsable response',
      };
    }

    const now = deps?.now?.() ?? new Date();

    return {
      ok: true,
      data: {
        suggestion: {
          first_name: suggestionField(parsed.first_name, 100),
          last_name: suggestionField(parsed.last_name, 100),
          company: suggestionField(parsed.company, 200),
          position: suggestionField(parsed.position, 150),
        },
        applied: false,
        provider: AI_PROVIDER,
        generated_at: isoInstant(now) ?? new Date().toISOString(),
      },
    };
  } catch (error) {
    return unexpected(error);
  }
}
