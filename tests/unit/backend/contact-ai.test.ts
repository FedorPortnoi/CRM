import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  contact: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  deal: { findMany: vi.fn() },
  task: { findMany: vi.fn() },
  message: { findMany: vi.fn() },
  calendarEvent: { findMany: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

// The real YandexGPT client is never exercised here: every test injects its own
// generator through `deps`. The module is still mocked so that a regression in
// the injection seam surfaces as an assertion failure rather than as an
// outbound HTTPS request from the unit suite.
const yandexGptMock = vi.hoisted(() => ({ createCompletion: vi.fn() }));
vi.mock('../../../backend/services/yandex-gpt', () => yandexGptMock);

import {
  AUTOFILL_MAX_INPUT_CHARS,
  EMAIL_MASK,
  PHONE_MASK,
  buildSummaryPrompt,
  parseModelJson,
  redactContactDetails,
  suggestContactFields,
  summarizeContact,
  type ContactAiRequester,
  type GenerateTextResult,
} from '../../../backend/services/contact-ai';

const ORG_ID = '00000000-0000-4000-a000-0000000000aa';
const OTHER_ORG_ID = '00000000-0000-4000-a000-0000000000bb';
const OWNER_ID = '00000000-0000-4000-a000-000000000001';
const MANAGER_ID = '00000000-0000-4000-a000-000000000002';
const REPORT_ID = '00000000-0000-4000-a000-000000000003';
const OUTSIDER_ID = '00000000-0000-4000-a000-000000000004';
const CONTACT_ID = '00000000-0000-4000-a000-00000000c001';

const owner: ContactAiRequester = { sub: OWNER_ID, org_id: ORG_ID, role: 'owner' };
const member: ContactAiRequester = { sub: MANAGER_ID, org_id: ORG_ID, role: 'member' };

// PII that must never reach the model. The first three are what the encrypted
// columns look like on disk; the last two are the plaintext behind them.
const CIPHERTEXT_EMAIL = 'v1:9f2c1a::V0hZIElTIFRISVMgSEVSRQ==';
const CIPHERTEXT_PHONE = 'v1:41bb07::UEhPTkUgQ0lQSEVSVEVYVA==';
const PLAINTEXT_EMAIL = 'ivan.petrov@example.com';
const PLAINTEXT_PHONE = '+7 495 123 45 67';

// The assignee's ФИО — an OPERATOR's personal data, a `User.name`, not a
// customer's. It must not reach the model in any form. Deliberately unlike
// every other name in this file (and unlike the contact's own «Иван Петров»)
// so that a hit inside a prompt is unambiguous and cannot be a coincidence.
const OPERATOR_FIO = 'Аглая Криворучко-Замятина';
/** The surname stem alone, to catch an inflected or truncated leak. */
const OPERATOR_SURNAME_STEM = 'Криворучко';

type ContactRowOverrides = Partial<Record<string, unknown>>;

function contactRow(overrides: ContactRowOverrides = {}) {
  return {
    id: CONTACT_ID,
    organization_id: ORG_ID,
    first_name: 'Иван',
    last_name: 'Петров',
    company: 'ООО «Ромашка»',
    type: 'lead',
    status: 'active',
    source: 'сайт',
    tags: ['важный', 'москва'],
    notes: 'Просил перезвонить в июле.',
    created_at: new Date('2026-01-15T10:00:00.000Z'),
    assigned_to: MANAGER_ID,
    created_by: MANAGER_ID,
    // Deliberately present on the mocked row even though the production `select`
    // never asks for them: if the context builder ever spreads the row instead
    // of projecting it field by field, these leak and the PII tests fail. The
    // same trick arms the operator-name tests — Prisma is mocked, so dropping
    // `assignee` from the real `select` does not stop a re-added
    // `contact.assignee?.name` from finding this value and failing the suite.
    assignee: { name: OPERATOR_FIO },
    email: CIPHERTEXT_EMAIL,
    phone: CIPHERTEXT_PHONE,
    mobile: CIPHERTEXT_PHONE,
    email_bidx: 'a1b2c3d4e5f6',
    ...overrides,
  };
}

/** Captures every prompt handed to the model. */
function recorder(result: GenerateTextResult) {
  const prompts: string[] = [];
  const generateText = vi.fn(async (prompt: string) => {
    prompts.push(prompt);
    return result;
  });
  return { prompts, generateText };
}

const OK_SUMMARY: GenerateTextResult = {
  ok: true,
  text: '{"summary": "Клиент в активной работе.", "next_action": "Позвонить в пятницу."}',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Visibility cone for `member`: himself plus one direct report.
  dbMock.$queryRaw.mockResolvedValue([{ id: MANAGER_ID }, { id: REPORT_ID }]);
  dbMock.contact.findFirst.mockResolvedValue(contactRow());
  dbMock.deal.findMany.mockResolvedValue([]);
  dbMock.task.findMany.mockResolvedValue([]);
  dbMock.message.findMany.mockResolvedValue([]);
  dbMock.calendarEvent.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tenant + cone enforcement
// ---------------------------------------------------------------------------

describe('summarizeContact — org scoping and the visibility cone', () => {
  it('scopes the contact lookup to the caller organization', async () => {
    const { generateText } = recorder(OK_SUMMARY);

    await summarizeContact({ contactId: CONTACT_ID, requester: member, deps: { generateText } });

    const where = dbMock.contact.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: CONTACT_ID, organization_id: ORG_ID });
    expect(where.organization_id).not.toBe(OTHER_ORG_ID);
  });

  it('scopes every related read to the organization in its own right', async () => {
    const { generateText } = recorder(OK_SUMMARY);

    await summarizeContact({ contactId: CONTACT_ID, requester: member, deps: { generateText } });

    for (const model of [dbMock.deal, dbMock.task, dbMock.message, dbMock.calendarEvent]) {
      expect(model.findMany).toHaveBeenCalledTimes(1);
      expect(model.findMany.mock.calls[0][0].where).toMatchObject({
        organization_id: ORG_ID,
        contact_id: CONTACT_ID,
      });
    }
  });

  it('refuses a member a contact outside their branch of the org chart', async () => {
    dbMock.contact.findFirst.mockResolvedValue(
      contactRow({ assigned_to: OUTSIDER_ID, created_by: OUTSIDER_ID }),
    );
    const { generateText } = recorder(OK_SUMMARY);

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: member,
      deps: { generateText },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(404);
    expect(result.code).toBe('NOT_FOUND');
    // The cone check must short-circuit before anything is sent anywhere.
    expect(generateText).not.toHaveBeenCalled();
  });

  it('allows a member a contact belonging to one of their reports', async () => {
    dbMock.contact.findFirst.mockResolvedValue(
      contactRow({ assigned_to: REPORT_ID, created_by: OUTSIDER_ID }),
    );
    const { generateText } = recorder(OK_SUMMARY);

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: member,
      deps: { generateText },
    });

    expect(result.ok).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('allows a member a contact they created but never had assigned', async () => {
    dbMock.contact.findFirst.mockResolvedValue(
      contactRow({ assigned_to: null, created_by: MANAGER_ID }),
    );
    const { generateText } = recorder(OK_SUMMARY);

    expect((await summarizeContact({
      contactId: CONTACT_ID,
      requester: member,
      deps: { generateText },
    })).ok).toBe(true);
  });

  it('leaves owner and admin unrestricted', async () => {
    dbMock.contact.findFirst.mockResolvedValue(
      contactRow({ assigned_to: OUTSIDER_ID, created_by: OUTSIDER_ID }),
    );
    const { generateText } = recorder(OK_SUMMARY);

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: owner,
      deps: { generateText },
    });

    expect(result.ok).toBe(true);
    // owner/admin never pay for the recursive cone query
    expect(dbMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns the same 404 for a missing contact as for one outside the cone', async () => {
    dbMock.contact.findFirst.mockResolvedValue(null);
    const { generateText } = recorder(OK_SUMMARY);

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: member,
      deps: { generateText },
    });

    expect(result).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });
    expect(generateText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PII minimization (ФЗ-152)
// ---------------------------------------------------------------------------

describe('summarizeContact — encrypted PII never reaches the model', () => {
  it('does not even read the encrypted columns', async () => {
    const { generateText } = recorder(OK_SUMMARY);

    await summarizeContact({ contactId: CONTACT_ID, requester: owner, deps: { generateText } });

    const select = dbMock.contact.findFirst.mock.calls[0][0].select as Record<string, unknown>;
    for (const column of ['email', 'phone', 'mobile', 'email_bidx', 'phone_bidx', 'mobile_bidx']) {
      expect(select[column]).toBeUndefined();
    }
    // …while still reading what the summary actually needs.
    expect(select.first_name).toBe(true);
    expect(select.company).toBe(true);
  });

  it('keeps ciphertext and plaintext contact details out of the prompt', async () => {
    dbMock.contact.findFirst.mockResolvedValue(
      contactRow({ notes: `Почта ${PLAINTEXT_EMAIL}, телефон ${PLAINTEXT_PHONE}. Готов к встрече.` }),
    );
    dbMock.message.findMany.mockResolvedValue([
      {
        channel: 'telegram',
        direction: 'inbound',
        body: `Мой номер 8 800 555 35 35, пишите на ${PLAINTEXT_EMAIL}`,
        created_at: new Date('2026-07-20T09:00:00.000Z'),
      },
    ]);
    const { prompts, generateText } = recorder(OK_SUMMARY);

    await summarizeContact({ contactId: CONTACT_ID, requester: owner, deps: { generateText } });

    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;

    for (const secret of [CIPHERTEXT_EMAIL, CIPHERTEXT_PHONE, PLAINTEXT_EMAIL, 'a1b2c3d4e5f6']) {
      expect(prompt).not.toContain(secret);
    }
    expect(prompt).not.toContain('495 123 45 67');
    expect(prompt).not.toContain('8 800 555 35 35');
    expect(prompt).toContain(EMAIL_MASK);
    expect(prompt).toContain(PHONE_MASK);

    // The non-PII context the model is entitled to is still there.
    expect(prompt).toContain('Иван Петров');
    expect(prompt).toContain('ООО «Ромашка»');
    expect(prompt).toContain('Готов к встрече');
  });

  it('sends deal values with an ISO currency code and no locale formatting', async () => {
    dbMock.deal.findMany.mockResolvedValue([
      {
        title: 'Поставка станков',
        value: '1200000',
        currency: 'RUB',
        status: 'open',
        expected_close: new Date('2026-08-01T00:00:00.000Z'),
        next_action: 'Отправить КП',
        stage: { name: 'Квалификация' },
      },
    ]);
    const { prompts, generateText } = recorder(OK_SUMMARY);

    await summarizeContact({ contactId: CONTACT_ID, requester: owner, deps: { generateText } });

    expect(prompts[0]).toContain('1200000 RUB');
    expect(prompts[0]).toContain('2026-08-01');
    expect(prompts[0]).not.toContain('$');
    expect(prompts[0]).not.toContain('₽');
  });

  it('masks contact details in the model answer too, in case it echoed them back', async () => {
    const { generateText } = recorder({
      ok: true,
      text: `{"summary": "Пишите на ${PLAINTEXT_EMAIL}.", "next_action": "Наберите ${PLAINTEXT_PHONE}."}`,
    });

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: owner,
      deps: { generateText },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.summary).not.toContain(PLAINTEXT_EMAIL);
    expect(result.data.summary).toContain(EMAIL_MASK);
    expect(result.data.next_action).not.toContain('495 123 45 67');
  });
});

// ---------------------------------------------------------------------------
// The operator's own ФИО (a User.name — a SECOND data subject in a prompt about
// a customer). ФЗ-152 ст. 5 ч. 5; and ст. 12 the moment Wave A repoints
// ./yandex-gpt at OpenAI, since this service shares that provider client.
// ---------------------------------------------------------------------------

describe('summarizeContact — the assignee ФИО never reaches the model', () => {
  it('does not read the assignee name out of Postgres at all', async () => {
    const { generateText } = recorder(OK_SUMMARY);

    await summarizeContact({ contactId: CONTACT_ID, requester: owner, deps: { generateText } });

    const select = dbMock.contact.findFirst.mock.calls[0][0].select as Record<string, unknown>;
    expect(select.assignee).toBeUndefined();
    // The uuid is still read — the visibility cone needs it, and an id is not a
    // name. It is what makes the *name* unnecessary.
    expect(select.assigned_to).toBe(true);
  });

  it('keeps the assignee ФИО out of the built prompt', async () => {
    const { prompts, generateText } = recorder(OK_SUMMARY);

    await summarizeContact({ contactId: CONTACT_ID, requester: owner, deps: { generateText } });

    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;

    expect(prompt).not.toContain(OPERATOR_FIO);
    expect(prompt).not.toContain(OPERATOR_SURNAME_STEM);
    expect(prompt).not.toContain('Аглая');
    // The label goes too, not just the value: an empty «Ответственный менеджер:»
    // would mean the interpolation is still there and merely happened to be null.
    expect(prompt).not.toContain('Ответственный менеджер');
  });

  it('drops the name rather than substituting a handle that could surface in the prose', async () => {
    const { prompts, generateText } = recorder(OK_SUMMARY);

    await summarizeContact({ contactId: CONTACT_ID, requester: owner, deps: { generateText } });

    const [prompt] = prompts;
    // buildSystemPrompt in assistant.ts can afford USER-… because the model
    // chains on it conversationally. This output is prose rendered straight to
    // the operator and nothing substitutes a handle back, so there must be no
    // handle — and no raw uuid standing in for one either.
    expect(prompt).not.toContain('USER-');
    expect(prompt).not.toContain(MANAGER_ID);
  });

  it('still sends everything the summary actually needs', async () => {
    dbMock.deal.findMany.mockResolvedValue([
      {
        title: 'Поставка станков',
        value: '1200000',
        currency: 'RUB',
        status: 'open',
        expected_close: new Date('2026-08-01T00:00:00.000Z'),
        next_action: 'Отправить КП',
        stage: { name: 'Квалификация' },
      },
    ]);
    const { prompts, generateText } = recorder(OK_SUMMARY);

    await summarizeContact({ contactId: CONTACT_ID, requester: owner, deps: { generateText } });

    const [prompt] = prompts;
    // Guards against over-deletion: the contact's own identity and the relation
    // history are a separate, deliberate decision and must survive untouched.
    expect(prompt).toContain('Иван Петров');
    expect(prompt).toContain('ООО «Ромашка»');
    expect(prompt).toContain('Поставка станков');
    expect(prompt).toContain('Просил перезвонить в июле');
  });

  it('leaks nothing even when the ФИО also appears in a free-text field', async () => {
    // A note a human typed the manager's name into is not this fix's job —
    // redaction of arbitrary inflected Russian names is the design three
    // reviewers rejected. What is asserted here is narrower and real: the
    // STRUCTURED interpolation is gone, so the only way the name can appear is
    // if a user typed it, and the count proves the field is not adding one.
    dbMock.contact.findFirst.mockResolvedValue(
      contactRow({ notes: `Клиента ведёт ${OPERATOR_FIO}, просил перезвонить.` }),
    );
    const { prompts, generateText } = recorder(OK_SUMMARY);

    await summarizeContact({ contactId: CONTACT_ID, requester: owner, deps: { generateText } });

    const [prompt] = prompts;
    const occurrences = prompt.split(OPERATOR_SURNAME_STEM).length - 1;
    expect(occurrences).toBe(1);
    expect(prompt).not.toContain('Ответственный менеджер');
  });
});

describe('redactContactDetails', () => {
  it('masks emails and phone-shaped runs', () => {
    expect(redactContactDetails('пишите ivan@example.ru')).toBe(`пишите ${EMAIL_MASK}`);
    expect(redactContactDetails('звоните +7 (495) 123-45-67')).toBe(`звоните ${PHONE_MASK}`);
    expect(redactContactDetails('8 800 555 35 35')).toBe(PHONE_MASK);
    expect(redactContactDetails('+44 20 7946 0958')).toBe(PHONE_MASK);
    expect(redactContactDetails('79951234567')).toBe(PHONE_MASK);
  });

  it('leaves ordinary business numbers and dates alone', () => {
    expect(redactContactDetails('сумма 1 200 000 RUB')).toBe('сумма 1 200 000 RUB');
    expect(redactContactDetails('закрытие 2026-08-01')).toBe('закрытие 2026-08-01');
    expect(redactContactDetails('скидка 15%, срок 30 дней')).toBe('скидка 15%, срок 30 дней');
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe('degradation when the model is unavailable', () => {
  it('turns an unconfigured model into a structured 503', async () => {
    const generateText = vi.fn(async () => ({
      ok: false as const,
      code: 'SERVICE_NOT_CONFIGURED',
      message: 'YANDEX_API_KEY is not set',
    }));

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: owner,
      deps: { generateText },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      code: 'SERVICE_NOT_CONFIGURED',
      message: 'YANDEX_API_KEY is not set',
    });
  });

  it('treats a missing ai.languageModels.user role as unconfigured, not as a caller error', async () => {
    for (const code of ['UNAUTHORIZED', 'PERMISSION_DENIED', 'NOT_CONFIGURED']) {
      const generateText = vi.fn(async () => ({ ok: false as const, code, message: 'denied' }));

      const result = await summarizeContact({
        contactId: CONTACT_ID,
        requester: owner,
        deps: { generateText },
      });

      expect(result).toMatchObject({ ok: false, status: 503, code: 'SERVICE_NOT_CONFIGURED' });
    }
  });

  it('degrades the autofill endpoint the same way', async () => {
    const generateText = vi.fn(async () => ({
      ok: false as const,
      code: 'SERVICE_NOT_CONFIGURED',
      message: 'not configured',
    }));

    const result = await suggestContactFields({ text: 'Иван Петров, ООО Ромашка', deps: { generateText } });

    expect(result).toMatchObject({ ok: false, status: 503, code: 'SERVICE_NOT_CONFIGURED' });
  });

  it('maps any other upstream failure to 502 rather than leaking it', async () => {
    const generateText = vi.fn(async () => ({
      ok: false as const,
      code: 'AI_BAD_RESPONSE',
      message: 'garbage from the model service',
    }));

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: owner,
      deps: { generateText },
    });

    expect(result).toMatchObject({ ok: false, status: 502, code: 'AI_REQUEST_FAILED' });
  });

  it('passes a rate limit and an upstream timeout through with their own status', async () => {
    const cases: Array<[string, number]> = [
      ['AI_RATE_LIMITED', 429],
      ['AI_TIMEOUT', 504],
    ];

    for (const [code, status] of cases) {
      const generateText = vi.fn(async () => ({ ok: false as const, code, message: 'upstream' }));

      const result = await summarizeContact({
        contactId: CONTACT_ID,
        requester: owner,
        deps: { generateText },
      });

      expect(result).toMatchObject({ ok: false, status, code });
    }
  });

  it('does not crash when the client throws', async () => {
    const generateText = vi.fn(async () => {
      throw new Error('socket hang up');
    });

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: owner,
      deps: { generateText },
    });

    expect(result).toMatchObject({ ok: false, status: 502, code: 'AI_REQUEST_FAILED' });
  });

  it('never hangs a request on a model that does not answer', async () => {
    // A promise that is never settled — exactly what a wedged upstream socket
    // looks like from here.
    const generateText = vi.fn(() => new Promise<GenerateTextResult>(() => {}));

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: owner,
      deps: { generateText, timeoutMs: 10 },
    });

    expect(result).toMatchObject({ ok: false, status: 504, code: 'AI_TIMEOUT' });
  });

  it('rejects an empty model answer instead of returning a blank summary', async () => {
    const generateText = vi.fn(async () => ({ ok: true as const, text: '   ' }));

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: owner,
      deps: { generateText },
    });

    expect(result).toMatchObject({ ok: false, status: 502, code: 'AI_EMPTY_RESPONSE' });
  });

  it('surfaces a database failure as a structured result, not an unhandled throw', async () => {
    dbMock.contact.findFirst.mockRejectedValue(new Error('connection terminated'));
    const { generateText } = recorder(OK_SUMMARY);

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: owner,
      deps: { generateText },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Summary shape
// ---------------------------------------------------------------------------

describe('summarizeContact — result', () => {
  it('returns the parsed summary, next action and context counts', async () => {
    dbMock.deal.findMany.mockResolvedValue([
      { title: 'Сделка', value: '100', currency: 'RUB', status: 'open', expected_close: null, next_action: null, stage: null },
    ]);
    dbMock.task.findMany.mockResolvedValue([
      { title: 'Позвонить', status: 'pending', priority: 'high', due_date: new Date('2026-07-30T00:00:00.000Z') },
    ]);
    dbMock.calendarEvent.findMany.mockResolvedValue([
      { title: 'Демо', start_time: new Date('2026-07-22T12:00:00.000Z'), status: 'scheduled' },
    ]);
    const { generateText } = recorder(OK_SUMMARY);

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: owner,
      deps: { generateText, now: () => new Date('2026-07-25T00:00:00.000Z') },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data).toMatchObject({
      contact_id: CONTACT_ID,
      summary: 'Клиент в активной работе.',
      next_action: 'Позвонить в пятницу.',
      provider: 'yandexgpt',
      generated_at: '2026-07-25T00:00:00.000Z',
      context_counts: { deals: 1, tasks: 1, activities: 1 },
      last_activity_at: '2026-07-22T12:00:00.000Z',
    });
  });

  it('falls back to the raw answer when the model ignores the JSON instruction', async () => {
    const { generateText } = recorder({ ok: true, text: 'Клиент давно не отвечает.' });

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: owner,
      deps: { generateText },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.summary).toBe('Клиент давно не отвечает.');
    expect(result.data.next_action).toBeNull();
  });

  it('asks for Russian and forbids invention', () => {
    const prompt = buildSummaryPrompt({
      contact_id: CONTACT_ID,
      display_name: 'Иван Петров',
      company: null,
      type: 'lead',
      status: 'active',
      source: null,
      tags: [],
      created_at: null,
      notes: null,
      deals: [],
      tasks: [],
      activities: [],
      last_activity_at: null,
    });

    expect(prompt).toContain('русском языке');
    expect(prompt).toContain('не придумывай');
    expect(prompt).toContain('"next_action"');
  });
});

// ---------------------------------------------------------------------------
// Autofill
// ---------------------------------------------------------------------------

describe('suggestContactFields', () => {
  const SIGNATURE = [
    'С уважением,',
    'Иван Петров',
    'Коммерческий директор',
    'ООО «Ромашка»',
    `тел. ${PLAINTEXT_PHONE}`,
    PLAINTEXT_EMAIL,
  ].join('\n');

  const MODEL_ANSWER: GenerateTextResult = {
    ok: true,
    text: '```json\n{"first_name": "Иван", "last_name": "Петров", "company": "ООО «Ромашка»", "position": "Коммерческий директор"}\n```',
  };

  it('returns a suggestion and writes nothing', async () => {
    const { generateText } = recorder(MODEL_ANSWER);

    const result = await suggestContactFields({
      text: SIGNATURE,
      deps: { generateText, now: () => new Date('2026-07-25T00:00:00.000Z') },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data).toMatchObject({
      suggestion: {
        first_name: 'Иван',
        last_name: 'Петров',
        company: 'ООО «Ромашка»',
        position: 'Коммерческий директор',
      },
      applied: false,
      provider: 'yandexgpt',
      generated_at: '2026-07-25T00:00:00.000Z',
    });

    expect(dbMock.contact.create).not.toHaveBeenCalled();
    expect(dbMock.contact.update).not.toHaveBeenCalled();
    expect(dbMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it('strips the address and phone out of the signature before sending it', async () => {
    const { prompts, generateText } = recorder(MODEL_ANSWER);

    await suggestContactFields({ text: SIGNATURE, deps: { generateText } });

    const [prompt] = prompts;
    expect(prompt).not.toContain(PLAINTEXT_EMAIL);
    expect(prompt).not.toContain('495 123 45 67');
    expect(prompt).toContain(EMAIL_MASK);
    expect(prompt).toContain(PHONE_MASK);
    // Everything the model is actually being asked about survives.
    expect(prompt).toContain('Иван Петров');
    expect(prompt).toContain('Коммерческий директор');
    expect(prompt).toContain('ООО «Ромашка»');
  });

  it('drops fields the model could not find', async () => {
    const { generateText } = recorder({
      ok: true,
      text: '{"first_name": "Иван", "last_name": null, "company": "не указано", "position": "—"}',
    });

    const result = await suggestContactFields({ text: 'Иван', deps: { generateText } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.suggestion).toEqual({
      first_name: 'Иван',
      last_name: null,
      company: null,
      position: null,
    });
  });

  it('refuses a field the model filled with a contact detail', async () => {
    const { generateText } = recorder({
      ok: true,
      text: `{"first_name": "Иван", "last_name": null, "company": "${PLAINTEXT_EMAIL}", "position": null}`,
    });

    const result = await suggestContactFields({ text: 'Иван', deps: { generateText } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.suggestion.company).toBeNull();
  });

  it('rejects blank input without calling the model', async () => {
    const { generateText } = recorder(MODEL_ANSWER);

    const result = await suggestContactFields({ text: '   ', deps: { generateText } });

    expect(result).toMatchObject({ ok: false, status: 400, code: 'TEXT_REQUIRED' });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('truncates oversized input instead of forwarding it whole', async () => {
    const { prompts, generateText } = recorder(MODEL_ANSWER);

    await suggestContactFields({ text: 'а'.repeat(AUTOFILL_MAX_INPUT_CHARS + 500), deps: { generateText } });

    expect(prompts[0].length).toBeLessThan(AUTOFILL_MAX_INPUT_CHARS + 500);
  });

  it('reports an unparsable answer instead of inventing fields', async () => {
    const { generateText } = recorder({ ok: true, text: 'не могу разобрать' });

    const result = await suggestContactFields({ text: 'Иван', deps: { generateText } });

    expect(result).toMatchObject({ ok: false, status: 502, code: 'AI_INVALID_RESPONSE' });
  });
});

describe('parseModelJson', () => {
  it('reads an object out of fenced or chatty replies', () => {
    expect(parseModelJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Вот результат: {"a": 1}. Готово.')).toEqual({ a: 1 });
    expect(parseModelJson('{"a": {"b": 2}}')).toEqual({ a: { b: 2 } });
  });

  it('returns null for anything that is not a JSON object', () => {
    expect(parseModelJson('просто текст')).toBeNull();
    expect(parseModelJson('[1, 2, 3]')).toBeNull();
    expect(parseModelJson('{ незакрытый')).toBeNull();
    expect(parseModelJson('{"a": }')).toBeNull();
  });
});
