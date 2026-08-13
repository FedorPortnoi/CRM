import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The lead-inbox poller: Яндекс Бизнес «Заявки» → воронка.
//
// No sockets: the IMAP client is a scripted fake injected through the
// factory seam, and mailparser runs for real over RFC822 fixtures. What is
// pinned here is the duplicate-safety contract — the LeadInboxMessage claim
// is taken BEFORE anything is created, a lost claim means no second deal,
// and a poison message is recorded and flagged \Seen instead of being
// re-fetched every minute forever.
// ---------------------------------------------------------------------------

process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? 'y'.repeat(48);
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48);

const dbMock = vi.hoisted(() => ({
  leadInbox: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  leadInboxMessage: {
    createMany: vi.fn(),
    updateMany: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  contact: { findFirst: vi.fn() },
  pipeline: { findFirst: vi.fn() },
  pipelineStage: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

const createContactForUser = vi.hoisted(() => vi.fn());
const createDealForUser = vi.hoisted(() => vi.fn());
const dispatchNotification = vi.hoisted(() => vi.fn());
const dealCtx = vi.hoisted(() => vi.fn());
vi.mock('../../../backend/services/contact-domain', () => ({ createContactForUser }));
vi.mock('../../../backend/services/deal-domain', () => ({ createDealForUser }));
vi.mock('../../../backend/services/notificationEngine', () => ({ dispatchNotification, dealCtx }));

const { encryptField } = await import('../../../backend/services/encryption');
const { pollInbox, pollCollectorForInboxes, runLeadInboxTick, upsertLeadInbox, LeadInboxError } =
  await import('../../../backend/services/lead-inbox');

const ORG = '77777777-7777-4777-8777-000000000001';
const ADMIN = '77777777-7777-4777-8777-00000000000a';
const MOM = '77777777-7777-4777-8777-00000000000b';

function makeInbox(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inbox-1',
    organization_id: ORG,
    mode: 'custom',
    intake_token: null,
    imap_host: 'imap.yandex.ru',
    imap_port: 993,
    imap_user: 'leads@example.ru',
    imap_password_enc: encryptField('app-password'),
    pipeline_id: null,
    stage_id: null,
    assigned_to: MOM,
    source_label: 'Яндекс Карты',
    status: 'active',
    last_polled_at: null,
    last_error: null,
    created_by: ADMIN,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as never;
}

function rfc822(
  body: string,
  messageId = '<zayavka-1@business.yandex.ru>',
  to = 'leads@example.ru',
): string {
  return [
    'From: Yandex Business <noreply@business.yandex.ru>',
    `To: ${to}`,
    'Subject: Novaya zayavka',
    `Message-ID: ${messageId}`,
    'Date: Thu, 13 Aug 2026 10:00:00 +0300',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n');
}

const ZAYAVKA_BODY = [
  'Имя: Мария Иванова',
  'Телефон: +7 (912) 345-67-89',
  'Комментарий: Нужна настройка рекламы',
].join('\r\n');

function fakeImap(messages: Record<number, string>) {
  const seen: number[] = [];
  const client = {
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    mailbox: { uidValidity: 42n },
    search: vi.fn(async () => Object.keys(messages).map(Number)),
    fetchOne: vi.fn(async (seq: string) => ({ source: Buffer.from(messages[Number(seq)], 'utf8') })),
    messageFlagsAdd: vi.fn(async (seq: string) => {
      seen.push(Number(seq));
      return true;
    }),
    logout: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  return { client, seen, factory: () => client as never };
}

beforeEach(() => {
  vi.clearAllMocks();

  dbMock.leadInboxMessage.createMany.mockResolvedValue({ count: 1 });
  dbMock.leadInboxMessage.updateMany.mockResolvedValue({ count: 1 });
  dbMock.leadInboxMessage.findFirst.mockResolvedValue(null);
  dbMock.contact.findFirst.mockResolvedValue(null);
  dbMock.pipeline.findFirst.mockResolvedValue({ id: 'pipe-1' });
  dbMock.pipelineStage.findFirst.mockResolvedValue({ id: 'stage-1' });
  // Any active-user lookup answers "yes, that user exists and is active".
  dbMock.user.findFirst.mockImplementation(async (args: { where: { id?: string } }) =>
    args.where.id ? { id: args.where.id } : { id: ADMIN },
  );
  dbMock.leadInbox.update.mockResolvedValue({});
  createContactForUser.mockResolvedValue({ id: 'contact-1' });
  createDealForUser.mockResolvedValue({ id: 'deal-1' });
  dispatchNotification.mockResolvedValue(undefined);
  dealCtx.mockResolvedValue({
    id: 'deal-1',
    title: 'Заявка: Мария Иванова',
    owner: { id: MOM, name: 'Светлана', push_token: null },
    creator: { id: ADMIN, name: 'Админ', push_token: null },
  });
});

describe('pollInbox', () => {
  it('turns a заявка email into a contact and an assigned deal in the funnel', async () => {
    const { seen, factory } = fakeImap({ 101: rfc822(ZAYAVKA_BODY) });

    const summary = await pollInbox(makeInbox(), factory);

    expect(summary).toMatchObject({ scanned: 1, created: 1, duplicates: 0, failed: 0 });

    // The claim precedes creation, keyed on inbox + uidvalidity + uid.
    expect(dbMock.leadInboxMessage.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            inbox_id: 'inbox-1',
            uid_validity: 42n,
            message_uid: 101,
            organization_id: ORG,
          }),
        ],
        skipDuplicates: true,
      }),
    );

    expect(createContactForUser).toHaveBeenCalledWith(
      ORG,
      ADMIN,
      expect.objectContaining({
        first_name: 'Мария',
        last_name: 'Иванова',
        phone: '+79123456789',
        source: 'Яндекс Карты',
        type: 'lead',
        assigned_to: MOM,
      }),
    );

    expect(createDealForUser).toHaveBeenCalledWith(
      ORG,
      ADMIN,
      expect.objectContaining({
        title: 'Заявка: Мария Иванова',
        contact_id: 'contact-1',
        pipeline_id: 'pipe-1',
        stage_id: 'stage-1',
        source: 'Яндекс Карты',
        assigned_to: MOM,
      }),
      // The generic deal.assigned buzz is suppressed — lead.new below replaces it.
      { silentAssignment: true },
    );

    // Exactly one notification, with the CLIENT's words, to the assignee.
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'lead.new',
        orgId: ORG,
        source: 'Яндекс Карты',
        details: expect.stringContaining('Мария Иванова'),
      }),
    );
    expect(dispatchNotification.mock.calls[0][0].details).toContain('+79123456789');
    expect(dispatchNotification.mock.calls[0][0].details).toContain('Нужна настройка рекламы');

    expect(dbMock.leadInboxMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'processed', deal_id: 'deal-1' }),
      }),
    );

    expect(seen).toContain(101);
  });

  it('creates nothing when the claim is already taken', async () => {
    dbMock.leadInboxMessage.createMany.mockResolvedValue({ count: 0 });
    const { seen, factory } = fakeImap({ 101: rfc822(ZAYAVKA_BODY) });

    const summary = await pollInbox(makeInbox(), factory);

    expect(summary.duplicates).toBe(1);
    expect(createContactForUser).not.toHaveBeenCalled();
    expect(createDealForUser).not.toHaveBeenCalled();
    // Still flagged \Seen, or the duplicate would be re-scanned every minute.
    expect(seen).toContain(101);
  });

  it('assigns to the org owner when no assignee is configured', async () => {
    const { factory } = fakeImap({ 101: rfc822(ZAYAVKA_BODY) });

    await pollInbox(makeInbox({ assigned_to: null }), factory);

    // The user.findFirst fake answers the owner/admin fallback query with ADMIN,
    // so the заявка still lands on somebody and lead.new still fires.
    expect(createDealForUser).toHaveBeenCalledWith(
      ORG,
      ADMIN,
      expect.objectContaining({ assigned_to: ADMIN }),
      { silentAssignment: true },
    );
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
  });

  it('reuses a returning client instead of minting a twin contact', async () => {
    dbMock.contact.findFirst.mockResolvedValue({ id: 'existing-contact' });
    const { factory } = fakeImap({ 101: rfc822(ZAYAVKA_BODY) });

    await pollInbox(makeInbox(), factory);

    expect(createContactForUser).not.toHaveBeenCalled();
    expect(createDealForUser).toHaveBeenCalledWith(
      ORG,
      ADMIN,
      expect.objectContaining({ contact_id: 'existing-contact' }),
      { silentAssignment: true },
    );
  });

  it('records a poison message as failed and moves on', async () => {
    createDealForUser.mockRejectedValue(new Error('the organization has no pipeline'));
    const { seen, factory } = fakeImap({ 101: rfc822(ZAYAVKA_BODY) });

    const summary = await pollInbox(makeInbox(), factory);

    expect(summary.failed).toBe(1);
    expect(dbMock.leadInboxMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          error: expect.stringContaining('no pipeline'),
        }),
      }),
    );
    expect(seen).toContain(101);
  });

  it('treats the same Message-ID under a new UIDVALIDITY as a duplicate', async () => {
    dbMock.leadInboxMessage.findFirst.mockResolvedValue({ id: 'earlier-claim' });
    const { factory } = fakeImap({ 101: rfc822(ZAYAVKA_BODY) });

    const summary = await pollInbox(makeInbox(), factory);

    expect(summary.duplicates).toBe(1);
    expect(createDealForUser).not.toHaveBeenCalled();
    expect(dbMock.leadInboxMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'duplicate' }) }),
    );
  });
});

describe('runLeadInboxTick', () => {
  it('contains one broken inbox and writes the error where the app can see it', async () => {
    dbMock.leadInbox.findMany.mockResolvedValue([makeInbox()]);
    const factory = () =>
      ({
        connect: vi.fn(async () => {
          throw new Error('Invalid credentials (Failure)');
        }),
        logout: vi.fn(async () => undefined),
        close: vi.fn(),
      }) as never;

    await runLeadInboxTick(factory);

    expect(dbMock.leadInbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'error',
          last_error: expect.stringContaining('Invalid credentials'),
        }),
      }),
    );
  });

  it('skips paused inboxes at the query, not in code', async () => {
    dbMock.leadInbox.findMany.mockResolvedValue([]);

    await runLeadInboxTick(() => {
      throw new Error('must not connect');
    });

    expect(dbMock.leadInbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { not: 'paused' } } }),
    );
  });
});

describe('collector mode', () => {
  const ORG2 = '77777777-7777-4777-8777-000000000002';
  const PATTERN = '4kub.zayavki+{token}@yandex.ru';

  beforeEach(() => {
    process.env.LEAD_COLLECTOR_IMAP_USER = '4kub.zayavki@yandex.ru';
    process.env.LEAD_COLLECTOR_IMAP_PASSWORD = 'collector-app-password';
    process.env.LEAD_COLLECTOR_ADDRESS_PATTERN = PATTERN;
  });

  const inbox1 = () =>
    makeInbox({
      mode: 'collector',
      intake_token: 'aaaa111111',
      imap_user: null,
      imap_password_enc: null,
    });
  const inbox2 = () =>
    makeInbox({
      id: 'inbox-2',
      organization_id: ORG2,
      mode: 'collector',
      intake_token: 'bbbb222222',
      imap_user: null,
      imap_password_enc: null,
    });

  it('routes a letter to the org whose intake address it was sent to', async () => {
    const { seen, factory } = fakeImap({
      101: rfc822(ZAYAVKA_BODY, '<z-1@business.yandex.ru>', '4kub.zayavki+aaaa111111@yandex.ru'),
    });

    const summary = await pollCollectorForInboxes([inbox1(), inbox2()] as never, factory);

    expect(summary.created).toBe(1);
    expect(createDealForUser).toHaveBeenCalledTimes(1);
    expect(createDealForUser.mock.calls[0][0]).toBe(ORG);
    expect(dbMock.leadInboxMessage.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ inbox_id: 'inbox-1', organization_id: ORG })],
      }),
    );
    expect(seen).toContain(101);
  });

  it('skips and flags a letter that matches no org', async () => {
    const { seen, factory } = fakeImap({
      101: rfc822(ZAYAVKA_BODY, '<z-2@business.yandex.ru>', '4kub.zayavki+unknown0000@yandex.ru'),
    });

    const summary = await pollCollectorForInboxes([inbox1()] as never, factory);

    expect(summary.created).toBe(0);
    expect(createDealForUser).not.toHaveBeenCalled();
    // Flagged \Seen anyway, or the stray letter is re-fetched every minute.
    expect(seen).toContain(101);
  });

  it('enables with an empty body and answers with a ready-made address', async () => {
    dbMock.leadInbox.findUnique.mockResolvedValue(null);
    dbMock.leadInbox.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: 'inbox-9',
      mode: 'collector',
      intake_token: create.intake_token,
    }));

    const view = (await upsertLeadInbox(ORG, ADMIN, {})) as { intake_address: string };

    const created = dbMock.leadInbox.upsert.mock.calls[0][0].create;
    expect(created.mode).toBe('collector');
    expect(created.intake_token).toMatch(/^[0-9a-f]{10}$/);
    expect(created.imap_password_enc).toBeNull();
    expect(view.intake_address).toBe(`4kub.zayavki+${created.intake_token}@yandex.ru`);
  });

  it('refuses collector mode when the server has no collector mailbox', async () => {
    delete process.env.LEAD_COLLECTOR_IMAP_USER;
    delete process.env.LEAD_COLLECTOR_IMAP_PASSWORD;
    delete process.env.LEAD_COLLECTOR_ADDRESS_PATTERN;
    dbMock.leadInbox.findUnique.mockResolvedValue(null);

    await expect(upsertLeadInbox(ORG, ADMIN, {})).rejects.toMatchObject({
      code: 'COLLECTOR_NOT_CONFIGURED',
    });
  });
});

describe('upsertLeadInbox', () => {
  it('refuses to create an inbox without a password', async () => {
    dbMock.leadInbox.findUnique.mockResolvedValue(null);

    await expect(
      upsertLeadInbox(ORG, ADMIN, { imap_user: 'leads@example.ru' }),
    ).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
    expect(dbMock.leadInbox.upsert).not.toHaveBeenCalled();
  });

  it('refuses a stage that arrives without its pipeline', async () => {
    dbMock.leadInbox.findUnique.mockResolvedValue(null);

    await expect(
      upsertLeadInbox(ORG, ADMIN, {
        imap_user: 'leads@example.ru',
        imap_password: 'secret',
        stage_id: '77777777-7777-4777-8777-0000000000ff',
      }),
    ).rejects.toBeInstanceOf(LeadInboxError);
  });

  it('encrypts the password on the way in', async () => {
    dbMock.leadInbox.findUnique.mockResolvedValue(null);
    dbMock.leadInbox.upsert.mockResolvedValue({ id: 'inbox-1' });

    await upsertLeadInbox(ORG, ADMIN, {
      imap_user: 'leads@example.ru',
      imap_password: 'app-password',
    });

    const call = dbMock.leadInbox.upsert.mock.calls[0][0];
    expect(call.create.imap_password_enc).toMatch(/^enc:v1:/);
    expect(call.create.imap_password_enc).not.toContain('app-password');
    expect(call.create.created_by).toBe(ADMIN);
  });
});
