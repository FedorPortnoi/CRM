/**
 * lead-inbox-parse.ts
 *
 * Turns a lead-notification email into structured contact fields. Pure —
 * no IO, no db — so the whole thing is table-testable against fixtures.
 *
 * The primary sender is Яндекс Бизнес «Заявки», whose notification bodies are
 * label/value lines («Имя: …», «Телефон: …»). Yandex does not document the
 * format and has changed it before, so nothing here REQUIRES a known label:
 * labels are tried first, then bare phone/email patterns anywhere in the body.
 * The raw text always survives into the deal, so a format change degrades to
 * "unparsed but captured", never to a dropped заявка.
 */

export type ParsedLeadEmail = {
  /** Display name as written by the client, e.g. "Мария Иванова". */
  name?: string;
  /** Canonical +7XXXXXXXXXX when the number is Russian-shaped, else as found. */
  phone?: string;
  email?: string;
  /** The client's message plus any unrecognized "Label: value" lines. */
  comment?: string;
  /** Trimmed plain text of the whole email, capped — the audit copy. */
  raw: string;
};

const NAME_LABELS = [
  'имя',
  'ваше имя',
  'имя клиента',
  'фио',
  'контактное лицо',
  'клиент',
  'name',
];

const PHONE_LABELS = [
  'телефон',
  'номер телефона',
  'контактный телефон',
  'тел',
  'phone',
];

const EMAIL_LABELS = [
  'email',
  'e-mail',
  'почта',
  'эл. почта',
  'электронная почта',
];

const COMMENT_LABELS = [
  'комментарий',
  'сообщение',
  'вопрос',
  'текст заявки',
  'пожелания',
  'детали',
  'услуга',
  'comment',
  'message',
];

/** Labels that carry service metadata, not client data — recognized to be dropped. */
const IGNORED_LABELS = ['дата', 'время', 'номер заявки', 'организация', 'филиал'];

const RAW_CAP = 8_000;
const COMMENT_CAP = 2_000;

/**
 * +7/8-prefixed or bare 10-digit Russian mobile/landline, tolerant of spaces,
 * dashes and parentheses between the digits.
 */
const PHONE_PATTERN = /(?:\+7|\b8|\b7)[\s\-().]*(?:\d[\s\-().]*){10}|\b9\d{2}[\s\-().]*(?:\d[\s\-().]*){7}/;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

/**
 * Notification plumbing, not a client address. Only unambiguous service
 * mailboxes are excluded — a client with @yandex.ru must still be found.
 */
const SERVICE_EMAIL = /^(?:no-?reply|noreply|robot|notify|devnull|mailer-daemon)@|@(?:business\.yandex|yandex-team)\./i;

/**
 * Collapse an HTML body to line-oriented text. mailparser usually supplies a
 * text part, so this is the fallback for HTML-only notifications; it aims for
 * "labels stay on their own lines", not for fidelity.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(?:style|script)[\s\S]*?<\/(?:style|script)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Canonicalize a Russian phone to +7XXXXXXXXXX. Non-Russian shapes come back
 * lightly cleaned rather than null — a foreign client is still a client.
 */
export function normalizeRuPhone(value: string): string | undefined {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10) {
    return undefined;
  }

  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return `+7${digits.slice(1)}`;
  }

  if (digits.length === 10 && digits.startsWith('9')) {
    return `+7${digits}`;
  }

  return value.startsWith('+') ? `+${digits}` : digits;
}

type LabeledLine = { label: string; value: string };

/** «Имя: Мария», «Телефон — +7 …»; the separator set is deliberately narrow. */
const LABELED_LINE = /^\s*([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё .\-]{0,40}?)\s*[:：—–-]\s+(.+)$/;
const LABELED_LINE_COLON = /^\s*([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё .\-]{0,40}?)\s*[:：]\s*(.+)$/;

function matchLabel(line: string): LabeledLine | null {
  // The colon variant is tried first and tolerates a missing space after the
  // separator; the dash variants REQUIRE the space so «Ростов-на-Дону» in a
  // value is never split at its own hyphen.
  const m = LABELED_LINE_COLON.exec(line) ?? LABELED_LINE.exec(line);
  if (!m) {
    return null;
  }
  return { label: m[1].trim().toLowerCase().replace(/\s+/g, ' '), value: m[2].trim() };
}

function labelIn(label: string, candidates: string[]): boolean {
  return candidates.some((c) => label === c || label.startsWith(`${c} `));
}

function nameFromSubject(subject: string): string | undefined {
  // NB: \w is ASCII-only in JS regexes — «заявка» needs the explicit range.
  const m = /заявк[а-яё]*\s+от\s+(.{2,80})$/i.exec(subject.trim());
  if (!m) {
    return undefined;
  }
  const candidate = m[1].trim().replace(/["«»]/g, '');
  // A trailing «от 12.08.2026» is a date, not a person.
  return /^\d/.test(candidate) ? undefined : candidate;
}

export function parseLeadEmail(input: {
  subject?: string;
  text?: string;
  html?: string;
}): ParsedLeadEmail {
  const text = (input.text?.trim() ? input.text : htmlToText(input.html ?? '')).trim();
  const raw = text.slice(0, RAW_CAP);

  let name: string | undefined;
  let phone: string | undefined;
  let email: string | undefined;
  const commentParts: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const labeled = matchLabel(line);
    if (!labeled || !labeled.value) {
      continue;
    }

    const { label, value } = labeled;
    if (labelIn(label, NAME_LABELS)) {
      name ??= value;
    } else if (labelIn(label, PHONE_LABELS)) {
      phone ??= normalizeRuPhone(value) ?? value;
    } else if (labelIn(label, EMAIL_LABELS)) {
      email ??= EMAIL_PATTERN.exec(value)?.[0];
    } else if (labelIn(label, COMMENT_LABELS)) {
      commentParts.push(value);
    } else if (!labelIn(label, IGNORED_LABELS)) {
      // A form question this parser has never heard of is still an answer the
      // client typed. Keep it, labeled, instead of silently dropping it.
      commentParts.push(`${labeled.label}: ${value}`);
    }
  }

  if (!phone) {
    const m = PHONE_PATTERN.exec(text);
    if (m) {
      phone = normalizeRuPhone(m[0]) ?? undefined;
    }
  }

  if (!email) {
    for (const m of text.matchAll(new RegExp(EMAIL_PATTERN, 'g'))) {
      if (!SERVICE_EMAIL.test(m[0])) {
        email = m[0];
        break;
      }
    }
  }

  if (!name && input.subject) {
    name = nameFromSubject(input.subject);
  }

  const comment = commentParts.join('\n').slice(0, COMMENT_CAP) || undefined;

  return { name, phone, email, comment, raw };
}
