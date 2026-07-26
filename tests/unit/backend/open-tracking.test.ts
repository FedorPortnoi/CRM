/**
 * Open tracking is an UNAUTHENTICATED, public endpoint that performs a write.
 * That combination is why these tests exist. The four properties asserted here
 * are the ones a regression would be expensive in:
 *
 *   1. An unknown or malformed token still gets a valid GIF — never a 404, a
 *      500 or a stack trace, and never anything that reveals whether the token
 *      exists.
 *   2. First open wins. The write is a compare-and-set on `opened_at: null`, so
 *      a repeat fetch (Gmail's image proxy fetches more than once) cannot
 *      overwrite the original timestamp.
 *   3. The token is unguessable: 256 bits of CSPRNG, never derived from the
 *      send/contact id.
 *   4. A tracking hit can only ever touch the single row addressed by the
 *      token, and only opened_at/status on it. No cross-org write, no bulk
 *      write, no second table.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({
  emailSend: {
    updateMany: vi.fn(),
    update: vi.fn(),
    updateManyAndReturn: vi.fn(),
    deleteMany: vi.fn(),
    create: vi.fn(),
  },
  contact: { updateMany: vi.fn(), update: vi.fn() },
  sequenceEnrollment: { updateMany: vi.fn(), update: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: mockDb }));

import { EmailSendStatus } from '@prisma/client';
import {
  OPEN_TOKEN_BYTES,
  TRACKING_OPEN_PATH_PREFIX,
  TRACKING_PIXEL_CONTENT_TYPE,
  TRACKING_PIXEL_GIF,
  buildTrackingPixelUrl,
  generateOpenToken,
  isValidOpenTokenFormat,
  recordEmailOpen,
  stripPixelExtension,
} from '../../../backend/services/open-tracking';
import { TrackingRouteHandlers, openTrackingRateLimit } from '../../../backend/api/routes/tracking';

/** Records everything a handler does to the reply. */
function makeReply() {
  const headers: Record<string, string> = {};
  const reply = {
    statusCode: undefined as number | undefined,
    payload: undefined as unknown,
    headers,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    header(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    send(body: unknown) {
      reply.payload = body;
      return reply;
    },
  };
  return reply;
}

function makeRequest(token: string | undefined) {
  return {
    params: { token },
    log: { warn: vi.fn() },
    ip: '203.0.113.9',
    method: 'GET',
    url: `${TRACKING_OPEN_PATH_PREFIX}${token ?? ''}`,
  };
}

const VALID_TOKEN = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaQ';

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.emailSend.updateMany.mockResolvedValue({ count: 1 });
});

// ─── 1. The pixel is always returned ──────────────────────────────────────────

describe('the tracking endpoint always returns a valid GIF', () => {
  it('serves a real 1x1 transparent GIF89a', () => {
    // GIF89a header, 1x1 logical screen, GIF trailer.
    expect(TRACKING_PIXEL_GIF.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(TRACKING_PIXEL_GIF.readUInt16LE(6)).toBe(1); // width
    expect(TRACKING_PIXEL_GIF.readUInt16LE(8)).toBe(1); // height
    expect(TRACKING_PIXEL_GIF[TRACKING_PIXEL_GIF.length - 1]).toBe(0x3b); // trailer
    expect(TRACKING_PIXEL_CONTENT_TYPE).toBe('image/gif');
  });

  const cases: Array<[string, string | undefined]> = [
    ['a valid but unknown token', VALID_TOKEN],
    ['a malformed token', 'not a token!!'],
    ['an empty token', ''],
    ['a missing token', undefined],
    ['a token with SQL-ish characters', "'; DROP TABLE \"EmailSend\"; --"],
    ['a path-traversal attempt', '../../../etc/passwd'],
    ['an absurdly long token', 'A'.repeat(5000)],
  ];

  for (const [label, token] of cases) {
    it(`returns 200 + the pixel for ${label}`, async () => {
      // No row matches -> the DB reports zero updates, exactly like an unknown token.
      mockDb.emailSend.updateMany.mockResolvedValue({ count: 0 });

      const reply = makeReply();
      const result = await TrackingRouteHandlers.openPixel(
        makeRequest(token) as never,
        reply as never,
      );

      expect(reply.statusCode).toBe(200);
      expect(reply.payload).toBe(TRACKING_PIXEL_GIF);
      expect(reply.headers['content-type']).toBe('image/gif');
      // The handler returns the reply so it composes correctly inside Fastify's
      // lifecycle rather than resolving to undefined.
      expect(result).toBe(reply);
    });
  }

  it('does not reveal whether a token exists: the response is byte-identical either way', async () => {
    mockDb.emailSend.updateMany.mockResolvedValue({ count: 1 });
    const hit = makeReply();
    await TrackingRouteHandlers.openPixel(makeRequest(VALID_TOKEN) as never, hit as never);

    mockDb.emailSend.updateMany.mockResolvedValue({ count: 0 });
    const miss = makeReply();
    await TrackingRouteHandlers.openPixel(makeRequest(VALID_TOKEN) as never, miss as never);

    expect(miss.statusCode).toBe(hit.statusCode);
    expect(miss.payload).toBe(hit.payload);
    expect(miss.headers).toEqual(hit.headers);
  });

  it('still returns the pixel when the database throws, and leaks no error detail', async () => {
    mockDb.emailSend.updateMany.mockRejectedValue(new Error('connection terminated at 10.0.0.4'));

    const request = makeRequest(VALID_TOKEN);
    const reply = makeReply();
    await TrackingRouteHandlers.openPixel(request as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toBe(TRACKING_PIXEL_GIF);
    expect(JSON.stringify(reply.payload)).not.toContain('10.0.0.4');
  });

  it('never lets a malformed token reach the database', async () => {
    await recordEmailOpen('not a token!!');
    await recordEmailOpen('');
    await recordEmailOpen(undefined);
    await recordEmailOpen(null);
    await recordEmailOpen(12345);
    await recordEmailOpen({ open_token: VALID_TOKEN });

    expect(mockDb.emailSend.updateMany).not.toHaveBeenCalled();
  });

  it('recordEmailOpen never throws', async () => {
    mockDb.emailSend.updateMany.mockRejectedValue(new Error('boom'));
    await expect(recordEmailOpen(VALID_TOKEN)).resolves.toBe('ignored');
  });

  it('is rate limited', () => {
    const limit = openTrackingRateLimit();
    expect(limit.timeWindow).toBe('1 minute');
    expect(limit.max).toBeGreaterThan(0);
  });

  it('strips an image extension appended by a mail client', () => {
    expect(stripPixelExtension(`${VALID_TOKEN}.gif`)).toBe(VALID_TOKEN);
    expect(stripPixelExtension(`${VALID_TOKEN}.GIF`)).toBe(VALID_TOKEN);
    expect(stripPixelExtension(`${VALID_TOKEN}.png`)).toBe(VALID_TOKEN);
    expect(stripPixelExtension(VALID_TOKEN)).toBe(VALID_TOKEN);
    expect(stripPixelExtension(undefined)).toBe('');
  });
});

// ─── 2. First open wins ───────────────────────────────────────────────────────

describe('first open wins', () => {
  it('guards the write on opened_at: null so a repeat cannot overwrite', async () => {
    mockDb.emailSend.updateMany.mockResolvedValue({ count: 1 });
    const first = await recordEmailOpen(VALID_TOKEN);
    expect(first).toBe('recorded');

    const call = mockDb.emailSend.updateMany.mock.calls[0]?.[0];
    // The compare-and-set. Without this a second fetch would rewrite opened_at,
    // and two racing fetches would both "win".
    expect(call.where.opened_at).toBeNull();
    expect(call.where.open_token).toBe(VALID_TOKEN);
    expect(call.data.opened_at).toBeInstanceOf(Date);
    expect(call.data.status).toBe(EmailSendStatus.opened);
  });

  it('reports a repeat open as ignored when the guard matches no row', async () => {
    mockDb.emailSend.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await recordEmailOpen(VALID_TOKEN)).toBe('recorded');

    // Second fetch: opened_at is no longer null, so the same statement updates
    // nothing. The service must report that rather than claiming a new open.
    mockDb.emailSend.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await recordEmailOpen(VALID_TOKEN)).toBe('ignored');

    const [firstCall, secondCall] = mockDb.emailSend.updateMany.mock.calls;
    expect(secondCall?.[0].where).toEqual(firstCall?.[0].where);
  });

  it('does not resurrect a failed send', async () => {
    await recordEmailOpen(VALID_TOKEN);
    const call = mockDb.emailSend.updateMany.mock.calls[0]?.[0];
    expect(call.where.status).toEqual({
      in: [EmailSendStatus.queued, EmailSendStatus.sent],
    });
    expect(call.where.status.in).not.toContain(EmailSendStatus.failed);
  });

  it('uses updateMany, not update: update() cannot carry the opened_at guard', async () => {
    await recordEmailOpen(VALID_TOKEN);
    expect(mockDb.emailSend.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.emailSend.update).not.toHaveBeenCalled();
  });
});

// ─── 3. The token is unguessable ──────────────────────────────────────────────

describe('open tokens are unguessable', () => {
  it('carries 256 bits of entropy', () => {
    expect(OPEN_TOKEN_BYTES).toBe(32);
    expect(generateOpenToken().length).toBe(43); // 32 bytes base64url
  });

  it('uses the base64url alphabet only, so it is URL safe', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateOpenToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('never repeats across a large sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      seen.add(generateOpenToken());
    }
    expect(seen.size).toBe(2000);
  });

  it('draws from the injected CSPRNG rather than Math.random or a counter', () => {
    const randomSource = vi.fn((size: number) => Buffer.alloc(size, 0x41));
    const token = generateOpenToken(randomSource);

    expect(randomSource).toHaveBeenCalledWith(32);
    expect(token).toBe(Buffer.alloc(32, 0x41).toString('base64url'));
  });

  it('rejects short and out-of-alphabet token shapes before they reach a query', () => {
    expect(isValidOpenTokenFormat('1')).toBe(false);
    expect(isValidOpenTokenFormat('12345')).toBe(false);
    expect(isValidOpenTokenFormat('a'.repeat(21))).toBe(false);
    expect(isValidOpenTokenFormat('a'.repeat(129))).toBe(false);
    expect(isValidOpenTokenFormat('has spaces in it aaaaaaaaaaaa')).toBe(false);
    expect(isValidOpenTokenFormat('percent%encoded%aaaaaaaaaaaaa')).toBe(false);
    expect(isValidOpenTokenFormat(generateOpenToken())).toBe(true);
  });

  it('never mints a token derived from a row id: a uuid is far shorter', () => {
    // The format check is a junk filter, not an authorization check — a uuid
    // happens to fit the base64url alphabet. What actually protects an open
    // record is that this module only ever mints 43 CSPRNG characters, so no
    // database identifier is ever a usable token.
    const uuid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    expect(generateOpenToken().length).toBeGreaterThan(uuid.length);
    for (let i = 0; i < 50; i += 1) {
      expect(generateOpenToken()).not.toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it('builds the pixel URL only when a public base URL is configured', () => {
    const env = (values: Record<string, string>): NodeJS.ProcessEnv =>
      values as unknown as NodeJS.ProcessEnv;
    const token = generateOpenToken();

    // Unconfigured degrades to null so the sender ships the message without a
    // pixel rather than embedding a broken relative URL.
    expect(buildTrackingPixelUrl(token, env({}))).toBeNull();
    expect(buildTrackingPixelUrl(token, env({ TRACKING_BASE_URL: 'not a url' }))).toBeNull();
    expect(
      buildTrackingPixelUrl(token, env({ TRACKING_BASE_URL: 'ftp://crm.example.ru' })),
    ).toBeNull();
    expect(
      buildTrackingPixelUrl(token, env({ TRACKING_BASE_URL: 'https://crm.example.ru' })),
    ).toBe(`https://crm.example.ru${TRACKING_OPEN_PATH_PREFIX}${token}.gif`);
  });
});

// ─── 4. A tracking hit writes nothing else ────────────────────────────────────

describe('a tracking hit cannot write outside the addressed row', () => {
  it('touches only EmailSend, and only via the guarded updateMany', async () => {
    await TrackingRouteHandlers.openPixel(
      makeRequest(VALID_TOKEN) as never,
      makeReply() as never,
    );

    expect(mockDb.emailSend.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.emailSend.update).not.toHaveBeenCalled();
    expect(mockDb.emailSend.create).not.toHaveBeenCalled();
    expect(mockDb.emailSend.deleteMany).not.toHaveBeenCalled();
    // Neither the contact (e.g. an unsubscribe flag) nor the enrollment may be
    // advanced by an unauthenticated image fetch.
    expect(mockDb.contact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.contact.update).not.toHaveBeenCalled();
    expect(mockDb.sequenceEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockDb.sequenceEnrollment.update).not.toHaveBeenCalled();
  });

  it('addresses exactly one row: the WHERE is pinned to the unique token', async () => {
    await recordEmailOpen(VALID_TOKEN);
    const call = mockDb.emailSend.updateMany.mock.calls[0]?.[0];

    // open_token is @unique, so no organization_id filter is possible here (the
    // request is unauthenticated and carries no org) — but the token pins the
    // statement to one row, which is what keeps it from becoming a cross-org or
    // bulk write. Anything that widened this WHERE would be the bug.
    expect(Object.keys(call.where).sort()).toEqual(['open_token', 'opened_at', 'status']);
    expect(call.where.open_token).toBe(VALID_TOKEN);
    expect(typeof call.where.open_token).toBe('string');

    // No relational escape hatches that could span organizations.
    expect(call.where).not.toHaveProperty('contact');
    expect(call.where).not.toHaveProperty('organization');
    expect(call.where).not.toHaveProperty('OR');
    expect(call.where).not.toHaveProperty('NOT');
    expect(call.where).not.toHaveProperty('AND');
  });

  it('writes only opened_at and status — no other column', async () => {
    await recordEmailOpen(VALID_TOKEN);
    const call = mockDb.emailSend.updateMany.mock.calls[0]?.[0];

    expect(Object.keys(call.data).sort()).toEqual(['opened_at', 'status']);
    expect(call.data).not.toHaveProperty('organization_id');
    expect(call.data).not.toHaveProperty('contact_id');
    expect(call.data).not.toHaveProperty('enrollment_id');
    expect(call.data).not.toHaveProperty('subject');
  });

  it("a valid token from org A cannot be steered at org B's row", async () => {
    // The only input is the token. There is no org, contact or send id in the
    // request, so no attacker-controlled value reaches the WHERE except the
    // token itself — and a token maps to one row by the unique constraint.
    const orgAToken = generateOpenToken();
    mockDb.emailSend.updateMany.mockResolvedValue({ count: 1 });

    await TrackingRouteHandlers.openPixel(
      {
        ...makeRequest(orgAToken),
        // Headers/query a caller might try to smuggle scope through.
        headers: { 'x-org-id': 'org-b' },
        query: { organization_id: 'org-b', contact_id: 'someone-else' },
      } as never,
      makeReply() as never,
    );

    const call = mockDb.emailSend.updateMany.mock.calls[0]?.[0];
    expect(JSON.stringify(call)).not.toContain('org-b');
    expect(JSON.stringify(call)).not.toContain('someone-else');
    expect(call.where.open_token).toBe(orgAToken);
  });
});
