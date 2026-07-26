/**
 * Email templates: org-scoped CRUD plus the `{{placeholder}}` renderer that the
 * sequence sender and the preview endpoint both go through.
 *
 * Two rules govern the renderer and neither is negotiable.
 *
 *  1. VALUES ARE ESCAPED. A contact's first_name/company/notes is text a
 *     customer typed, and it ends up inside an HTML mail body. The HTML
 *     renderer escapes every literal chunk of the template AND every
 *     substituted value, so nothing a contact wrote can turn into markup. There
 *     is deliberately no `escape: false` option to get wrong — the plain-text
 *     renderer is a separate, explicitly named function.
 *
 *  2. UNKNOWN PLACEHOLDERS STAY VISIBLE. `{{frist_name}}` renders as the
 *     literal `{{frist_name}}`, never as an empty string, and comes back in
 *     `unresolved`. A typo has to be obvious in the preview: silently blanking
 *     it means a customer receives "Здравствуйте, !" and nobody finds out until
 *     the campaign has already gone out.
 *
 * The renderer never touches the database and never looks at request state, so
 * it is safe to call from the scheduler as well as from a route.
 */

import { Prisma } from '@prisma/client';
import { db } from './db';
import { decryptField } from './encryption';
import { paginate } from './db-paginate';
import { canSeeUser, getAccessibleUserIds } from './visibility';

// ─── Limits ───────────────────────────────────────────────────────────────────

export const MAX_EMAIL_TEMPLATES_PER_ORG = 200;
export const MAX_TEMPLATE_NAME_LENGTH = 200;
export const MAX_TEMPLATE_SUBJECT_LENGTH = 500;
export const MAX_TEMPLATE_BODY_LENGTH = 50_000;

// ─── Errors ───────────────────────────────────────────────────────────────────

export class EmailTemplateNotFoundError extends Error {
  readonly code = 'EMAIL_TEMPLATE_NOT_FOUND';

  constructor() {
    super('Email template not found');
    this.name = 'EmailTemplateNotFoundError';
  }
}

export class EmailTemplateLimitError extends Error {
  readonly code = 'EMAIL_TEMPLATE_LIMIT_REACHED';

  constructor() {
    super(`An organization can store at most ${MAX_EMAIL_TEMPLATES_PER_ORG} email templates`);
    this.name = 'EmailTemplateLimitError';
  }
}

/**
 * Raised instead of silently unlinking sequence steps: the FK is ON DELETE SET
 * NULL, so deleting a template that a step still points at would leave a live
 * sequence with an empty body and no error anywhere.
 */
export class EmailTemplateInUseError extends Error {
  readonly code = 'EMAIL_TEMPLATE_IN_USE';

  constructor(readonly stepCount: number) {
    super(
      `Template is used by ${stepCount} sequence step(s). Detach it from those steps before deleting.`,
    );
    this.name = 'EmailTemplateInUseError';
  }
}

export class TemplateContactNotFoundError extends Error {
  readonly code = 'CONTACT_NOT_FOUND';

  constructor() {
    super('Contact not found');
    this.name = 'TemplateContactNotFoundError';
  }
}

// ─── Placeholder catalogue ────────────────────────────────────────────────────
//
// `key` is what goes between the braces. Labels are deliberately NOT stored
// here: the mobile app localizes them, and this file must not hardcode a
// locale. `example` is neutral sample text used by the preview endpoint when no
// contact is chosen.

export type TemplatePlaceholderSource = 'contact' | 'organization' | 'system';

export type TemplatePlaceholder = {
  key: string;
  source: TemplatePlaceholderSource;
  example: string;
};

export const TEMPLATE_PLACEHOLDERS: readonly TemplatePlaceholder[] = [
  { key: 'first_name', source: 'contact', example: 'Иван' },
  { key: 'last_name', source: 'contact', example: 'Петров' },
  { key: 'full_name', source: 'contact', example: 'Иван Петров' },
  { key: 'company', source: 'contact', example: 'ООО «Ромашка»' },
  { key: 'email', source: 'contact', example: 'ivan@example.ru' },
  { key: 'phone', source: 'contact', example: '+7 999 123-45-67' },
  { key: 'mobile', source: 'contact', example: '+7 999 765-43-21' },
  { key: 'source', source: 'contact', example: 'website' },
  { key: 'org_name', source: 'organization', example: '4КУБ' },
  { key: 'sender_name', source: 'system', example: 'Мария' },
  { key: 'unsubscribe_url', source: 'system', example: 'https://example.ru/u/…' },
] as const;

export const TEMPLATE_PLACEHOLDER_KEYS: readonly string[] = TEMPLATE_PLACEHOLDERS.map((p) => p.key);

/** Values for every catalogue key — used to preview a template with no contact selected. */
export function sampleTemplateValues(): TemplateValues {
  const values: Record<string, string> = {};
  for (const placeholder of TEMPLATE_PLACEHOLDERS) {
    values[placeholder.key] = placeholder.example;
  }
  return values;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

export type TemplateValues = Readonly<Record<string, string | null | undefined>>;

// A capturing split keeps the placeholders as their own chunks, which means the
// literal text and the substituted values can be escaped independently. Doing it
// this way (rather than a global regex with .replace) also avoids carrying
// `lastIndex` state between calls.
const PLACEHOLDER_SPLIT = /(\{\{\s*[A-Za-z0-9_.]{1,64}\s*\}\})/;
const PLACEHOLDER_EXACT = /^\{\{\s*([A-Za-z0-9_.]{1,64})\s*\}\}$/;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes the five characters that can break out of HTML text or an attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Collapses anything that could forge a new mail header. A contact's company
 * name reaches the Subject: line, and a bare CR/LF there is header injection —
 * an attacker-controlled Bcc or a forged body. Every C0 control, DEL and the
 * Unicode line separators are folded to a single space rather than deleted, so
 * "Ivan\r\nBcc: x" cannot silently become "IvanBcc: x" either.
 */
export function sanitizeHeaderValue(value: string): string {
  let out = '';

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // C0 controls (CR and LF among them), DEL, and the Unicode line
    // separators are the characters that can forge a header. Written as code
    // point comparisons rather than a regex class so nothing depends on an
    // escape sequence surviving a copy/paste into this file.
    const isControl = code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
    out += isControl ? ' ' : char;
  }

  return out.replace(/ {2,}/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

export type RenderedField = {
  value: string;
  /** Placeholders with no value at all — left in the output as literal `{{key}}`. */
  unresolved: string[];
  /** Placeholders that resolved to an empty/whitespace value. */
  blank: string[];
};

type RenderMode = 'text' | 'html';

function renderChunks(template: string, values: TemplateValues, mode: RenderMode): RenderedField {
  const unresolved: string[] = [];
  const blank: string[] = [];
  const out: string[] = [];

  for (const chunk of template.split(PLACEHOLDER_SPLIT)) {
    if (chunk === undefined || chunk === '') {
      continue;
    }

    const match = PLACEHOLDER_EXACT.exec(chunk);
    if (!match) {
      // Literal text, including anything brace-shaped that is not a well formed
      // placeholder (`{{ 1st name }}`). It stays visible, and it is escaped in
      // HTML mode because a template author can paste arbitrary text too.
      out.push(mode === 'html' ? escapeHtml(chunk) : chunk);
      continue;
    }

    const key = match[1] as string;
    // hasOwnProperty, not `key in values`: otherwise `{{constructor}}` and
    // `{{__proto__}}` would resolve against Object.prototype.
    const raw = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;

    if (raw === undefined || raw === null) {
      unresolved.push(key);
      out.push(mode === 'html' ? escapeHtml(chunk) : chunk);
      continue;
    }

    const value = String(raw);
    if (value.trim() === '') {
      blank.push(key);
    }
    out.push(mode === 'html' ? escapeHtml(value) : value);
  }

  return { value: out.join(''), unresolved: unique(unresolved), blank: unique(blank) };
}

/** Plain-text render. No escaping, because there is no markup to escape into. */
export function renderTemplateToText(template: string, values: TemplateValues): RenderedField {
  return renderChunks(template, values, 'text');
}

/**
 * HTML render. Every literal chunk and every substituted value is escaped
 * before it is joined, so the only markup in the result is the `<br />` this
 * function adds for line breaks.
 */
export function renderTemplateToHtml(template: string, values: TemplateValues): RenderedField {
  const rendered = renderChunks(template, values, 'html');
  return { ...rendered, value: rendered.value.replace(/\r\n|\r|\n/g, '<br />\n') };
}

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
  unresolved: string[];
  blank: string[];
};

/**
 * Render a template's subject and body together. The subject is header-safe;
 * the body comes back in both plain text and escaped HTML so the caller can
 * build a multipart message without re-rendering.
 */
export function renderEmailTemplate(
  template: { subject: string; body: string },
  values: TemplateValues,
): RenderedEmail {
  const subject = renderTemplateToText(template.subject, values);
  const text = renderTemplateToText(template.body, values);
  const html = renderTemplateToHtml(template.body, values);

  return {
    subject: sanitizeHeaderValue(subject.value),
    text: text.value,
    html: html.value,
    unresolved: unique([...subject.unresolved, ...text.unresolved]),
    blank: unique([...subject.blank, ...text.blank]),
  };
}

/** Every placeholder key referenced by a template, deduped and sorted. */
export function extractTemplatePlaceholders(...parts: string[]): string[] {
  const keys: string[] = [];
  for (const part of parts) {
    for (const chunk of part.split(PLACEHOLDER_SPLIT)) {
      const match = chunk === undefined ? null : PLACEHOLDER_EXACT.exec(chunk);
      if (match) {
        keys.push(match[1] as string);
      }
    }
  }
  return unique(keys);
}

/**
 * Placeholders used by a template that are not in the catalogue. Returned as a
 * warning on save rather than a validation error: extra keys can legitimately
 * be supplied by the caller at send time, but a typo should surface in the UI
 * before anyone enrolls a contact.
 */
export function unknownTemplatePlaceholders(template: { subject: string; body: string }): string[] {
  const known = new Set(TEMPLATE_PLACEHOLDER_KEYS);
  return extractTemplatePlaceholders(template.subject, template.body).filter((key) => !known.has(key));
}

// ─── Value building ───────────────────────────────────────────────────────────

export type TemplateContactFields = {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  source: string | null;
};

/**
 * Map a contact onto the catalogue keys. `extra` supplies the non-contact keys
 * (org_name, sender_name, unsubscribe_url) and may add keys of its own — the
 * catalogue is the UI's hint list, not a hard allowlist for the renderer.
 *
 * A field the contact does not have stays UNDEFINED rather than becoming '', so
 * it renders as a visible `{{company}}` instead of a silent gap.
 */
export function buildTemplateValues(
  contact: Partial<TemplateContactFields>,
  extra: TemplateValues = {},
): TemplateValues {
  const firstName = contact.first_name ?? null;
  const lastName = contact.last_name ?? null;
  const fullName = [firstName, lastName].filter((part) => part && part.trim() !== '').join(' ');

  const values: Record<string, string | null | undefined> = {
    first_name: firstName ?? undefined,
    last_name: lastName ?? undefined,
    full_name: fullName === '' ? undefined : fullName,
    company: contact.company ?? undefined,
    email: contact.email ?? undefined,
    phone: contact.phone ?? undefined,
    mobile: contact.mobile ?? undefined,
    source: contact.source ?? undefined,
  };

  for (const [key, value] of Object.entries(extra)) {
    if (PLACEHOLDER_EXACT.test(`{{${key}}}`)) {
      values[key] = value;
    }
  }

  return values;
}

export type TemplateRequester = {
  sub: string;
  org_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
};

/**
 * Load a contact for preview. Org-scoped AND cone-checked: previewing must not
 * become a way for a member to read the name/email of a contact they are not
 * allowed to see. Encrypted columns are decrypted here, never stored anywhere.
 */
export async function loadContactTemplateValues(
  contactId: string,
  requester: TemplateRequester,
  extra: TemplateValues = {},
): Promise<TemplateValues> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, organization_id: requester.org_id },
    select: {
      first_name: true,
      last_name: true,
      company: true,
      email: true,
      phone: true,
      mobile: true,
      source: true,
      assigned_to: true,
      created_by: true,
    },
  });

  if (!contact) {
    throw new TemplateContactNotFoundError();
  }

  const accessibleIds = await getAccessibleUserIds(requester);
  if (accessibleIds !== null) {
    const visible =
      canSeeUser(accessibleIds, contact.assigned_to) || canSeeUser(accessibleIds, contact.created_by);
    if (!visible) {
      throw new TemplateContactNotFoundError();
    }
  }

  return buildTemplateValues(
    {
      first_name: contact.first_name,
      last_name: contact.last_name,
      company: contact.company,
      email: decryptField(contact.email ?? undefined) ?? null,
      phone: decryptField(contact.phone ?? undefined) ?? null,
      mobile: decryptField(contact.mobile ?? undefined) ?? null,
      source: contact.source,
    },
    extra,
  );
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const TEMPLATE_INCLUDE = {
  creator: { select: { id: true, name: true } },
};

export type EmailTemplateRecord = Prisma.EmailTemplateGetPayload<{ include: typeof TEMPLATE_INCLUDE }>;

export async function listEmailTemplates(
  organizationId: string,
  filters: { page?: number; per_page?: number; q?: string } = {},
): Promise<{ data: EmailTemplateRecord[]; total: number }> {
  const page = filters.page ?? 1;
  const perPage = filters.per_page ?? 25;
  const q = filters.q?.trim();

  const where: Prisma.EmailTemplateWhereInput = {
    organization_id: organizationId,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { subject: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  return paginate(
    () => db.emailTemplate.count({ where }),
    () =>
      db.emailTemplate.findMany({
        where,
        include: TEMPLATE_INCLUDE,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
  );
}

export async function getEmailTemplate(
  id: string,
  organizationId: string,
): Promise<EmailTemplateRecord> {
  const template = await db.emailTemplate.findFirst({
    where: { id, organization_id: organizationId },
    include: TEMPLATE_INCLUDE,
  });

  if (!template) {
    throw new EmailTemplateNotFoundError();
  }

  return template;
}

export async function createEmailTemplate(input: {
  organizationId: string;
  createdBy: string;
  name: string;
  subject: string;
  body: string;
}): Promise<EmailTemplateRecord> {
  const existing = await db.emailTemplate.count({
    where: { organization_id: input.organizationId },
  });

  if (existing >= MAX_EMAIL_TEMPLATES_PER_ORG) {
    throw new EmailTemplateLimitError();
  }

  return db.emailTemplate.create({
    data: {
      organization_id: input.organizationId,
      created_by: input.createdBy,
      name: input.name.trim(),
      subject: input.subject,
      body: input.body,
    },
    include: TEMPLATE_INCLUDE,
  });
}

export async function updateEmailTemplate(
  id: string,
  organizationId: string,
  patch: { name?: string; subject?: string; body?: string },
): Promise<EmailTemplateRecord> {
  const existing = await db.emailTemplate.findFirst({
    where: { id, organization_id: organizationId },
    select: { id: true },
  });

  if (!existing) {
    throw new EmailTemplateNotFoundError();
  }

  // updateMany rather than update: `update` keys on the primary key alone, so
  // the organization_id filter would be advisory. Here it is part of the write.
  await db.emailTemplate.updateMany({
    where: { id, organization_id: organizationId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
    },
  });

  return getEmailTemplate(id, organizationId);
}

export async function deleteEmailTemplate(
  id: string,
  organizationId: string,
): Promise<{ id: string }> {
  const existing = await db.emailTemplate.findFirst({
    where: { id, organization_id: organizationId },
    select: { id: true },
  });

  if (!existing) {
    throw new EmailTemplateNotFoundError();
  }

  const stepCount = await db.sequenceStep.count({
    where: { organization_id: organizationId, template_id: id },
  });

  if (stepCount > 0) {
    throw new EmailTemplateInUseError(stepCount);
  }

  // EmailSend.template_id is ON DELETE SET NULL on purpose: the send ledger has
  // to outlive the template it was rendered from, so historical reporting keeps
  // working after a cleanup.
  await db.emailTemplate.deleteMany({
    where: { id, organization_id: organizationId },
  });

  return { id };
}

/** Render a stored template. Throws EmailTemplateNotFoundError for another org's id. */
export async function previewEmailTemplate(
  id: string,
  requester: TemplateRequester,
  options: { contact_id?: string; extra?: TemplateValues } = {},
): Promise<RenderedEmail & { template_id: string }> {
  const template = await getEmailTemplate(id, requester.org_id);

  const values = options.contact_id
    ? await loadContactTemplateValues(options.contact_id, requester, options.extra ?? {})
    : { ...sampleTemplateValues(), ...(options.extra ?? {}) };

  return { template_id: template.id, ...renderEmailTemplate(template, values) };
}
