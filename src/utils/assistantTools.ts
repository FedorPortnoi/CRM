// Catalogue of the CRM tools the assistant can call, and how to describe a call
// to a human.
//
// The assistant does not just answer — it can create a contact, move a deal or
// close a task. Prose claiming "я создал контакт" is not evidence; the screen
// has to show the action itself. Everything a tool call is rendered with lives
// here so the chat screen stays presentation-only.
//
// Names mirror registerTool(...) in backend/mcp/tools/*.ts. A name that is not
// in this table still renders (assistant.toolUnknown) — the backend can add a
// tool without the app hiding it.
import { formatMarketDateTime, formatMoney } from '../market/profile';

/** Reads look up data; writes change it and are what the user must be able to verify. */
export type AssistantToolKind = 'read' | 'write';

/** One tool call as reported by POST /assistant/messages, or rebuilt from history. */
export type AssistantToolCall = {
  round: number;
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  error?: { code: string; message: string };
};

const TOOL_KINDS: Record<string, AssistantToolKind> = {
  // contacts
  get_contacts: 'read',
  get_contact: 'read',
  create_contact: 'write',
  update_contact: 'write',
  archive_contact: 'write',
  merge_contacts: 'write',
  // deals
  get_deals: 'read',
  get_deal: 'read',
  get_pipelines: 'read',
  create_deal: 'write',
  update_deal: 'write',
  move_deal_to_stage: 'write',
  // tasks
  get_tasks: 'read',
  get_task: 'read',
  get_overdue_tasks: 'read',
  create_task: 'write',
  update_task: 'write',
  complete_task: 'write',
  // calendar
  get_events: 'read',
  get_event: 'read',
  create_event: 'write',
  update_event: 'write',
  cancel_event: 'write',
  complete_event: 'write',
  // analytics
  get_dashboard: 'read',
  get_pipeline_health: 'read',
  get_funnel: 'read',
  get_revenue: 'read',
  get_rep_performance: 'read',
  get_lead_sources: 'read',
};

export function isKnownAssistantTool(name: string): boolean {
  return name in TOOL_KINDS;
}

/**
 * Unknown tools are treated as writes: over-reporting an action is recoverable,
 * silently hiding one that changed data is not.
 */
export function assistantToolKind(name: string): AssistantToolKind {
  return TOOL_KINDS[name] ?? 'write';
}

/** `assistant.tool_<name>` — neutral name of the action ("Создание контакта"). */
export function assistantToolLabelKey(name: string): string {
  return `assistant.tool_${name}`;
}

/** `assistant.toolDone_<name>` — past tense, only used once a write succeeded. */
export function assistantToolDoneKey(name: string): string {
  return `assistant.toolDone_${name}`;
}

const MAX_SUBJECT_CHARS = 90;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * A short human descriptor of what the call was about: the contact's name, the
 * deal title, the search phrase, the money, the date.
 *
 * Identifiers are deliberately dropped — a raw UUID is noise to a salesperson
 * and the assistant's own system prompt forbids showing them. Money and dates
 * go through the market profile like everywhere else in the app.
 */
export function describeToolArguments(args: Record<string, unknown>): string {
  const parts: string[] = [];

  const person = [text(args.first_name), text(args.last_name)].filter(Boolean).join(' ');
  if (person.length > 0) parts.push(person);

  const title = text(args.title) ?? text(args.name) ?? text(args.subject);
  if (title !== null && !looksLikeUuid(title)) parts.push(title);

  const company = text(args.company);
  if (company !== null && parts.length === 0) parts.push(company);

  const query = text(args.q);
  if (query !== null) parts.push(`«${query}»`);

  if (typeof args.value === 'number' && Number.isFinite(args.value)) {
    parts.push(formatMoney(args.value, text(args.currency)));
  }

  const when = text(args.due_date) ?? text(args.start_time) ?? text(args.expected_close);
  if (when !== null) {
    const formatted = formatMarketDateTime(when);
    if (formatted.length > 0) parts.push(formatted);
  }

  const joined = parts.join(' · ');
  return joined.length > MAX_SUBJECT_CHARS ? `${joined.slice(0, MAX_SUBJECT_CHARS - 1)}…` : joined;
}

/** Writes first: they are the ones the user has to be able to check. */
export function splitToolCalls(calls: AssistantToolCall[]): {
  writes: AssistantToolCall[];
  reads: AssistantToolCall[];
} {
  const writes: AssistantToolCall[] = [];
  const reads: AssistantToolCall[] = [];

  for (const call of calls) {
    if (assistantToolKind(call.name) === 'write') {
      writes.push(call);
    } else {
      reads.push(call);
    }
  }

  return { writes, reads };
}
