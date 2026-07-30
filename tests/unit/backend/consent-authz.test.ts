/**
 * Who may touch the ФЗ-38 consent ledger, and what a click on an opt-out link is allowed to
 * change. Three defects are pinned here, all of them in the direction the law cares about —
 * a recipient's refusal being reversed or manufactured by somebody else:
 *
 *   1. GRANTING consent was guarded by nothing but `contacts.write`, so a менеджер, a РОП
 *      or a support operator could flip `marketing_consent` back on, clear `unsubscribed_at`
 *      and put a recipient who had opted out back in scope, with a free-text `source` as the
 *      only evidence. Withdrawal must stay ungated — opting out is never made harder than
 *      opting in — so the asymmetry is the assertion.
 *   2. A terminal `unsubscribed` enrollment was restarted on re-enrollment, which turned
 *      "add this contact to the sequence again" into an undo button for their refusal.
 *   3. The opt-out link performed the withdrawal on GET. Microsoft Defender Safe Links and
 *      Proofpoint URL Defense fetch every link in a message at delivery, so recipients were
 *      being unsubscribed before they had opened the email — and the audit row looked
 *      exactly like a real click.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48);
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? 'y'.repeat(48);

const mockDb = vi.hoisted(() => ({
  contact: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  sequence: {
    findFirst: vi.fn(),
  },
  sequenceStep: {
    findFirst: vi.fn(),
  },
  sequenceEnrollment: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock('../../../backend/services/db', () => ({ db: mockDb }));

import { SequenceEnrollmentStatus, SequenceStatus } from '@prisma/client';
import {
  ConsentGrantForbiddenError,
  GRANT_CONSENT_CAPABILITY,
  canGrantMarketingConsent,
  recordMarketingConsent,
  withdrawMarketingConsent,
} from '../../../backend/services/consent';
import { ContactUnsubscribedError, enrollContact } from '../../../backend/services/sequences';
import { ConsentController } from '../../../backend/api/controllers/sequences';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG = '11111111-1111-1111-1111-111111111111';
const CONTACT = 'contact-1';
const SEQ = 'seq-1';
const TOKEN = 'unsub_token_aaaaaaaaaaaaaaaaaaaaaaaa';
const UNSUBSCRIBE_PATH = `/api/v1/consent/unsubscribe/${TOKEN}`;

function contactFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONTACT,
    organization_id: ORG,
    email: 'ivan@example.ru',
    first_name: 'Иван',
    last_name: 'Петров',
    company: 'ООО «Ромашка»',
    marketing_consent: true,
    marketing_consent_at: new Date('2026-07-01T00:00:00Z'),
    marketing_consent_source: 'form',
    unsubscribed_at: null,
    unsubscribe_token: TOKEN,
    ...overrides,
  };
}

type FakeReply = {
  statusCode: number;
  payload: unknown;
  contentType: string | null;
  status(code: number): FakeReply;
  type(value: string): FakeReply;
  send(payload: unknown): FakeReply;
};

function fakeReply(): FakeReply {
  const reply: FakeReply = {
    statusCode: 200,
    payload: undefined,
    contentType: null,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    type(value: string) {
      reply.contentType = value;
      return reply;
    },
    send(payload: unknown) {
      reply.payload = payload;
      return reply;
    },
  };
  return reply;
}

function asReply(reply: FakeReply): FastifyReply {
  return reply as unknown as FastifyReply;
}

/** An authenticated request against the consent routes, as the given role. */
function authedRequest(role: string, body: unknown = {}): FastifyRequest {
  return {
    user: { sub: 'user-1', org_id: ORG, role, iat: 0, exp: 0 },
    params: { contactId: CONTACT },
    query: {},
    body,
    method: 'POST',
    url: `/api/v1/consent/contacts/${CONTACT}`,
    headers: {},
    ip: '127.0.0.1',
  } as unknown as FastifyRequest;
}

/** A request against the PUBLIC opt-out routes — no session, no user. */
function publicRequest(options: {
  method: 'GET' | 'POST';
  body?: unknown;
  accept?: string;
  token?: string;
}): FastifyRequest {
  const token = options.token ?? TOKEN;
  return {
    params: { token },
    query: {},
    body: options.body,
    method: options.method,
    url: `/api/v1/consent/unsubscribe/${token}`,
    headers: options.accept ? { accept: options.accept } : {},
    ip: '203.0.113.10',
  } as unknown as FastifyRequest;
}

function wroteConsent(): boolean {
  return mockDb.contact.updateMany.mock.calls.length > 0;
}

beforeEach(() => {
  vi.clearAllMocks();

  mockDb.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof mockDb) => Promise<unknown>)(mockDb);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });

  mockDb.contact.findFirst.mockResolvedValue(contactFixture());
  mockDb.contact.updateMany.mockResolvedValue({ count: 1 });
  mockDb.sequenceEnrollment.updateMany.mockResolvedValue({ count: 1 });
  // The visibility cone for roles without visibility.all.
  mockDb.$queryRaw.mockResolvedValue([{ id: 'user-1' }]);
});

// ─── 1. Granting ──────────────────────────────────────────────────────────────

describe('granting marketing consent is capability-gated', () => {
  it('refuses a менеджер — contacts.write is not authority over the consent ledger', async () => {
    const reply = fakeReply();

    await ConsentController.grantConsent(
      authedRequest('member', { source: 'позвонил, согласился' }),
      asReply(reply),
    );

    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(wroteConsent()).toBe(false);
  });

  it('refuses head and support the same way, and never reaches the ledger', async () => {
    for (const role of ['head', 'support']) {
      vi.clearAllMocks();
      const reply = fakeReply();

      await ConsentController.grantConsent(authedRequest(role, { source: 'form' }), asReply(reply));

      expect(reply.statusCode).toBe(403);
      expect(mockDb.contact.findFirst).not.toHaveBeenCalled();
      expect(wroteConsent()).toBe(false);
    }
  });

  it('lets the roles that run the mailings record it — owner, admin, marketer', async () => {
    expect(GRANT_CONSENT_CAPABILITY).toBe('sequences.manage');

    for (const role of ['owner', 'admin', 'marketer']) {
      expect(canGrantMarketingConsent(role)).toBe(true);
    }

    // marketer is the interesting one: it is exactly why the gate is sequences.manage
    // rather than org.manage, which would leave a role that may send the mailing but not
    // record the consent that legalises it.
    const reply = fakeReply();
    await ConsentController.grantConsent(
      authedRequest('marketer', { source: 'выставка, анкета' }),
      asReply(reply),
    );

    expect(reply.statusCode).toBe(200);
    expect(mockDb.contact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ marketing_consent: true, unsubscribed_at: null }),
      }),
    );
  });

  it('refuses every role that cannot manage sequences, including unknown ones', () => {
    for (const role of ['member', 'head', 'support', 'accountant', 'viewer', 'auditor', '', null]) {
      expect(canGrantMarketingConsent(role)).toBe(false);
    }
  });

  it('refuses in the service too, so skipping the route gate does not write consent', async () => {
    await expect(
      recordMarketingConsent({
        contactId: CONTACT,
        organizationId: ORG,
        source: 'import',
        actorRole: 'member',
      }),
    ).rejects.toBeInstanceOf(ConsentGrantForbiddenError);

    expect(wroteConsent()).toBe(false);
  });

  it('fails closed when a caller passes an actor role it never resolved', async () => {
    await expect(
      recordMarketingConsent({
        contactId: CONTACT,
        organizationId: ORG,
        source: 'import',
        actorRole: undefined,
      }),
    ).rejects.toBeInstanceOf(ConsentGrantForbiddenError);
  });

  it('audits the refusal — a denied write to the consent ledger is itself evidence', async () => {
    await ConsentController.grantConsent(
      authedRequest('member', { source: 'form' }),
      asReply(fakeReply()),
    );

    // auditLog writes through $executeRaw and swallows its own failures, so the assertion
    // is that it was called at all.
    expect(mockDb.$executeRaw).toHaveBeenCalled();
  });
});

// ─── 2. Withdrawal ────────────────────────────────────────────────────────────

describe('withdrawal stays ungated — opting out is never harder than opting in', () => {
  it('lets the same менеджер who may not grant consent withdraw it', async () => {
    const reply = fakeReply();

    await ConsentController.revokeConsent(authedRequest('member'), asReply(reply));

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toMatchObject({ data: { can_send_marketing: false } });
    expect(mockDb.contact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ marketing_consent: false }),
      }),
    );
  });

  it('takes no actor role at all in the service — there is nothing to be forbidden', async () => {
    const state = await withdrawMarketingConsent({ contactId: CONTACT, organizationId: ORG });

    expect(state.can_send_marketing).toBe(false);
    expect(state.unsubscribed_at).toBeInstanceOf(Date);
  });
});

// ─── 3. Re-enrollment after a refusal ─────────────────────────────────────────

describe('an unsubscribed contact cannot be re-enrolled by re-adding them', () => {
  beforeEach(() => {
    mockDb.sequence.findFirst.mockResolvedValue({ id: SEQ, status: SequenceStatus.active });
    mockDb.sequenceStep.findFirst.mockResolvedValue({ position: 0, delay_days: 0 });
    mockDb.sequenceEnrollment.create.mockRejectedValue({ code: 'P2002' });
  });

  it('refuses to restart a terminal unsubscribed enrollment while the refusal stands', async () => {
    // Consent is live when enrollment starts and withdrawn by the time the existing row is
    // read — the race the second check exists for.
    mockDb.contact.findFirst
      .mockResolvedValueOnce(contactFixture())
      .mockResolvedValueOnce(
        contactFixture({ marketing_consent: false, unsubscribed_at: new Date('2026-07-20T10:00:00Z') }),
      );
    mockDb.sequenceEnrollment.findFirst.mockResolvedValue({
      id: 'enr-1',
      status: SequenceEnrollmentStatus.unsubscribed,
    });

    const error = await enrollContact({
      sequenceId: SEQ,
      contactId: CONTACT,
      organizationId: ORG,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContactUnsubscribedError);
    expect((error as ContactUnsubscribedError).code).toBe('CONTACT_UNSUBSCRIBED');
    expect(mockDb.sequenceEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it('restarts it once a new consent has been recorded', async () => {
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());
    mockDb.sequenceEnrollment.findFirst
      .mockResolvedValueOnce({ id: 'enr-1', status: SequenceEnrollmentStatus.unsubscribed })
      .mockResolvedValueOnce({ id: 'enr-1', status: SequenceEnrollmentStatus.active });

    await enrollContact({ sequenceId: SEQ, contactId: CONTACT, organizationId: ORG });

    const update = mockDb.sequenceEnrollment.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(update.data).toMatchObject({ status: SequenceEnrollmentStatus.active });
  });

  it('leaves the other terminal states alone — only a refusal is re-checked', async () => {
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());
    mockDb.sequenceEnrollment.findFirst
      .mockResolvedValueOnce({ id: 'enr-1', status: SequenceEnrollmentStatus.completed })
      .mockResolvedValueOnce({ id: 'enr-1', status: SequenceEnrollmentStatus.active });

    await enrollContact({ sequenceId: SEQ, contactId: CONTACT, organizationId: ORG });

    expect(mockDb.sequenceEnrollment.updateMany).toHaveBeenCalled();
    // One consent read, not two: a completed run carries no refusal to re-check.
    expect(mockDb.contact.findFirst).toHaveBeenCalledTimes(1);
  });
});

// ─── 4. GET renders, POST acts ────────────────────────────────────────────────

describe('GET /consent/unsubscribe/:token renders a page and changes nothing', () => {
  it('a link scanner fetching the URL leaves the recipient subscribed', async () => {
    mockDb.contact.findFirst.mockResolvedValue({
      id: CONTACT,
      organization_id: ORG,
      unsubscribed_at: null,
    });
    const reply = fakeReply();

    await ConsentController.unsubscribePage(publicRequest({ method: 'GET' }), asReply(reply));

    expect(reply.statusCode).toBe(200);
    expect(mockDb.contact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.sequenceEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    // Nothing was recorded either — a prefetch must not look like a click in the audit log.
    expect(mockDb.$executeRaw).not.toHaveBeenCalled();
  });

  it('serves self-contained Russian HTML whose only action is a POST form', async () => {
    mockDb.contact.findFirst.mockResolvedValue({
      id: CONTACT,
      organization_id: ORG,
      unsubscribed_at: null,
    });
    const reply = fakeReply();

    await ConsentController.unsubscribePage(publicRequest({ method: 'GET' }), asReply(reply));

    expect(reply.contentType).toBe('text/html; charset=utf-8');
    const html = reply.payload as string;

    expect(html).toContain('<html lang="ru">');
    expect(html).toContain('Отписаться от рекламной рассылки?');
    // States what it does before it does it.
    expect(html).toContain('рекламные письма на ваш адрес больше не отправляются');
    expect(html).toContain('ФЗ-38');
    expect(html).toContain(`<form method="post" action="${UNSUBSCRIBE_PATH}">`);
    // Self-contained: no external host, no script, no linked asset.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script|<link|<img|\bsrc=/);
  });

  it('shows the outcome, not another button, to someone who already opted out', async () => {
    mockDb.contact.findFirst.mockResolvedValue({
      id: CONTACT,
      organization_id: ORG,
      unsubscribed_at: new Date('2026-07-01T00:00:00Z'),
    });
    const reply = fakeReply();

    await ConsentController.unsubscribePage(publicRequest({ method: 'GET' }), asReply(reply));

    expect(reply.payload as string).toContain('Вы уже отписаны');
    expect(reply.payload as string).not.toContain('<form');
    expect(mockDb.contact.updateMany).not.toHaveBeenCalled();
  });

  it('renders the dead-link page for an unknown token, still without writing', async () => {
    mockDb.contact.findFirst.mockResolvedValue(null);
    const reply = fakeReply();

    await ConsentController.unsubscribePage(publicRequest({ method: 'GET' }), asReply(reply));

    expect(reply.statusCode).toBe(404);
    expect(reply.contentType).toBe('text/html; charset=utf-8');
    expect(reply.payload as string).toContain('Ссылка недействительна');
    expect(mockDb.contact.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a malformed token without querying for it', async () => {
    const reply = fakeReply();

    await ConsentController.unsubscribePage(
      publicRequest({ method: 'GET', token: 'short' }),
      asReply(reply),
    );

    expect(reply.statusCode).toBe(404);
    expect(mockDb.contact.findFirst).not.toHaveBeenCalled();
  });
});

describe('POST /consent/unsubscribe/:token is what performs the withdrawal', () => {
  beforeEach(() => {
    mockDb.contact.findFirst.mockResolvedValue({
      id: CONTACT,
      organization_id: ORG,
      unsubscribed_at: null,
    });
    mockDb.sequenceEnrollment.updateMany.mockResolvedValue({ count: 2 });
  });

  it('withdraws consent and stops the running sequences', async () => {
    const reply = fakeReply();

    await ConsentController.unsubscribe(publicRequest({ method: 'POST' }), asReply(reply));

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toMatchObject({ data: { unsubscribed: true } });
    expect(mockDb.contact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ marketing_consent: false }),
      }),
    );
    expect(mockDb.sequenceEnrollment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: SequenceEnrollmentStatus.unsubscribed }),
      }),
    );
  });

  it('answers the browser that submitted the form with the confirmation page', async () => {
    const reply = fakeReply();

    await ConsentController.unsubscribe(
      publicRequest({ method: 'POST', accept: 'text/html,application/xhtml+xml' }),
      asReply(reply),
    );

    expect(reply.contentType).toBe('text/html; charset=utf-8');
    expect(reply.payload as string).toContain('Вы отписаны');
    expect(mockDb.contact.updateMany).toHaveBeenCalled();
  });

  it('honours RFC 8058 one-click immediately, with no page in between', async () => {
    const reply = fakeReply();

    await ConsentController.unsubscribe(
      // What a mail provider posts: form body, and an Accept header that would otherwise
      // ask for the page.
      publicRequest({
        method: 'POST',
        body: { 'List-Unsubscribe': 'One-Click' },
        accept: 'text/html',
      }),
      asReply(reply),
    );

    expect(reply.contentType).toBeNull();
    expect(reply.payload).toMatchObject({ data: { unsubscribed: true } });
    expect(mockDb.contact.updateMany).toHaveBeenCalled();
  });

  it('accepts the one-click field however the sending stack cased it', async () => {
    const reply = fakeReply();

    await ConsentController.unsubscribe(
      publicRequest({ method: 'POST', body: { 'list-unsubscribe': 'one-click' }, accept: 'text/html' }),
      asReply(reply),
    );

    expect(reply.payload).toMatchObject({ data: { unsubscribed: true } });
  });

  it('is idempotent — a second POST reports the existing refusal and writes nothing', async () => {
    mockDb.contact.findFirst.mockResolvedValue({
      id: CONTACT,
      organization_id: ORG,
      unsubscribed_at: new Date('2026-07-01T00:00:00Z'),
    });
    const reply = fakeReply();

    await ConsentController.unsubscribe(publicRequest({ method: 'POST' }), asReply(reply));

    expect(reply.payload).toMatchObject({ data: { already_unsubscribed: true } });
    expect(mockDb.contact.updateMany).not.toHaveBeenCalled();
  });

  it('keeps the JSON 404 shape for a programmatic caller with a dead token', async () => {
    mockDb.contact.findFirst.mockResolvedValue(null);
    const reply = fakeReply();

    await ConsentController.unsubscribe(publicRequest({ method: 'POST' }), asReply(reply));

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toMatchObject({ error: { code: 'INVALID_UNSUBSCRIBE_TOKEN' } });
  });
});
