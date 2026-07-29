import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// POST /api/v1/tasks/suggest-contact
//
// Three things are under test here and they are not the same thing:
//
//  1. The silent-null contract. Every failure branch, every ambiguous title and
//     every title that names nobody must answer `{ data: { contact: null } }`.
//     The client renders "no suggestion" and has no branch for an error, so
//     anything else is a broken screen.
//
//  2. That the endpoint reaches NO language model at all. This route used to
//     ship up to 300 Russian customers' full names to api.anthropic.com on
//     every call — ст. 12 ФЗ-152 with no filing. Routing it through the
//     domestic yandex-gpt seam moved the destination without shrinking the
//     payload, and Wave A repoints that seam at OpenAI. Matching in process is
//     what ends it, so the assertions here are about the ABSENCE of a provider
//     call, not about which provider is called.
//
//  3. That the matching itself is right on Russian names, because the model
//     that used to paper over the hard cases is gone. Case endings, ties, and
//     the specific over-stemming trap that rules out PostgreSQL's 'russian'
//     Snowball config all have to hold in code now.
// ---------------------------------------------------------------------------

const dbMock = vi.hoisted(() => ({
  contact: { findMany: vi.fn() },
  task: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  user: { findMany: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

// createCompletion is still mocked even though the controller must no longer
// import it: a mock nobody calls is what lets afterEach prove, on every single
// test, that no branch went back to a model.
const yandexMock = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  isYandexGptConfigured: vi.fn(),
}));

vi.mock('../../../backend/services/yandex-gpt', () => yandexMock);

import { TasksController } from '../../../backend/api/controllers/tasks';
import { matchContactByName, sameName } from '../../../backend/services/contact-name-match';

const ORG_ID = '00000000-0000-4000-a000-0000000000aa';
const USER_ID = '00000000-0000-4000-a000-000000000001';

const CONTACT_A = { id: '11111111-1111-4111-8111-111111111111', first_name: 'Иван', last_name: 'Петров' };
const CONTACT_B = { id: '22222222-2222-4222-8222-222222222222', first_name: 'Мария', last_name: null };
const CONTACT_C = { id: '33333333-3333-4333-8333-333333333333', first_name: 'Иван', last_name: 'Сидоров' };
const CONTACT_D = { id: '44444444-4444-4444-8444-444444444444', first_name: 'Мария', last_name: 'Петрова' };

const CONTROLLER_SOURCE_PATH = fileURLToPath(
  new URL('../../../backend/api/controllers/tasks.ts', import.meta.url).href,
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type SentPayload = { data: { contact: unknown } };

function makeReply() {
  const sent: SentPayload[] = [];
  const reply = {
    sent,
    status: vi.fn(() => reply),
    send: vi.fn((payload: SentPayload) => {
      sent.push(payload);
      return reply;
    }),
  };
  return reply;
}

function makeRequest(title: string) {
  return {
    body: { title },
    user: { sub: USER_ID, org_id: ORG_ID, role: 'owner' },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
}

async function callSuggestContact(title = 'Позвонить Ивану Петрову') {
  const request = makeRequest(title);
  const reply = makeReply();
  await TasksController.suggestContact(request as never, reply as never);
  return { request, reply };
}

/** Every outbound fetch attempted during a test, whoever made it. */
let fetchTargets: string[] = [];

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  const asRequest = input as { url?: unknown };
  return typeof asRequest?.url === 'string' ? asRequest.url : String(input);
}

beforeEach(() => {
  fetchTargets = [];

  dbMock.contact.findMany.mockReset();
  dbMock.contact.findMany.mockResolvedValue([CONTACT_A, CONTACT_B]);

  yandexMock.createCompletion.mockReset();
  yandexMock.isYandexGptConfigured.mockReset();
  yandexMock.isYandexGptConfigured.mockReturnValue(true);

  // The unit suite never talks to the network. Recording the attempt rather
  // than letting it through is what makes a provider regression visible: an SDK
  // dials its host through global fetch.
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const url = urlOf(input);
    fetchTargets.push(url);
    throw new Error(`unit tests must not reach the network: ${url}`);
  }) as typeof fetch);
});

afterEach(() => {
  // Asserted after EVERY test in this file, not only the dedicated ones, so no
  // branch can be the one that quietly dials out or reinstates a model call.
  expect(fetchTargets).toEqual([]);
  expect(yandexMock.createCompletion).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The null contract
// ---------------------------------------------------------------------------

describe('tasks.suggestContact — silent-null contract', () => {
  it('returns null and skips the query when the AI surface is not configured', async () => {
    // The matcher needs no provider, but this flag is the switch deployments
    // (and every local dev machine) already use to keep the suggestion modal
    // off. Removing the model must not make the modal appear everywhere.
    yandexMock.isYandexGptConfigured.mockReturnValue(false);

    const { reply } = await callSuggestContact();

    expect(reply.send).toHaveBeenCalledTimes(1);
    expect(reply.sent[0]).toEqual({ data: { contact: null } });
    expect(dbMock.contact.findMany).not.toHaveBeenCalled();
  });

  it('returns null when the org has no contacts', async () => {
    dbMock.contact.findMany.mockResolvedValue([]);

    const { reply } = await callSuggestContact();

    expect(reply.sent[0]).toEqual({ data: { contact: null } });
  });

  it('returns null when the title names nobody', async () => {
    for (const title of [
      'Купить бумагу для принтера',
      'Отправить отчёт за квартал',
      'Продлить домен',
      '???',
    ]) {
      const { reply } = await callSuggestContact(title);

      expect(reply.sent[0], `title: ${title}`).toEqual({ data: { contact: null } });
    }
  });

  it('returns null when two contacts match the title equally well', async () => {
    // "Позвонить Ивану" with two Иваны on file is not a hard problem, it is an
    // unanswerable one. The client has no way to present a tie.
    dbMock.contact.findMany.mockResolvedValue([CONTACT_A, CONTACT_C]);

    const { reply } = await callSuggestContact('Позвонить Ивану');

    expect(reply.sent[0]).toEqual({ data: { contact: null } });
  });

  it('returns null when a surname is shared by two contacts', async () => {
    dbMock.contact.findMany.mockResolvedValue([CONTACT_A, CONTACT_D]);

    const { reply } = await callSuggestContact('Позвонить Петровой');

    expect(reply.sent[0]).toEqual({ data: { contact: null } });
  });

  it('returns null when the contact query throws', async () => {
    dbMock.contact.findMany.mockRejectedValue(new Error('connection refused'));

    const { request, reply } = await callSuggestContact();

    expect(reply.send).toHaveBeenCalledTimes(1);
    expect(reply.sent[0]).toEqual({ data: { contact: null } });
    expect(request.log.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What it does suggest
// ---------------------------------------------------------------------------

describe('tasks.suggestContact — suggestions', () => {
  it('resolves a full name in the dative case', async () => {
    const { reply } = await callSuggestContact('Позвонить Ивану Петрову');

    expect(reply.sent[0]).toEqual({ data: { contact: CONTACT_A } });
  });

  it('ignores capitalisation, because the client does not supply it', async () => {
    // src/app/task/new.tsx sets no autoCapitalize on the title field, so React
    // Native's 'sentences' default capitalises only the first word — every name
    // typed after it arrives lower-case.
    const { reply } = await callSuggestContact('позвонить ивану петрову');

    expect(reply.sent[0]).toEqual({ data: { contact: CONTACT_A } });
  });

  it('resolves a contact who has no surname on file', async () => {
    const { reply } = await callSuggestContact('Написать Марии по договору');

    expect(reply.sent[0]).toEqual({ data: { contact: CONTACT_B } });
  });

  it('prefers the contact whose first name AND surname are both named', async () => {
    dbMock.contact.findMany.mockResolvedValue([CONTACT_C, CONTACT_A]);

    const { reply } = await callSuggestContact('позвонить ивану петрову');

    expect(reply.sent[0]).toEqual({ data: { contact: CONTACT_A } });
  });

  it('resolves a diminutive used in place of the first name', async () => {
    dbMock.contact.findMany.mockResolvedValue([CONTACT_A, CONTACT_D]);

    const { reply } = await callSuggestContact('Позвонить Ване Петрову');

    expect(reply.sent[0]).toEqual({ data: { contact: CONTACT_A } });
  });
});

// ---------------------------------------------------------------------------
// No provider, on any branch
// ---------------------------------------------------------------------------

describe('tasks.suggestContact — no model in the loop', () => {
  it('calls no provider on any branch', async () => {
    const branches: Array<[string, () => void]> = [
      ['unconfigured', () => yandexMock.isYandexGptConfigured.mockReturnValue(false)],
      ['no contacts', () => dbMock.contact.findMany.mockResolvedValue([])],
      ['tie', () => dbMock.contact.findMany.mockResolvedValue([CONTACT_A, CONTACT_C])],
      ['match', () => dbMock.contact.findMany.mockResolvedValue([CONTACT_A, CONTACT_B])],
      ['db down', () => dbMock.contact.findMany.mockRejectedValue(new Error('db down'))],
    ];

    for (const [name, arrange] of branches) {
      arrange();
      const { reply } = await callSuggestContact();
      expect(reply.send, `branch: ${name}`).toHaveBeenCalledTimes(1);
    }

    // The afterEach hook re-asserts both of these, but stating them here keeps
    // the intent of this test readable on its own.
    expect(fetchTargets).toEqual([]);
    expect(yandexMock.createCompletion).not.toHaveBeenCalled();
  });

  it('leaves no provider client and no completion call behind in the controller', () => {
    const source = readFileSync(CONTROLLER_SOURCE_PATH, 'utf8');

    // Comments in this file discuss the removed providers on purpose, so only
    // code-shaped occurrences count.
    expect(source).not.toMatch(/from\s+['"]@anthropic-ai\/sdk['"]/);
    expect(source).not.toMatch(/require\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/);
    expect(source).not.toMatch(/new\s+Anthropic\s*\(/);
    expect(source).not.toMatch(/process\.env\.ANTHROPIC_API_KEY/);
    expect(source).not.toMatch(/claude-[a-z0-9.-]*\d/i);

    // This assertion is the inverse of the one it replaces. That one required
    // an import from ../../services/yandex-gpt, to prove the model call went
    // through the DOMESTIC seam rather than to Anthropic. There is no model
    // call left to route, and that seam is what Wave A repoints at OpenAI, so
    // requiring it would now require the border crossing back. The import
    // stays, but only for the configuration flag.
    const yandexImport = source.match(
      /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/\.\.\/services\/yandex-gpt['"]/,
    );
    expect(yandexImport).not.toBeNull();
    expect(yandexImport?.[1]).toContain('isYandexGptConfigured');
    expect(yandexImport?.[1]).not.toContain('createCompletion');

    expect(source).not.toMatch(/\bcreateCompletion\s*\(/);
    expect(source).toMatch(
      /import\s*\{[^}]*matchContactByName[^}]*\}\s*from\s*['"]\.\.\/\.\.\/services\/contact-name-match['"]/,
    );
  });
});

// ---------------------------------------------------------------------------
// The matcher itself
// ---------------------------------------------------------------------------

describe('contact-name-match — Russian case endings', () => {
  it('treats declined forms of one name as the same name', () => {
    const groups = [
      ['иван', 'ивана', 'ивану', 'иваном', 'иване'],
      ['петров', 'петрова', 'петрову', 'петровым', 'петрове'],
      ['петрова', 'петровой', 'петрову', 'петровою'],
      ['мария', 'марии', 'марию', 'марией'],
      ['сергей', 'сергея', 'сергею', 'сергеем'],
      ['ольга', 'ольги', 'ольге', 'ольгу', 'ольгой'],
      ['иванович', 'ивановича', 'ивановичу', 'ивановичем'],
      ['ивановна', 'ивановны', 'ивановне', 'ивановну', 'ивановной'],
      ['наталья', 'натальи', 'наталье', 'наталью', 'натальей'],
      ['лебедь', 'лебедя', 'лебедю', 'лебедем'],
      ['толстой', 'толстого', 'толстому', 'толстом'],
      ['достоевская', 'достоевской', 'достоевскую'],
    ];

    for (const [nominative, ...oblique] of groups) {
      for (const form of oblique) {
        expect(sameName(form, nominative), `${form} ↔ ${nominative}`).toBe(true);
        expect(sameName(nominative, form), `${nominative} ↔ ${form}`).toBe(true);
      }
    }
  });

  it('normalises ё to е so Соловьёв and Пётр decline', () => {
    // sameName takes tokens that have already been through nameTokens, so ё is
    // exercised through the public entry point — in both directions, since a
    // contact may be stored with ё while the title is typed without it, or the
    // other way round.
    const solovyov = { id: 'ё1', first_name: 'Пётр', last_name: 'Соловьёв' };
    const plain = { id: 'ё2', first_name: 'Петр', last_name: 'Соловьев' };

    expect(matchContactByName('позвонить петру соловьеву', [solovyov])).toBe(solovyov);
    expect(matchContactByName('позвонить пётру соловьёву', [plain])).toBe(plain);
  });

  it('does not strip the surname-forming suffix, which is what rules out Snowball', () => {
    // PostgreSQL's 'russian' config stems Петров→петр but Петрова→петров, so it
    // both misses the real match and invents a false one against Пётр. Neither
    // may happen here.
    for (const [a, b] of [
      ['петров', 'петр'],
      ['иванов', 'иван'],
      ['романов', 'роман'],
      ['борисов', 'борис'],
      ['кузнецов', 'кузнец'],
      ['иванов', 'иванко'],
      ['иванова', 'ивановна'],
      ['мария', 'марина'],
      ['ирина', 'ира'],
      ['сергеев', 'сергее'],
    ]) {
      expect(sameName(a, b), `${a} must not equal ${b}`).toBe(false);
      expect(sameName(b, a), `${b} must not equal ${a}`).toBe(false);
    }
  });

  it('refuses to guess on a two-letter stem', () => {
    expect(sameName('ян', 'яна')).toBe(false);
    expect(sameName('ева', 'еве')).toBe(false);
    expect(sameName('ян', 'ян')).toBe(true);
  });
});

describe('contact-name-match — candidate selection', () => {
  const CANDIDATES = [CONTACT_A, CONTACT_B, CONTACT_C, CONTACT_D];

  it('matches a patronymic stored in first_name', () => {
    const ivanIvanovich = { id: 'x', first_name: 'Иван Иванович', last_name: 'Петров' };

    expect(matchContactByName('встреча с иваном ивановичем', [ivanIvanovich, CONTACT_B]))
      .toBe(ivanIvanovich);
  });

  it('matches a contact stored under a diminutive from the full name in the title', () => {
    const vanya = { id: 'y', first_name: 'Ваня', last_name: 'Козлов' };

    expect(matchContactByName('позвонить ивану', [vanya, CONTACT_B])).toBe(vanya);
  });

  it('returns null rather than picking between equal scores', () => {
    expect(matchContactByName('позвонить ивану', CANDIDATES)).toBeNull();
    expect(matchContactByName('позвонить петровой', CANDIDATES)).toBeNull();
  });

  it('returns null for a title with nothing to match', () => {
    expect(matchContactByName('', CANDIDATES)).toBeNull();
    expect(matchContactByName('   ', CANDIDATES)).toBeNull();
    expect(matchContactByName('обновить прайс-лист', CANDIDATES)).toBeNull();
    expect(matchContactByName('позвонить ивану', [])).toBeNull();
  });

  it('ignores digits and punctuation inside a stored name', () => {
    // Imported rows carry things like "Иван (склад №2)". Only letters are
    // tokenised, so the noise neither matches nor blocks a match.
    const noisy = { id: 'n', first_name: 'Иван (склад №2)', last_name: 'Петров-мл.' };

    expect(matchContactByName('позвонить ивану петрову', [noisy])).toBe(noisy);
  });

  it('does not let a repeated name part inflate a contact past a fuller match', () => {
    const doubled = { id: 'z', first_name: 'Иван', last_name: 'Иван' };

    expect(matchContactByName('позвонить ивану петрову', [doubled, CONTACT_A])).toBe(CONTACT_A);
  });
});
