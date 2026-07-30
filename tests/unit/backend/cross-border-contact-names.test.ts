import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// THE WAVE A PRECONDITION
//
// Four session records carried the same line: "contact-name masking is not
// built". It was recorded as a missing feature, which is the wrong shape for it.
// The real requirement is that repointing the model provider at anything outside
// РФ must be INCAPABLE of leaking a client's name — not accompanied by a note
// reminding somebody to add masking first.
//
// So the tests below are written as a pair of complementary halves, and both
// halves have to hold or the precondition is not met:
//
//   1. UNDER A FOREIGN PROVIDER, no real contact name reaches the wire. Not from
//      a tool result, not from a nested row, not from the summary prompt, not
//      from the user's own sentence, not from replayed history.
//
//   2. UNDER THE DOMESTIC PROVIDER, absolutely nothing changes. This half is not
//      a formality. Masking that degrades the product today, for a border that
//      is not being crossed today, is masking that gets deleted the first time
//      somebody notices the assistant answering in uuids — and then half 1 is
//      gone too, silently. The cheapest way to keep a control alive is to make
//      it cost nothing while it is not needed.
//
// The fixture names are deliberately distinctive so a hit inside a prompt is
// unambiguous and cannot be a coincidence.
// ---------------------------------------------------------------------------

const dbMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  contact: { findFirst: vi.fn(), findMany: vi.fn() },
  user: { findMany: vi.fn() },
  deal: { findMany: vi.fn() },
  task: { findMany: vi.fn() },
  message: { findMany: vi.fn() },
  calendarEvent: { findMany: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

const yandexGptMock = vi.hoisted(() => ({ createCompletion: vi.fn() }));
vi.mock('../../../backend/services/yandex-gpt', () => yandexGptMock);

import {
  aliasForContactId,
  aliasForUserId,
  aliasNamesInText,
  buildAliasMap,
  buildUserAliasMap,
  containsAlias,
  displayNameOf,
  rehydrateAliases,
} from '../../../backend/services/contact-alias';
import {
  CrossBorderPersonalDataError,
  assertPersonalNamesMayBeSent,
  currentModelProvider,
  isDomesticProvider,
  personalNamesMayBeSent,
} from '../../../backend/services/model-jurisdiction';
import { projectModelFacing } from '../../../backend/mcp/model-projection';
import {
  aliasNamesInOutgoingText,
  rehydrateForDisplay,
} from '../../../backend/services/contact-alias-resolver';
import {
  buildContactContext,
  buildSummaryPrompt,
  suggestContactFields,
  summarizeContact,
  type ContactAiRequester,
  type GenerateTextResult,
} from '../../../backend/services/contact-ai';

const ORG_ID = '77777777-7777-4777-8777-000000000001';
const CALLER_ID = '77777777-7777-4777-8777-00000000000a';
const CONTACT_ID = '77777777-7777-4777-8777-0000000000c1';
const OTHER_CONTACT_ID = '77777777-7777-4777-8777-0000000000c2';
const OPERATOR_ID = '77777777-7777-4777-8777-00000000000b';

/** A customer. Appears nowhere else in the repository. */
const CONTACT_FIRST = 'Аполлинария';
const CONTACT_LAST = 'Загряжская-Тучкова';
/** The surname stem on its own, to catch an inflected or truncated leak. */
const CONTACT_STEM = 'Загряжск';

/** An operator. Handled by a different rule entirely, and must stay handled. */
const OPERATOR_FIO = 'Никодим Ржевусский-Пшеничнов';

const FOREIGN = 'openai';

function setProvider(name: string | undefined): void {
  if (name === undefined) {
    delete process.env.MODEL_PROVIDER;
  } else {
    process.env.MODEL_PROVIDER = name;
  }
}

const originalProvider = process.env.MODEL_PROVIDER;

afterEach(() => {
  setProvider(originalProvider);
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. The gate
// ---------------------------------------------------------------------------

describe('model-jurisdiction — the gate fails closed', () => {
  it('treats the unset default as the domestic provider', () => {
    setProvider(undefined);
    expect(currentModelProvider()).toBe('yandex_foundation_models');
    expect(personalNamesMayBeSent()).toBe(true);
  });

  it('treats an UNRECOGNISED provider as foreign', () => {
    // The single most important assertion in this file. A provider nobody has
    // assessed is exactly the one that must not receive names, so the default
    // for an unknown string is "no" — never "probably fine".
    for (const unknown of ['openai', 'anthropic', 'gigachat', 'some-new-vendor']) {
      setProvider(unknown);
      expect(isDomesticProvider(), `provider=${unknown}`).toBe(false);
      expect(personalNamesMayBeSent(), `provider=${unknown}`).toBe(false);
    }
  });

  it('reads an EMPTY variable as unset, not as an unknown provider', () => {
    // `MODEL_PROVIDER=` in a .env is how a config system spells absence, and the
    // client this backend actually ships is the Yandex one. Resolving empty to
    // "foreign" would disable the assistant for every deployment that declares
    // the variable without a value — a false positive with no privacy gain,
    // since no repoint has happened.
    setProvider('');
    expect(currentModelProvider()).toBe('yandex_foundation_models');
    expect(personalNamesMayBeSent()).toBe(true);
  });

  it('accepts the domestic provider regardless of case or padding', () => {
    for (const spelling of ['yandex_foundation_models', 'YANDEX_FOUNDATION_MODELS', '  yandex_foundation_models  ']) {
      setProvider(spelling);
      expect(personalNamesMayBeSent(), `provider=${spelling}`).toBe(true);
    }
  });

  it('throws rather than returning false, so an inattentive caller cannot proceed', () => {
    setProvider(FOREIGN);
    expect(() => assertPersonalNamesMayBeSent()).toThrow(CrossBorderPersonalDataError);

    setProvider(undefined);
    expect(() => assertPersonalNamesMayBeSent()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. The alias primitive
// ---------------------------------------------------------------------------

describe('contact-alias — the properties the design depends on', () => {
  it('is stable: the same id yields the same alias every time', () => {
    expect(aliasForContactId(CONTACT_ID)).toBe(aliasForContactId(CONTACT_ID));
  });

  it('is derived from the ID and NOT from the name', () => {
    // Two contacts with identical names get different aliases, and one contact
    // keeps its alias across a rename. If the alias were a function of the name
    // it would leak the thing it replaces — an attacker with the alias and a
    // candidate name could confirm the match.
    expect(aliasForContactId(CONTACT_ID)).not.toBe(aliasForContactId(OTHER_CONTACT_ID));

    const before = buildAliasMap([{ id: CONTACT_ID, first_name: 'Иван', last_name: 'Петров' }]);
    const after = buildAliasMap([{ id: CONTACT_ID, first_name: 'Пётр', last_name: 'Иванов' }]);
    expect([...before.keys()]).toEqual([...after.keys()]);
  });

  it('never embeds any part of the name it replaces', () => {
    const alias = aliasForContactId(CONTACT_ID);
    expect(alias).not.toContain(CONTACT_FIRST);
    expect(alias).not.toContain(CONTACT_LAST);
    expect(alias).not.toContain(CONTACT_STEM);
    // Nor the raw uuid: handing a provider a stable primary key across sessions
    // is its own small disclosure.
    expect(alias).not.toContain(CONTACT_ID);
    expect(alias).not.toContain(CONTACT_ID.slice(0, 8));
  });

  it('round-trips prose through alias and back', () => {
    const contacts = [{ id: CONTACT_ID, first_name: CONTACT_FIRST, last_name: CONTACT_LAST }];
    const original = `Позвонить ${CONTACT_FIRST} ${CONTACT_LAST} в пятницу.`;

    const masked = aliasNamesInText(original, contacts);
    expect(masked).not.toContain(CONTACT_FIRST);
    expect(masked).not.toContain(CONTACT_LAST);
    expect(containsAlias(masked)).toBe(true);

    expect(rehydrateAliases(masked, buildAliasMap(contacts))).toBe(original);
  });

  it('consumes the FULL name before the bare first name', () => {
    // Longest-match-first. Replace «Аполлинария» first and the surname survives
    // as a fragment sitting next to the alias, which leaks exactly the thing
    // being hidden.
    const contacts = [{ id: CONTACT_ID, first_name: CONTACT_FIRST, last_name: CONTACT_LAST }];
    const masked = aliasNamesInText(`Встреча: ${CONTACT_FIRST} ${CONTACT_LAST}.`, contacts);

    expect(masked).not.toContain(CONTACT_LAST);
    expect(masked).not.toContain(CONTACT_STEM);
    expect(masked).toBe(`Встреча: ${aliasForContactId(CONTACT_ID)}.`);
  });

  it('catches a suffix-inflected surname, which is the common Russian case', () => {
    const contacts = [{ id: CONTACT_ID, first_name: 'Иван', last_name: 'Иванов' }];
    // Genitive «Иванова», dative «Иванову». The stem match removes the name; the
    // grammatical ending survives as noise. Documented in contact-alias-resolver
    // as a reduction rather than a guarantee — asserted here so the limit is
    // recorded in a test instead of only in a comment.
    const masked = aliasNamesInText('Что по Иванову и Иванова?', contacts);
    expect(masked).not.toContain('Иванов');
  });

  it('leaves an unknown alias visible rather than blanking it', () => {
    // A model that mangled or invented a handle produces something that resolves
    // to nothing. Showing the placeholder is honest; erasing it would hide that
    // the answer referred to something we could not identify.
    const stray = 'Клиент ZZZZ просил перезвонить.';
    expect(rehydrateAliases(stray, new Map())).toBe(stray);
  });

  it('skips contacts with no usable name', () => {
    // Issuing an alias for a nameless contact would tell the model a name exists
    // when it does not.
    expect(buildAliasMap([{ id: CONTACT_ID, first_name: '  ', last_name: null }]).size).toBe(0);
    expect(displayNameOf({ id: CONTACT_ID, first_name: 'Иван', last_name: null })).toBe('Иван');
  });
});

// ---------------------------------------------------------------------------
// 3. The projection under a foreign provider
// ---------------------------------------------------------------------------

function dealRow(): Record<string, unknown> {
  return {
    id: 'd1',
    title: 'Поставка оборудования',
    pipeline: { id: 'p1', name: 'Основная воронка' },
    stage: { id: 's1', name: 'Переговоры' },
    assignee: { id: OPERATOR_ID, name: OPERATOR_FIO },
    contact: { id: CONTACT_ID, first_name: CONTACT_FIRST, last_name: CONTACT_LAST },
  };
}

describe('projectModelFacing — foreign provider', () => {
  beforeEach(() => setProvider(FOREIGN));

  it('replaces a nested contact name with its alias', () => {
    const out = projectModelFacing(dealRow()) as Record<string, any>;

    expect(JSON.stringify(out)).not.toContain(CONTACT_FIRST);
    expect(JSON.stringify(out)).not.toContain(CONTACT_LAST);
    expect(out.contact.first_name).toBe(aliasForContactId(CONTACT_ID));
    expect(out.contact.last_name).toBeUndefined();
    // The id survives: the model chains tool calls on it, and it is not a name.
    expect(out.contact.id).toBe(CONTACT_ID);
  });

  it('still drops the operator ФИО, which is a different rule', () => {
    const out = projectModelFacing(dealRow()) as Record<string, any>;
    expect(JSON.stringify(out)).not.toContain(OPERATOR_FIO);
    expect(out.assignee).toEqual({ id: OPERATOR_ID });
  });

  it('does NOT touch pipeline or stage names', () => {
    // The reason a key-name matcher could never have done this job. If these go,
    // the assistant loses the vocabulary it needs to answer anything.
    const out = projectModelFacing(dealRow()) as Record<string, any>;
    expect(out.pipeline.name).toBe('Основная воронка');
    expect(out.stage.name).toBe('Переговоры');
    expect(out.title).toBe('Поставка оборудования');
  });

  it('aliases a contact at the top level and inside a list', () => {
    const out = projectModelFacing({
      data: [
        { id: CONTACT_ID, first_name: CONTACT_FIRST, last_name: CONTACT_LAST },
        { id: OTHER_CONTACT_ID, first_name: 'Мстислав', last_name: 'Кологривов' },
      ],
    }) as Record<string, any>;

    expect(out.data[0].first_name).toBe(aliasForContactId(CONTACT_ID));
    expect(out.data[1].first_name).toBe(aliasForContactId(OTHER_CONTACT_ID));
    expect(out.data[0].first_name).not.toBe(out.data[1].first_name);
    expect(JSON.stringify(out)).not.toContain('Кологривов');
  });

  it('accepts contact_id where a hand-built payload uses it instead of id', () => {
    const out = projectModelFacing({
      contact_id: CONTACT_ID,
      first_name: CONTACT_FIRST,
    }) as Record<string, any>;
    expect(out.first_name).toBe(aliasForContactId(CONTACT_ID));
  });

  it('DROPS the name when there is no identifier to derive an alias from', () => {
    // No id means no alias can be derived. The name goes with it rather than
    // through — the failure direction the whole module exists to guarantee.
    const out = projectModelFacing({ first_name: CONTACT_FIRST, last_name: CONTACT_LAST }) as Record<string, any>;
    expect(out.first_name).toBeUndefined();
    expect(out.last_name).toBeUndefined();
  });

  it('strips every name-shaped key on the contact, not only first/last', () => {
    const out = projectModelFacing({
      id: CONTACT_ID,
      first_name: CONTACT_FIRST,
      last_name: CONTACT_LAST,
      middle_name: 'Аркадьевна',
      display_name: `${CONTACT_FIRST} ${CONTACT_LAST}`,
      full_name: `${CONTACT_FIRST} ${CONTACT_LAST}`,
      company: 'ООО «Ромашка»',
    }) as Record<string, any>;

    expect(out.first_name).toBe(aliasForContactId(CONTACT_ID));
    expect(out.middle_name).toBeUndefined();
    expect(out.display_name).toBeUndefined();
    expect(out.full_name).toBeUndefined();
    // Company is not a natural person's name and stays.
    expect(out.company).toBe('ООО «Ромашка»');
  });

  it('gives an operator container priority over the contact rule', () => {
    // `assignee: { first_name }` is an OPERATOR. It must be dropped outright,
    // not aliased as though it were a customer.
    const out = projectModelFacing({
      assignee: { id: OPERATOR_ID, first_name: 'Никодим', last_name: 'Ржевусский' },
    }) as Record<string, any>;

    expect(out.assignee).toEqual({ id: OPERATOR_ID });
    expect(JSON.stringify(out)).not.toContain('Никодим');
  });
});

// ---------------------------------------------------------------------------
// 4. The projection under the domestic provider — the non-regression half
// ---------------------------------------------------------------------------

describe('projectModelFacing — domestic provider leaves contacts untouched', () => {
  beforeEach(() => setProvider(undefined));

  it('passes the contact name through in full', () => {
    // ст. 12 is not engaged, the name may lawfully be processed, and an
    // assistant that answers in pseudonyms for no reason is a worse product.
    const out = projectModelFacing(dealRow()) as Record<string, any>;
    expect(out.contact.first_name).toBe(CONTACT_FIRST);
    expect(out.contact.last_name).toBe(CONTACT_LAST);
    expect(containsAlias(JSON.stringify(out))).toBe(false);
  });

  it('still drops the operator ФИО — that rule is unconditional', () => {
    const out = projectModelFacing(dealRow()) as Record<string, any>;
    expect(out.assignee).toEqual({ id: OPERATOR_ID });
  });
});

// ---------------------------------------------------------------------------
// 5. The prose paths, which have no shape to key on
// ---------------------------------------------------------------------------

describe('contact-alias-resolver — free text in both directions', () => {
  it('aliases a name the USER typed, which never was a tool result', () => {
    setProvider(FOREIGN);
    dbMock.contact.findMany.mockResolvedValue([
      { id: CONTACT_ID, first_name: CONTACT_FIRST, last_name: CONTACT_LAST },
    ]);

    return aliasNamesInOutgoingText(ORG_ID, `Что там по ${CONTACT_LAST}?`).then((out) => {
      expect(out).not.toContain(CONTACT_LAST);
      expect(out).not.toContain(CONTACT_STEM);
      expect(containsAlias(out)).toBe(true);
    });
  });

  it('scopes the contact lookup to the caller organisation', async () => {
    setProvider(FOREIGN);
    dbMock.contact.findMany.mockResolvedValue([]);

    await aliasNamesInOutgoingText(ORG_ID, 'что нового');

    expect(dbMock.contact.findMany.mock.calls[0][0].where).toMatchObject({
      organization_id: ORG_ID,
    });
  });

  it('costs ZERO queries under the domestic provider', async () => {
    // The property that keeps this control alive. If it taxed every assistant
    // turn with a contact scan while protecting a border nobody is crossing, the
    // next person to profile the endpoint would delete it.
    setProvider(undefined);

    expect(await aliasNamesInOutgoingText(ORG_ID, `Что там по ${CONTACT_LAST}?`)).toBe(
      `Что там по ${CONTACT_LAST}?`,
    );
    expect(dbMock.contact.findMany).not.toHaveBeenCalled();
  });

  it('costs zero queries when the text holds no alias to resolve', async () => {
    setProvider(FOREIGN);
    expect(await rehydrateForDisplay(ORG_ID, 'Ответ без имён.')).toBe('Ответ без имён.');
    expect(dbMock.contact.findMany).not.toHaveBeenCalled();
  });

  it('rehydrates a contact alias back into the real name', async () => {
    setProvider(FOREIGN);
    dbMock.contact.findMany.mockResolvedValue([
      { id: CONTACT_ID, first_name: CONTACT_FIRST, last_name: CONTACT_LAST },
    ]);
    dbMock.user.findMany.mockResolvedValue([]);

    const modelAnswer = `${aliasForContactId(CONTACT_ID)} ждёт коммерческое предложение.`;
    const shown = await rehydrateForDisplay(ORG_ID, modelAnswer);

    expect(shown).toBe(`${CONTACT_FIRST} ${CONTACT_LAST} ждёт коммерческое предложение.`);
  });

  it('resolves an operator and a contact in the SAME sentence', async () => {
    // One answer can carry both kinds. Resolving half of it would leave a raw
    // handle in the middle of finished Russian prose.
    setProvider(FOREIGN);
    dbMock.contact.findMany.mockResolvedValue([
      { id: CONTACT_ID, first_name: CONTACT_FIRST, last_name: CONTACT_LAST },
    ]);
    dbMock.user.findMany.mockResolvedValue([{ id: OPERATOR_ID, name: OPERATOR_FIO }]);

    const shown = await rehydrateForDisplay(
      ORG_ID,
      `${aliasForUserId(OPERATOR_ID)} закрыл сделку с ${aliasForContactId(CONTACT_ID)}.`,
    );

    expect(shown).toBe(`${OPERATOR_FIO} закрыл сделку с ${CONTACT_FIRST} ${CONTACT_LAST}.`);
    expect(containsAlias(shown)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5b. get_rep_performance — the one tool the MCP projection does not stand behind
// ---------------------------------------------------------------------------

describe('operator aliasing — decision 002 option (b), scoped to the border', () => {
  it('gives an operator a different alias namespace from a contact', () => {
    // Even if the two ids hashed to the same token, the prefixes keep «Клиент»
    // and «Сотрудник» apart — the model must be able to tell a customer from a
    // colleague to answer anything useful.
    expect(aliasForUserId(OPERATOR_ID)).toContain('Сотрудник');
    expect(aliasForContactId(CONTACT_ID)).toContain('Клиент');
    expect(aliasForUserId(CONTACT_ID)).not.toBe(aliasForContactId(CONTACT_ID));
  });

  it('round-trips an operator ФИО through the alias and back', () => {
    const map = buildUserAliasMap([{ id: OPERATOR_ID, name: OPERATOR_FIO }]);
    const prose = `Лучший результат у ${aliasForUserId(OPERATOR_ID)}.`;

    expect(prose).not.toContain(OPERATOR_FIO);
    expect(rehydrateAliases(prose, map)).toBe(`Лучший результат у ${OPERATOR_FIO}.`);
  });

  it('skips an operator with no name rather than issuing an empty alias', () => {
    expect(buildUserAliasMap([{ id: OPERATOR_ID, name: '   ' }]).size).toBe(0);
    expect(buildUserAliasMap([{ id: OPERATOR_ID, name: null }]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. contact-ai: a direct createCompletion that bypasses the MCP boundary
// ---------------------------------------------------------------------------

function contactRow(): Record<string, unknown> {
  return {
    id: CONTACT_ID,
    organization_id: ORG_ID,
    first_name: CONTACT_FIRST,
    last_name: CONTACT_LAST,
    company: 'ООО «Ромашка»',
    type: 'lead',
    status: 'active',
    source: 'сайт',
    tags: [],
    notes: 'Просил перезвонить в июле.',
    created_at: new Date('2026-01-15T10:00:00.000Z'),
    assigned_to: CALLER_ID,
    created_by: CALLER_ID,
  };
}

const caller: ContactAiRequester = { sub: CALLER_ID, org_id: ORG_ID, role: 'owner' };

describe('contact-ai — the summary prompt', () => {
  beforeEach(() => {
    dbMock.$queryRaw.mockResolvedValue([{ id: CALLER_ID }]);
    dbMock.contact.findFirst.mockResolvedValue(contactRow());
    dbMock.deal.findMany.mockResolvedValue([]);
    dbMock.task.findMany.mockResolvedValue([]);
    dbMock.message.findMany.mockResolvedValue([]);
    dbMock.calendarEvent.findMany.mockResolvedValue([]);
  });

  it('sends the alias, never the name, under a foreign provider', async () => {
    setProvider(FOREIGN);

    const context = await buildContactContext(contactRow() as never, ORG_ID);
    const prompt = buildSummaryPrompt(context);

    expect(context.display_name).toBe(aliasForContactId(CONTACT_ID));
    expect(prompt).not.toContain(CONTACT_FIRST);
    expect(prompt).not.toContain(CONTACT_LAST);
    expect(prompt).not.toContain(CONTACT_STEM);
  });

  it('sends the real name under the domestic provider', async () => {
    setProvider(undefined);

    const context = await buildContactContext(contactRow() as never, ORG_ID);
    expect(context.display_name).toBe(`${CONTACT_FIRST} ${CONTACT_LAST}`);
    expect(buildSummaryPrompt(context)).toContain(CONTACT_LAST);
  });

  it('restores the name in the summary the operator reads', async () => {
    setProvider(FOREIGN);
    const alias = aliasForContactId(CONTACT_ID);

    const generateText = vi.fn(
      async (): Promise<GenerateTextResult> => ({
        ok: true,
        text: JSON.stringify({
          summary: `${alias} в активной работе.`,
          next_action: `Позвонить ${alias} в пятницу.`,
        }),
      }),
    );

    const result = await summarizeContact({
      contactId: CONTACT_ID,
      requester: caller,
      deps: { generateText },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The user gets Russian, not a handle. The masking is invisible to them,
    // which is the only reason it survives contact with the product.
    expect(result.data.summary).toBe(`${CONTACT_FIRST} ${CONTACT_LAST} в активной работе.`);
    expect(result.data.next_action).toBe(
      `Позвонить ${CONTACT_FIRST} ${CONTACT_LAST} в пятницу.`,
    );
    expect(containsAlias(result.data.summary)).toBe(false);
  });
});

describe('contact-ai — autofill is the one path that cannot be aliased', () => {
  it('refuses under a foreign provider instead of sending the ФИО', async () => {
    setProvider(FOREIGN);
    const generateText = vi.fn();

    const result = await suggestContactFields({
      text: `${CONTACT_FIRST} ${CONTACT_LAST}, коммерческий директор`,
      deps: { generateText },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CROSS_BORDER_PERSONAL_DATA');
    expect(result.status).toBe(503);
    // The decisive assertion: the model was never called at all.
    expect(generateText).not.toHaveBeenCalled();
  });

  it('works normally under the domestic provider', async () => {
    setProvider(undefined);
    const generateText = vi.fn(
      async (): Promise<GenerateTextResult> => ({
        ok: true,
        text: JSON.stringify({ first_name: CONTACT_FIRST, last_name: CONTACT_LAST }),
      }),
    );

    const result = await suggestContactFields({
      text: `${CONTACT_FIRST} ${CONTACT_LAST}, коммерческий директор`,
      deps: { generateText },
    });

    expect(result.ok).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
