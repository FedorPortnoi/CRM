/**
 * Open tracking, from the SENDING side.
 *
 * The endpoint and the token generator were already tested (open-tracking.test.ts) — what
 * was missing was the only thing that makes any of it work: a real message carrying the
 * pixel. These tests pin the three ways that link breaks silently:
 *
 *   1. The pixel carries a DIFFERENT token from the one stored on the EmailSend row, so the
 *      endpoint validates a token no message ever contained.
 *   2. The pixel is pasted into the text/plain part, where the recipient reads the raw
 *      `<img src="…">` tag. Sequence bodies are plain text by schema contract, so the pixel
 *      only ever belongs in the HTML alternative part.
 *   3. A tracking failure takes the customer's email down with it. It must not: the message
 *      goes out untracked instead.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48);
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? 'y'.repeat(48);

const mockDb = vi.hoisted(() => ({
  contact: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  sequenceStep: {
    findFirst: vi.fn(),
  },
  sequenceEnrollment: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  emailSend: {
    create: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const mockSendEmail = vi.hoisted(() => vi.fn());
const mockBuildTrackingPixelUrl = vi.hoisted(() => vi.fn());

vi.mock('../../../backend/services/db', () => ({ db: mockDb }));
vi.mock('../../../backend/services/email', () => ({
  sendEmail: mockSendEmail,
  isEmailSendingEnabled: () => true,
  getFromEmail: () => 'CRM <crm@example.ru>',
}));
// Only the URL builder is stubbed — generateOpenToken and the path prefix stay real, so a
// drift between what sequences mints and what the endpoint accepts would surface here.
vi.mock('../../../backend/services/open-tracking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../backend/services/open-tracking')>();
  return { ...actual, buildTrackingPixelUrl: mockBuildTrackingPixelUrl };
});

import { EmailSendStatus } from '@prisma/client';
import { buildUnsubscribeUrl } from '../../../backend/services/consent';
import { TRACKING_OPEN_PATH_PREFIX } from '../../../backend/services/open-tracking';
import * as sequences from '../../../backend/services/sequences';
import { buildTrackedHtmlBody, runSequenceTick } from '../../../backend/services/sequences';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG = '11111111-1111-1111-1111-111111111111';
const CONTACT = 'contact-1';
const UNSUB_TOKEN = 'unsub_token_aaaaaaaaaaaaaaaaaaaaaaaa';
const TRACKING_ORIGIN = 'https://crm.example.ru';
const NOW = new Date('2026-07-25T12:00:00Z');

function pixelUrlFor(token: string): string {
  return `${TRACKING_ORIGIN}${TRACKING_OPEN_PATH_PREFIX}${token}.gif`;
}

function contactFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT,
    organization_id: ORG,
    email: 'ivan@example.ru',
    first_name: 'Иван',
    last_name: 'Петров',
    company: 'ООО «Ромашка»',
    marketing_consent: true,
    unsubscribed_at: null,
    unsubscribe_token: UNSUB_TOKEN,
    ...overrides,
  };
}

function stepFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-1',
    position: 0,
    delay_days: 0,
    template_id: null,
    subject: 'Здравствуйте, {{first_name}}',
    body: 'Предложение для {{company}}.',
    template: null,
    ...overrides,
  };
}

type CallArgs = [string, string, string, string | undefined];

/** The tick scans cross-org first, then per organization. */
function primeTick(): void {
  mockDb.sequenceEnrollment.findMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
    if (!args.where?.organization_id) {
      return [{ organization_id: ORG }];
    }
    return [
      {
        id: 'enr-1',
        organization_id: ORG,
        sequence_id: 'seq-1',
        contact_id: CONTACT,
        current_step: 0,
      },
    ];
  });
}

function primeStep(step: Record<string, unknown> | null): void {
  mockDb.sequenceStep.findFirst.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
    const position = args.where?.position as { gt?: number } | undefined;
    return position?.gt !== undefined ? null : step;
  });
}

/** The (to, subject, text, html) tuple the tick handed to the provider. */
function sentMessage(): { to: string; subject: string; text: string; html: string | undefined } {
  const [to, subject, text, html] = mockSendEmail.mock.calls[0] as CallArgs;
  return { to, subject, text, html };
}

/** The open_token written to the EmailSend ledger row. */
function ledgerToken(): string {
  const call = mockDb.emailSend.create.mock.calls[0][0] as { data: Record<string, unknown> };
  return call.data.open_token as string;
}

beforeEach(() => {
  vi.clearAllMocks();

  mockDb.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof mockDb) => Promise<unknown>)(mockDb);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });

  mockDb.contact.updateMany.mockResolvedValue({ count: 1 });
  mockDb.sequenceEnrollment.updateMany.mockResolvedValue({ count: 1 });
  mockDb.emailSend.updateMany.mockResolvedValue({ count: 1 });
  mockDb.emailSend.count.mockResolvedValue(1);
  mockDb.emailSend.create.mockResolvedValue({ id: 'send-1' });
  mockDb.contact.findFirst.mockResolvedValue(contactFixture());
  mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' });
  mockBuildTrackingPixelUrl.mockImplementation((token: string) => pixelUrlFor(token));

  primeTick();
  primeStep(stepFixture());
});

// ─── 1. One token, minted once ────────────────────────────────────────────────

describe('the token in the pixel is the token on the EmailSend row', () => {
  it('embeds the pixel URL built from exactly the stored open_token', async () => {
    const summary = await runSequenceTick(NOW);

    expect(summary.sent).toBe(1);

    const token = ledgerToken();
    // A real CSPRNG token from the canonical generator, not a row id or a counter.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The URL was built from that token and no other…
    expect(mockBuildTrackingPixelUrl).toHaveBeenCalledTimes(1);
    expect(mockBuildTrackingPixelUrl).toHaveBeenCalledWith(token);

    // …and the message actually carries it. This is the assertion whose absence made the
    // whole feature dead: tokens were minted and stored, but never sent.
    const { html } = sentMessage();
    expect(html).toContain(pixelUrlFor(token));
    expect(html).toContain(`<img src="${pixelUrlFor(token)}"`);
  });

  it('mints the token once — the row and the pixel cannot drift apart', async () => {
    await runSequenceTick(NOW);

    const token = ledgerToken();
    const { html } = sentMessage();

    // Every token-shaped string in the outgoing markup is that one token.
    const embedded = [...(html ?? '').matchAll(/tracking\/open\/([A-Za-z0-9_-]+)\.gif/g)].map(
      (match) => match[1],
    );
    expect(embedded.length).toBeGreaterThan(0);
    expect(new Set(embedded)).toEqual(new Set([token]));
  });

  it('gives each message its own token', async () => {
    await runSequenceTick(NOW);
    const first = ledgerToken();

    vi.clearAllMocks();
    mockDb.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: typeof mockDb) => Promise<unknown>)(mockDb) : arg,
    );
    mockDb.sequenceEnrollment.updateMany.mockResolvedValue({ count: 1 });
    mockDb.emailSend.updateMany.mockResolvedValue({ count: 1 });
    mockDb.emailSend.create.mockResolvedValue({ id: 'send-2' });
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-2' });
    mockBuildTrackingPixelUrl.mockImplementation((token: string) => pixelUrlFor(token));
    primeTick();
    primeStep(stepFixture());

    await runSequenceTick(NOW);

    expect(ledgerToken()).not.toBe(first);
  });

  it('has no second token generator left in this module', () => {
    // The duplicate that used to live here could drift in length or alphabet from the one
    // the endpoint validates. There is now exactly one, in services/open-tracking.ts.
    expect('generateOpenToken' in sequences).toBe(false);
  });
});

// ─── 2. The pixel never lands in the plain-text part ──────────────────────────

describe('the plain-text part never shows the customer any markup', () => {
  it('keeps text/plain free of the pixel, tags and doctype', async () => {
    await runSequenceTick(NOW);

    const { text, html } = sentMessage();

    expect(text).not.toContain('<img');
    expect(text).not.toContain('<a ');
    expect(text).not.toContain('doctype');
    expect(text).not.toContain(TRACKING_OPEN_PATH_PREFIX);
    // Still the personalised plain body plus the ФЗ-38 footer, unchanged.
    expect(text).toContain('ООО «Ромашка»');
    expect(text).toContain(`/api/v1/consent/unsubscribe/${UNSUB_TOKEN}`);
    expect(html).toBeTypeOf('string');
  });

  it('escapes the body into the HTML part instead of trusting it as markup', async () => {
    primeStep(stepFixture({ body: 'Скидка <b>50%</b> для {{company}} & «партнёров»' }));

    await runSequenceTick(NOW);

    const { text, html } = sentMessage();

    // Bodies are plain text by schema contract, so `<b>` is content the recipient wrote,
    // not markup we should render.
    expect(html).toContain('&lt;b&gt;50%&lt;/b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&amp;');
    // The plain part is untouched.
    expect(text).toContain('Скидка <b>50%</b>');
  });

  it('keeps the ФЗ-38 opt-out clickable in the HTML part', async () => {
    await runSequenceTick(NOW);

    // The base comes from deployment config, so ask consent.ts rather than hardcoding it.
    const unsubscribeUrl = buildUnsubscribeUrl(UNSUB_TOKEN);
    const { html } = sentMessage();
    expect(html).toContain(`<a href="${unsubscribeUrl}">${unsubscribeUrl}</a>`);
  });
});

// ─── 3. Tracking never costs a message ────────────────────────────────────────

describe('a tracking failure never loses the email', () => {
  it('sends the message untracked when URL construction throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockBuildTrackingPixelUrl.mockImplementation(() => {
      throw new Error('TRACKING_BASE_URL exploded');
    });

    const summary = await runSequenceTick(NOW);

    // The email still went out — with no HTML part, so no half-built markup either.
    expect(summary.sent).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const { to, subject, text, html } = sentMessage();
    expect(to).toBe('ivan@example.ru');
    expect(subject).toBe('Здравствуйте, Иван');
    expect(text).toContain('ООО «Ромашка»');
    expect(html).toBeUndefined();

    // And it is still recorded as sent, so the enrollment advances normally.
    const settled = mockDb.emailSend.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(settled.data).toMatchObject({ status: EmailSendStatus.sent });

    warnSpy.mockRestore();
  });

  it('sends the message untracked when no public base URL is configured', async () => {
    mockBuildTrackingPixelUrl.mockReturnValue(null);

    const summary = await runSequenceTick(NOW);

    expect(summary.sent).toBe(1);
    expect(sentMessage().html).toBeUndefined();
    // The token is still minted and stored: configuring the base URL later must not require
    // a backfill.
    expect(ledgerToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('still stores a token on a send that fails at the provider', async () => {
    mockSendEmail.mockResolvedValue({ success: false, errorCode: 'RESEND_ERROR' });

    const summary = await runSequenceTick(NOW);

    expect(summary.failed).toBe(1);
    expect(ledgerToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

// ─── 4. ФЗ-152 / ФЗ-38: no pixel without consent ──────────────────────────────

describe('a contact without consent is never tracked', () => {
  it('builds no pixel and sends nothing when consent was withdrawn', async () => {
    mockDb.contact.findFirst.mockResolvedValue(
      contactFixture({ marketing_consent: false, unsubscribed_at: new Date('2026-07-01T00:00:00Z') }),
    );

    const summary = await runSequenceTick(NOW);

    expect(summary.unsubscribed).toBe(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockBuildTrackingPixelUrl).not.toHaveBeenCalled();
    expect(mockDb.emailSend.create).not.toHaveBeenCalled();
  });
});

// ─── 5. The HTML builder in isolation ─────────────────────────────────────────

describe('buildTrackedHtmlBody', () => {
  const PIXEL = `${TRACKING_ORIGIN}${TRACKING_OPEN_PATH_PREFIX}${'A'.repeat(43)}.gif`;

  it('escapes the body, links the opt-out and appends the pixel last', () => {
    const html = buildTrackedHtmlBody(
      'Привет <script>alert(1)</script>\nОтказаться: https://u/1',
      'https://u/1',
      PIXEL,
    );

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<br />');
    expect(html).toContain('<a href="https://u/1">https://u/1</a>');
    expect(html.indexOf('<img')).toBeGreaterThan(html.indexOf('Привет'));
  });

  it('escapes the pixel URL it is handed rather than interpolating it raw', () => {
    const html = buildTrackedHtmlBody('текст', 'https://u/1', 'https://x/"><script>bad()</script>');

    expect(html).not.toContain('"><script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('degrades safely when the unsubscribe url is empty', () => {
    // split('') would otherwise shred the body one character at a time.
    const html = buildTrackedHtmlBody('привет', '', PIXEL);

    expect(html).toContain('привет');
    expect(html).toContain('<img');
  });

  it('declares utf-8 so a Russian body is not mojibake', () => {
    expect(buildTrackedHtmlBody('Здравствуйте', 'https://u/1', PIXEL)).toContain(
      '<meta charset="utf-8" />',
    );
  });
});
