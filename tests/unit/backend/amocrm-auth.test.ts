/**
 * amoCRM OAuth: the rotation discipline.
 *
 * =============================================================================
 * WHAT THESE TESTS ARE ACTUALLY DEFENDING
 * =============================================================================
 * amoCRM invalidates the refresh token the moment it issues a new one. That
 * turns "renew the access token" from an idempotent read into a credential
 * exchange with exactly one winner, and it makes three ordinary-looking bugs
 * unrecoverable rather than merely annoying:
 *
 *   • Two renewals at once. Both present the same refresh token; one response is
 *     worthless, and if the loser writes last the account is left holding a dead
 *     credential. Recovery is a human clicking through the consent screen again.
 *   • Persisting the new token in a SECOND transaction. A crash in between loses
 *     the only credential that exists.
 *   • Retrying a rejected grant. amoCRM blocks integrations that hammer one, and
 *     a blocked integration answers 403 to every subsequent request.
 *
 * So the fake database below is not a stub that answers `{ count: 1 }`. It
 * implements the two properties the production code leans on:
 *   1. `pg_advisory_xact_lock` really blocks a second transaction until the
 *      first commits — otherwise the concurrency test passes by accident.
 *   2. A throwing transaction really rolls back — otherwise "a transient failure
 *      leaves the refresh token intact" cannot be distinguished from a no-op.
 *
 * No network: `fetch` is stubbed and every call is asserted against.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'j'.repeat(48);
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? 'k'.repeat(48);
process.env.AMOCRM_CLIENT_ID = 'client-id-abc';
process.env.AMOCRM_CLIENT_SECRET = 'client-secret-xyz';
process.env.AMOCRM_REDIRECT_URI = 'https://crm.example.ru/api/v1/amocrm/callback';

// ─── The fake database ────────────────────────────────────────────────────────

type Row = Record<string, any>;

const harness = vi.hoisted(() => {
  let rows: Row[] = [];

  /** pg_advisory_xact_lock: held for the life of a transaction, FIFO handoff. */
  const held = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();
  /** Every lock key ever taken, so a test can assert the lock was used at all. */
  const lockLog: string[] = [];
  /** How many transactions were inside the critical section simultaneously. */
  let concurrentInLock = 0;
  let maxConcurrentInLock = 0;

  function acquireLock(key: string): Promise<void> {
    lockLog.push(key);
    if (!held.has(key)) {
      held.add(key);
      concurrentInLock += 1;
      maxConcurrentInLock = Math.max(maxConcurrentInLock, concurrentInLock);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const queue = waiters.get(key) ?? [];
      queue.push(() => {
        concurrentInLock += 1;
        maxConcurrentInLock = Math.max(maxConcurrentInLock, concurrentInLock);
        resolve();
      });
      waiters.set(key, queue);
    });
  }

  function releaseLock(key: string): void {
    concurrentInLock -= 1;
    const queue = waiters.get(key);
    if (queue && queue.length > 0) {
      queue.shift()!(); // hand the lock straight over, never unlock in between
      return;
    }
    held.delete(key);
  }

  function clone(row: Row): Row {
    return structuredClone(row);
  }

  function find(orgId: string): Row | undefined {
    return rows.find((r) => r.organization_id === orgId);
  }

  function model() {
    return {
      findUnique: async ({ where }: { where: { organization_id: string } }) => {
        const row = find(where.organization_id);
        return row ? clone(row) : null;
      },
      findFirst: async ({ where }: { where: { organization_id: string } }) => {
        const row = find(where.organization_id);
        return row ? clone(row) : null;
      },
      update: async ({ where, data }: { where: { organization_id: string }; data: Row }) => {
        const row = find(where.organization_id);
        if (!row) throw new Error('P2025: record to update not found');
        Object.assign(row, data, { updated_at: new Date() });
        return clone(row);
      },
      updateMany: async ({ where, data }: { where: { organization_id: string }; data: Row }) => {
        const row = find(where.organization_id);
        if (!row) return { count: 0 };
        Object.assign(row, data, { updated_at: new Date() });
        return { count: 1 };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { organization_id: string };
        create: Row;
        update: Row;
      }) => {
        const row = find(where.organization_id);
        if (row) {
          Object.assign(row, update, { updated_at: new Date() });
          return clone(row);
        }
        const created: Row = {
          id: `amo-${rows.length + 1}`,
          webhook_ids: [],
          status: 'active',
          needs_reauth_at: null,
          last_sync_at: null,
          last_error: null,
          connected_by: null,
          created_at: new Date(),
          updated_at: new Date(),
          ...create,
        };
        rows.push(created);
        return clone(created);
      },
      deleteMany: async ({ where }: { where: { organization_id: string } }) => {
        const before = rows.length;
        rows = rows.filter((r) => r.organization_id !== where.organization_id);
        return { count: before - rows.length };
      },
    };
  }

  async function executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
    if (sql.includes('pg_advisory_xact_lock')) {
      await acquireLock(String(values[0]));
      return 1;
    }
    return 0;
  }

  const db = {
    amoIntegration: model(),
    $executeRaw: executeRaw,
    $queryRaw: async () => [],
    /**
     * Interactive transaction. Snapshots the table on entry and restores it if
     * the callback throws, so a rolled-back refresh really does leave the old
     * credentials in place. Locks taken inside are released on the way out —
     * commit AND rollback — exactly like pg_advisory_xact_lock.
     */
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = rows.map((r) => clone(r));
      const taken: string[] = [];

      const tx = {
        amoIntegration: model(),
        $queryRaw: async () => [],
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
          if (sql.includes('pg_advisory_xact_lock')) {
            const key = String(values[0]);
            await acquireLock(key);
            taken.push(key);
            return 1;
          }
          return 0;
        },
      };

      try {
        return await fn(tx);
      } catch (err) {
        rows = snapshot;
        throw err;
      } finally {
        for (const key of taken) releaseLock(key);
      }
    },
  };

  return {
    db,
    lockLog,
    reset() {
      rows = [];
      held.clear();
      waiters.clear();
      lockLog.length = 0;
      concurrentInLock = 0;
      maxConcurrentInLock = 0;
    },
    seed(row: Row) {
      rows.push(row);
    },
    row(orgId: string): Row | undefined {
      return find(orgId);
    },
    get maxConcurrentInLock() {
      return maxConcurrentInLock;
    },
  };
});

vi.mock('../../../backend/services/db', () => ({ db: harness.db }));

const { encryptField, decryptField } = await import('../../../backend/services/encryption');
const {
  AmoNotConnectedError,
  AmoOAuthError,
  AmoPausedError,
  AmoReauthRequiredError,
  AmoSubdomainError,
  amoBaseUrl,
  amoConfigured,
  amoUrl,
  buildAuthorizeUrl,
  disconnect,
  exchangeCode,
  getAccessToken,
  getIntegration,
  markNeedsReauth,
  normalizeAmoSubdomain,
  signAmoState,
  verifyAmoState,
} = await import('../../../backend/services/amocrm/auth');
const { resetThrottles, getThrottle } = await import('../../../backend/services/amocrm/throttle');
const {
  AmoApiError,
  AmoRateLimitError,
  amoRequest,
  chunkForBatch,
  paginate,
} = await import('../../../backend/services/amocrm/client');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

function seedIntegration(overrides: Row = {}): void {
  harness.seed({
    id: 'amo-1',
    organization_id: ORG,
    subdomain: 'acme',
    client_id: 'client-id-abc',
    client_secret_enc: encryptField('client-secret-xyz'),
    access_token_enc: encryptField('access-old'),
    refresh_token_enc: encryptField('refresh-old'),
    redirect_uri: 'https://crm.example.ru/api/v1/amocrm/callback',
    // Expired an hour ago unless a test says otherwise.
    token_expires_at: new Date(Date.now() - 3_600_000),
    status: 'active',
    needs_reauth_at: null,
    last_sync_at: null,
    last_error: null,
    webhook_ids: [],
    connected_by: USER,
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  });
}

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: any };

let calls: FetchCall[] = [];

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  // 204/205/304 are null-body statuses: the Response constructor throws for
  // anything else, including an empty string. amoCRM answers 204 for a list that
  // matched nothing, so this path is exercised for real.
  const nullBody = status === 204 || status === 205 || status === 304 || body === null;
  return new Response(nullBody ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init: any = {}) => {
      const call: FetchCall = {
        url: String(input),
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      // A real network hop always yields; without this the concurrency test
      // would pass because nothing else ever got a turn.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return handler(call);
    }),
  );
}

/** A well-formed token response with a NEW refresh token, as amoCRM sends. */
function tokenBody(suffix: string): Record<string, unknown> {
  return {
    token_type: 'Bearer',
    expires_in: 86400,
    server_time: Math.floor(Date.now() / 1000),
    access_token: `access-${suffix}`,
    refresh_token: `refresh-${suffix}`,
  };
}

beforeEach(() => {
  harness.reset();
  resetThrottles();
  calls = [];
  process.env.AMOCRM_CLIENT_ID = 'client-id-abc';
  process.env.AMOCRM_CLIENT_SECRET = 'client-secret-xyz';
  process.env.AMOCRM_REDIRECT_URI = 'https://crm.example.ru/api/v1/amocrm/callback';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetThrottles();
});

// ─── Subdomain / URL boundary ─────────────────────────────────────────────────

describe('subdomain handling (the SSRF boundary)', () => {
  it('accepts the three shapes amoCRM has been seen to send in `referer`', () => {
    expect(normalizeAmoSubdomain('acme')).toBe('acme');
    expect(normalizeAmoSubdomain('acme.amocrm.ru')).toBe('acme');
    expect(normalizeAmoSubdomain('https://acme.amocrm.ru/')).toBe('acme');
    expect(normalizeAmoSubdomain('  ACME.AmoCRM.ru  ')).toBe('acme');
    expect(normalizeAmoSubdomain('my-account.kommo.com')).toBe('my-account');
  });

  it('refuses anything that would send a request somewhere else', () => {
    const hostile = [
      'evil.com',
      'acme.evil.com',
      'acme.amocrm.ru.evil.com',
      '169.254.169.254',
      'acme@evil.com',
      'acme/../../etc',
      'acme:8080',
      'acme.amocrm.ru:8080',
      '../acme',
      'a'.repeat(300),
      '',
      'acme_underscore',
      '-leading-hyphen',
      'file:///etc/passwd',
      null,
      undefined,
    ];

    for (const value of hostile) {
      expect(() => normalizeAmoSubdomain(value as string)).toThrow(AmoSubdomainError);
    }
  });

  it('pins every outbound URL to the account origin', () => {
    expect(amoBaseUrl('acme')).toBe('https://acme.amocrm.ru');
    expect(amoUrl('acme', '/api/v4/leads', { limit: 250 }).toString()).toBe(
      'https://acme.amocrm.ru/api/v4/leads?limit=250',
    );

    // A `_links.next` href pointing at a different account (or a different host
    // entirely) must not be followed.
    expect(() => amoUrl('acme', 'https://other.amocrm.ru/api/v4/leads?page=2')).toThrow(
      AmoSubdomainError,
    );
    expect(() => amoUrl('acme', 'https://evil.example/api/v4/leads')).toThrow(AmoSubdomainError);
    expect(
      amoUrl('acme', 'https://acme.amocrm.ru/api/v4/leads?page=2').toString(),
    ).toBe('https://acme.amocrm.ru/api/v4/leads?page=2');
  });
});

// ─── Authorize URL ────────────────────────────────────────────────────────────

describe('buildAuthorizeUrl', () => {
  it('points at the PLATFORM host, not the account, and sends only the three documented params', async () => {
    const url = new URL(await buildAuthorizeUrl(ORG, 'state-token'));

    expect(url.origin).toBe('https://www.amocrm.ru');
    expect(url.pathname).toBe('/oauth');
    expect(url.searchParams.get('client_id')).toBe('client-id-abc');
    expect(url.searchParams.get('state')).toBe('state-token');
    expect(url.searchParams.get('mode')).toBe('popup');
    // amoCRM takes the redirect URI from the integration settings; sending one
    // here is not part of the documented call.
    expect(url.searchParams.get('redirect_uri')).toBeNull();
    expect(url.searchParams.get('scope')).toBeNull();
  });

  it('re-authorises against the SAME application an org already connected with', async () => {
    seedIntegration({ client_id: 'org-own-client-id' });
    const url = new URL(await buildAuthorizeUrl(ORG, 's'));
    expect(url.searchParams.get('client_id')).toBe('org-own-client-id');
  });

  it('honours AMOCRM_OAUTH_MODE=post_message', async () => {
    process.env.AMOCRM_OAUTH_MODE = 'post_message';
    try {
      const url = new URL(await buildAuthorizeUrl(ORG, 's'));
      expect(url.searchParams.get('mode')).toBe('post_message');
    } finally {
      delete process.env.AMOCRM_OAUTH_MODE;
    }
  });

  it('reports a missing configuration instead of building a broken URL', async () => {
    delete process.env.AMOCRM_CLIENT_ID;
    expect(amoConfigured()).toBe(false);
    await expect(buildAuthorizeUrl(ORG, 's')).rejects.toThrow(/AMOCRM_CLIENT_ID/);
  });
});

// ─── OAuth state ──────────────────────────────────────────────────────────────

describe('OAuth state', () => {
  it('round-trips and carries the org', () => {
    const state = signAmoState({ sub: USER, org_id: ORG, exp: Date.now() + 60_000 });
    const payload = verifyAmoState(state);
    expect(payload?.org_id).toBe(ORG);
    expect(payload?.sub).toBe(USER);
  });

  it('refuses a tampered payload, a bad signature, an expired state and junk', () => {
    const state = signAmoState({ sub: USER, org_id: ORG, exp: Date.now() + 60_000 });
    const [encoded, signature] = state.split('.');

    const forged = Buffer.from(
      JSON.stringify({ sub: USER, org_id: 'other-org', exp: Date.now() + 60_000, nonce: 'x' }),
    ).toString('base64url');
    expect(verifyAmoState(`${forged}.${signature}`)).toBeNull();
    expect(verifyAmoState(`${encoded}.${'A'.repeat(signature.length)}`)).toBeNull();
    expect(verifyAmoState(signAmoState({ sub: USER, org_id: ORG, exp: Date.now() - 1 }))).toBeNull();
    expect(verifyAmoState('nonsense')).toBeNull();
    expect(verifyAmoState('')).toBeNull();
    expect(verifyAmoState(null)).toBeNull();
  });

  it('gives two states for the same user a different value', () => {
    const exp = Date.now() + 60_000;
    expect(signAmoState({ sub: USER, org_id: ORG, exp })).not.toBe(
      signAmoState({ sub: USER, org_id: ORG, exp }),
    );
  });
});

// ─── Code exchange ────────────────────────────────────────────────────────────

describe('exchangeCode', () => {
  it('posts JSON to the ACCOUNT host with all five documented fields', async () => {
    stubFetch(() => jsonResponse(200, tokenBody('first')));

    const view = await exchangeCode(ORG, 'auth-code-123', 'acme.amocrm.ru', { connectedBy: USER });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://acme.amocrm.ru/oauth2/access_token');
    expect(calls[0].method).toBe('POST');
    // Form-encoding here is THE classic amoCRM failure: it answers 401 and reads
    // like a credential problem.
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toEqual({
      client_id: 'client-id-abc',
      client_secret: 'client-secret-xyz',
      redirect_uri: 'https://crm.example.ru/api/v1/amocrm/callback',
      grant_type: 'authorization_code',
      code: 'auth-code-123',
    });

    expect(view.connected).toBe(true);
    expect(view.status).toBe('active');
    expect(view.subdomain).toBe('acme');
  });

  it('stores every secret encrypted, never plaintext', async () => {
    stubFetch(() => jsonResponse(200, tokenBody('first')));
    await exchangeCode(ORG, 'auth-code-123', 'acme', { connectedBy: USER });

    const row = harness.row(ORG)!;
    for (const column of ['access_token_enc', 'refresh_token_enc', 'client_secret_enc'] as const) {
      expect(row[column]).toMatch(/^enc:v1:/);
    }
    expect(decryptField(row.access_token_enc)).toBe('access-first');
    expect(decryptField(row.refresh_token_enc)).toBe('refresh-first');
    expect(decryptField(row.client_secret_enc)).toBe('client-secret-xyz');
    expect(row.token_expires_at.getTime()).toBeGreaterThan(Date.now() + 86_000_000);
  });

  it('clears needs_reauth when a human re-authorises', async () => {
    seedIntegration({
      status: 'needs_reauth',
      needs_reauth_at: new Date('2026-07-30T00:00:00Z'),
      last_error: 'refresh token spent',
      access_token_enc: null,
      refresh_token_enc: null,
    });
    stubFetch(() => jsonResponse(200, tokenBody('reauth')));

    const view = await exchangeCode(ORG, 'code', 'acme', { connectedBy: USER });

    expect(view.status).toBe('active');
    expect(view.needs_reauth_at).toBeNull();
    expect(view.last_error).toBeNull();
    expect(decryptField(harness.row(ORG)!.refresh_token_enc)).toBe('refresh-reauth');
  });

  it('does not retry a rejected code — it is single-use and 20 minutes old at most', async () => {
    stubFetch(() =>
      jsonResponse(400, {
        hint: 'Cannot decrypt the authorization code',
        title: 'Некорректный запрос',
        status: 400,
      }),
    );

    await expect(exchangeCode(ORG, 'used-code', 'acme')).rejects.toThrow(AmoOAuthError);
    expect(calls).toHaveLength(1);
    expect(harness.row(ORG)).toBeUndefined();
  });

  it('refuses a hostile subdomain before any request is made', async () => {
    stubFetch(() => jsonResponse(200, tokenBody('nope')));
    await expect(exchangeCode(ORG, 'code', 'evil.example')).rejects.toThrow(AmoSubdomainError);
    expect(calls).toHaveLength(0);
  });
});

// ─── getAccessToken: the rotation discipline ──────────────────────────────────

describe('getAccessToken', () => {
  it('returns the stored token untouched when it is comfortably fresh', async () => {
    seedIntegration({ token_expires_at: new Date(Date.now() + 3_600_000) });
    stubFetch(() => jsonResponse(200, tokenBody('unexpected')));

    const access = await getAccessToken(ORG);

    expect(access.access_token).toBe('access-old');
    expect(access.subdomain).toBe('acme');
    expect(access.base_url).toBe('https://acme.amocrm.ru');
    expect(calls).toHaveLength(0);
  });

  it('refreshes BEFORE expiry, inside the safety margin', async () => {
    // Two minutes of life left: still technically valid, but a request that
    // starts now can easily finish after it dies.
    seedIntegration({ token_expires_at: new Date(Date.now() + 120_000) });
    stubFetch(() => jsonResponse(200, tokenBody('margin')));

    const access = await getAccessToken(ORG);

    expect(access.access_token).toBe('access-margin');
    expect(calls).toHaveLength(1);
  });

  it('refreshes an expired token before handing it out', async () => {
    seedIntegration();
    stubFetch(() => jsonResponse(200, tokenBody('renewed')));

    const access = await getAccessToken(ORG);

    expect(access.access_token).toBe('access-renewed');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://acme.amocrm.ru/oauth2/access_token');
    expect(calls[0].body.grant_type).toBe('refresh_token');
    expect(calls[0].body.refresh_token).toBe('refresh-old');
    // Required on refresh too, which is the detail most implementations miss.
    expect(calls[0].body.redirect_uri).toBe('https://crm.example.ru/api/v1/amocrm/callback');
  });

  it('PERSISTS THE NEW REFRESH TOKEN in the transaction that consumed the old one', async () => {
    seedIntegration();
    stubFetch(() => jsonResponse(200, tokenBody('rotated')));

    await getAccessToken(ORG);

    const row = harness.row(ORG)!;
    expect(decryptField(row.refresh_token_enc)).toBe('refresh-rotated');
    expect(decryptField(row.access_token_enc)).toBe('access-rotated');
    expect(row.refresh_token_enc).toMatch(/^enc:v1:/);
    // The lock was taken, and it was keyed on the organisation.
    expect(harness.lockLog).toContain(`amocrm:token:${ORG}`);
  });

  it('makes EXACTLY ONE refresh when six callers race for an expired token', async () => {
    seedIntegration();
    let issued = 0;
    stubFetch(() => {
      issued += 1;
      return jsonResponse(200, tokenBody(`race-${issued}`));
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => getAccessToken(ORG)),
    );

    // THE assertion. A second call here means a second refresh token was minted
    // and the first one silently died.
    expect(issued).toBe(1);
    expect(calls).toHaveLength(1);

    // Every caller got the same, live token — not one winner and five stale
    // copies.
    const tokens = new Set(results.map((r) => r.access_token));
    expect(tokens).toEqual(new Set(['access-race-1']));

    // And nothing was ever inside the critical section twice at once.
    expect(harness.maxConcurrentInLock).toBe(1);
    expect(decryptField(harness.row(ORG)!.refresh_token_enc)).toBe('refresh-race-1');
  });

  it('does not refresh at all when a concurrent caller already did', async () => {
    seedIntegration();
    stubFetch(() => jsonResponse(200, tokenBody('winner')));

    const first = getAccessToken(ORG);
    const second = getAccessToken(ORG);
    await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
    // The loser re-read inside the lock, saw a fresh token, and made no call.
    expect(harness.lockLog.filter((k) => k === `amocrm:token:${ORG}`)).toHaveLength(2);
  });

  it('refuses immediately, with no HTTP call, once the integration needs re-auth', async () => {
    seedIntegration({
      status: 'needs_reauth',
      needs_reauth_at: new Date(),
      last_error: 'refresh token spent',
      refresh_token_enc: null,
    });
    stubFetch(() => jsonResponse(200, tokenBody('never')));

    await expect(getAccessToken(ORG)).rejects.toThrow(AmoReauthRequiredError);
    await expect(getAccessToken(ORG)).rejects.toThrow(AmoReauthRequiredError);
    await expect(getAccessToken(ORG)).rejects.toThrow(AmoReauthRequiredError);

    // Three attempts, zero requests. Hammering a rejected grant is what gets an
    // integration blocked, so the gate is at the entry point rather than trusted
    // to every caller.
    expect(calls).toHaveLength(0);
  });

  it('reports a missing connection and a paused one distinctly', async () => {
    stubFetch(() => jsonResponse(200, tokenBody('never')));
    await expect(getAccessToken(ORG)).rejects.toThrow(AmoNotConnectedError);

    harness.reset();
    seedIntegration({ status: 'paused' });
    await expect(getAccessToken(ORG)).rejects.toThrow(AmoPausedError);
    await expect(getAccessToken(ORG, { allowPaused: true })).resolves.toBeTruthy();
  });

  describe('a terminal refresh failure', () => {
    it('sets needs_reauth, stamps the time, drops the dead token, and never retries', async () => {
      seedIntegration();
      stubFetch(() =>
        jsonResponse(400, {
          hint: 'Invalid refresh token',
          title: 'Некорректный запрос',
          type: 'https://developers.amocrm.ru/v3/errors/OAuthProblemJson',
          status: 400,
          detail: 'В запросе отсутствует ряд параметров или параметры невалидны',
        }),
      );

      await expect(getAccessToken(ORG)).rejects.toThrow(AmoReauthRequiredError);

      const row = harness.row(ORG)!;
      expect(row.status).toBe('needs_reauth');
      expect(row.needs_reauth_at).toBeInstanceOf(Date);
      expect(row.last_error).toContain('400');
      // The refresh token amoCRM rejected is gone, so nothing can present it
      // again — the retry is the thing that earns a ban.
      expect(row.refresh_token_enc).toBeNull();
      expect(row.access_token_enc).toBeNull();

      // The needs_reauth write SURVIVED even though the call threw: it is
      // committed by the same transaction rather than rolled back with the
      // failure.
      expect(calls).toHaveLength(1);
      await expect(getAccessToken(ORG)).rejects.toThrow(AmoReauthRequiredError);
      expect(calls).toHaveLength(1);
    });

    it('treats a 401 from the token endpoint (revoked integration) the same way', async () => {
      seedIntegration();
      stubFetch(() => jsonResponse(401, { title: 'Unauthorized', status: 401 }));

      await expect(getAccessToken(ORG)).rejects.toThrow(AmoReauthRequiredError);
      expect(harness.row(ORG)!.status).toBe('needs_reauth');
      expect(calls).toHaveLength(1);
    });

    it('treats a response with no refresh_token as terminal — the one we sent is already spent', async () => {
      seedIntegration();
      stubFetch(() =>
        jsonResponse(200, { token_type: 'Bearer', expires_in: 86400, access_token: 'access-only' }),
      );

      await expect(getAccessToken(ORG)).rejects.toThrow(AmoReauthRequiredError);
      expect(harness.row(ORG)!.status).toBe('needs_reauth');
    });

    it('honours an explicit invalid_grant if amoCRM ever sends one', async () => {
      seedIntegration();
      stubFetch(() =>
        jsonResponse(400, { error: 'invalid_grant', error_description: 'refresh token is invalid' }),
      );

      await expect(getAccessToken(ORG)).rejects.toThrow(
        /refresh token is invalid|no longer valid/,
      );
      expect(harness.row(ORG)!.status).toBe('needs_reauth');
      expect(calls).toHaveLength(1);
    });
  });

  describe('a transient refresh failure', () => {
    it('rolls back, keeps the refresh token, and stays active', async () => {
      seedIntegration();
      stubFetch(() => jsonResponse(503, { title: 'Service Unavailable', status: 503 }));

      await expect(getAccessToken(ORG)).rejects.toThrow(AmoOAuthError);

      const row = harness.row(ORG)!;
      // amoCRM never answered, so the refresh token was NOT consumed. Marking
      // needs_reauth here would demand a pointless manual re-authorisation for
      // what is a five-second outage.
      expect(row.status).toBe('active');
      expect(row.needs_reauth_at).toBeNull();
      expect(decryptField(row.refresh_token_enc)).toBe('refresh-old');

      // And a later attempt does go out.
      stubFetch(() => jsonResponse(200, tokenBody('recovered')));
      calls = [];
      await expect(getAccessToken(ORG)).resolves.toMatchObject({
        access_token: 'access-recovered',
      });
      expect(calls[0].body.refresh_token).toBe('refresh-old');
    });

    it('does not mark needs_reauth on a 429', async () => {
      seedIntegration();
      stubFetch(() => jsonResponse(429, { status: 429, retry_after: 1 }));

      await expect(getAccessToken(ORG)).rejects.toThrow(AmoOAuthError);
      expect(harness.row(ORG)!.status).toBe('active');
      expect(decryptField(harness.row(ORG)!.refresh_token_enc)).toBe('refresh-old');
    });
  });

  describe('forceRefresh (the 401 path in the HTTP client)', () => {
    it('renews even a token that still looks fresh', async () => {
      seedIntegration({ token_expires_at: new Date(Date.now() + 3_600_000) });
      stubFetch(() => jsonResponse(200, tokenBody('forced')));

      const access = await getAccessToken(ORG, {
        forceRefresh: true,
        staleAccessToken: 'access-old',
      });

      expect(access.access_token).toBe('access-forced');
      expect(calls).toHaveLength(1);
    });

    it('skips the refresh when the stored token has already moved past the one that failed', async () => {
      seedIntegration({
        access_token_enc: encryptField('access-already-new'),
        token_expires_at: new Date(Date.now() + 3_600_000),
      });
      stubFetch(() => jsonResponse(200, tokenBody('should-not-happen')));

      const access = await getAccessToken(ORG, {
        forceRefresh: true,
        // What our request sent — and somebody else has since rotated it.
        staleAccessToken: 'access-old',
      });

      expect(access.access_token).toBe('access-already-new');
      expect(calls).toHaveLength(0);
    });
  });
});

// ─── markNeedsReauth / status ─────────────────────────────────────────────────

describe('markNeedsReauth', () => {
  it('stops the integration from outside a refresh', async () => {
    seedIntegration();
    await markNeedsReauth(ORG, 'amoCRM refused a freshly refreshed token');

    const row = harness.row(ORG)!;
    expect(row.status).toBe('needs_reauth');
    expect(row.needs_reauth_at).toBeInstanceOf(Date);
    expect(row.refresh_token_enc).toBeNull();
    expect(harness.lockLog).toContain(`amocrm:token:${ORG}`);
  });

  it('is a no-op for an organisation that never connected', async () => {
    await expect(markNeedsReauth(ORG, 'whatever')).resolves.toBeUndefined();
  });
});

describe('getIntegration', () => {
  it('never leaks a secret', async () => {
    seedIntegration({ webhook_ids: ['1', '2'], last_error: 'boom' });
    const view = await getIntegration(ORG);

    expect(view).toEqual({
      connected: true,
      status: 'active',
      subdomain: 'acme',
      base_url: 'https://acme.amocrm.ru',
      token_expires_at: expect.any(Date),
      needs_reauth_at: null,
      last_sync_at: null,
      last_error: 'boom',
      webhook_count: 2,
      connected_by: USER,
      connected_at: expect.any(Date),
    });
    expect(JSON.stringify(view)).not.toContain('enc:v1:');
    expect(JSON.stringify(view)).not.toContain('refresh-old');
  });

  it('reports a clean disconnected state rather than throwing', async () => {
    await expect(getIntegration(ORG)).resolves.toMatchObject({ connected: false, status: null });
  });
});

// ─── Disconnect ───────────────────────────────────────────────────────────────

describe('disconnect', () => {
  it('removes the subscriptions FIRST, while the token still works, then the credentials', async () => {
    seedIntegration({ webhook_ids: ['839656'] });
    const order: string[] = [];

    const requester = vi.fn(async (_org: string, method: string, path: string, body?: unknown) => {
      order.push(`${method} ${path}`);
      if (method === 'GET') {
        return {
          _total_items: 2,
          _embedded: {
            webhooks: [
              { id: 839656, destination: 'https://crm.example.ru/api/v1/amocrm/webhook', settings: ['add_lead'] },
              { id: 111, destination: 'https://someone-else.example/hook', settings: ['add_lead'] },
            ],
          },
        } as any;
      }
      expect(body).toEqual({ destination: 'https://crm.example.ru/api/v1/amocrm/webhook' });
      return null;
    });

    const result = await disconnect(ORG, { request: requester as any });

    expect(result).toEqual({ disconnected: true, webhooks_removed: 1, webhooks_failed: 0 });
    // Unsubscribe is DELETE /api/v4/webhooks with the destination in the body —
    // not a delete-by-id, and not the API v2 `{"delete": true}` flag.
    expect(order).toEqual(['GET /api/v4/webhooks', 'DELETE /api/v4/webhooks']);
    // A subscription belonging to someone else is left alone.
    expect(requester).toHaveBeenCalledTimes(2);
    expect(harness.row(ORG)).toBeUndefined();
  });

  it('still deletes the local credentials when the remote teardown fails', async () => {
    seedIntegration({ webhook_ids: ['1', '2'] });
    const requester = vi.fn(async () => {
      throw new Error('amoCRM unreachable');
    });

    const result = await disconnect(ORG, { request: requester as any });

    expect(result.disconnected).toBe(true);
    expect(result.webhooks_failed).toBe(2);
    // Refusing to disconnect because a remote cleanup failed would strand the
    // operator with an integration they cannot remove.
    expect(harness.row(ORG)).toBeUndefined();
  });

  it('does not try to reach an account that already needs re-auth', async () => {
    seedIntegration({ status: 'needs_reauth', refresh_token_enc: null });
    const requester = vi.fn();

    await expect(disconnect(ORG, { request: requester as any })).resolves.toMatchObject({
      disconnected: true,
    });
    expect(requester).not.toHaveBeenCalled();
    expect(harness.row(ORG)).toBeUndefined();
  });

  it('404s for an organisation that never connected', async () => {
    await expect(disconnect(ORG)).rejects.toThrow(AmoNotConnectedError);
  });
});

// ─── The HTTP client ──────────────────────────────────────────────────────────

/** Connected, with a token that will not trigger a refresh on its own. */
function seedLive(overrides: Row = {}): void {
  seedIntegration({ token_expires_at: new Date(Date.now() + 3_600_000), ...overrides });
}

const isTokenCall = (call: FetchCall) => call.url.endsWith('/oauth2/access_token');
const apiCalls = () => calls.filter((c) => !isTokenCall(c));
const tokenCalls = () => calls.filter(isTokenCall);

describe('amoRequest', () => {
  it('sends a Bearer token to the account host and returns the parsed body', async () => {
    seedLive();
    stubFetch(() => jsonResponse(200, { id: 42, name: 'Сделка' }));

    const result = await amoRequest<{ id: number }>(ORG, 'GET', '/api/v4/leads/42');

    expect(result).toEqual({ id: 42, name: 'Сделка' });
    expect(calls[0].url).toBe('https://acme.amocrm.ru/api/v4/leads/42');
    expect(calls[0].headers.Authorization).toBe('Bearer access-old');
    // No Content-Type on a bodyless request — amoCRM is happy either way, but a
    // GET advertising a JSON body it does not have is just noise.
    expect(calls[0].headers['Content-Type']).toBeUndefined();
  });

  it('carries a JSON body on DELETE, which the amoCRM unsubscribe call requires', async () => {
    seedLive();
    stubFetch(() => jsonResponse(204, null));

    const result = await amoRequest(ORG, 'DELETE', '/api/v4/webhooks', {
      destination: 'https://crm.example.ru/hook',
    });

    expect(result).toBeNull();
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toEqual({ destination: 'https://crm.example.ru/hook' });
  });

  it('maps 204 No Content to null — an empty list is not a failure', async () => {
    seedLive();
    stubFetch(() => jsonResponse(204, null));
    await expect(amoRequest(ORG, 'GET', '/api/v4/contacts')).resolves.toBeNull();
  });

  it('appends query parameters and drops undefined ones', async () => {
    seedLive();
    stubFetch(() => jsonResponse(200, {}));

    await amoRequest(ORG, 'GET', '/api/v4/leads', undefined, {
      query: { limit: 250, page: 3, query: undefined, with: 'contacts' },
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('limit')).toBe('250');
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('with')).toBe('contacts');
    expect(url.searchParams.has('query')).toBe(false);
  });

  describe('401', () => {
    it('refreshes ONCE and retries once', async () => {
      seedLive();
      let apiHits = 0;
      stubFetch((call) => {
        if (isTokenCall(call)) return jsonResponse(200, tokenBody('after401'));
        apiHits += 1;
        return apiHits === 1
          ? jsonResponse(401, { title: 'Unauthorized', status: 401 })
          : jsonResponse(200, { ok: true });
      });

      await expect(amoRequest(ORG, 'GET', '/api/v4/leads')).resolves.toEqual({ ok: true });

      expect(tokenCalls()).toHaveLength(1);
      expect(apiCalls()).toHaveLength(2);
      // The retry used the NEW token, not the one that was just refused.
      expect(apiCalls()[0].headers.Authorization).toBe('Bearer access-old');
      expect(apiCalls()[1].headers.Authorization).toBe('Bearer access-after401');
      // And the refresh sent the stored refresh token, then persisted its heir.
      expect(tokenCalls()[0].body.refresh_token).toBe('refresh-old');
      expect(decryptField(harness.row(ORG)!.refresh_token_enc)).toBe('refresh-after401');
    });

    it('stops at a second 401 — a freshly minted token being refused means revoked, not expired', async () => {
      seedLive();
      stubFetch((call) =>
        isTokenCall(call)
          ? jsonResponse(200, tokenBody('doomed'))
          : jsonResponse(401, { title: 'Unauthorized', status: 401 }),
      );

      await expect(amoRequest(ORG, 'GET', '/api/v4/leads')).rejects.toThrow(AmoReauthRequiredError);

      // Exactly one refresh, exactly two API attempts. Never a loop.
      expect(tokenCalls()).toHaveLength(1);
      expect(apiCalls()).toHaveLength(2);
      expect(harness.row(ORG)!.status).toBe('needs_reauth');
    });

    it('never retries when the refresh itself is terminal', async () => {
      seedLive();
      stubFetch((call) =>
        isTokenCall(call)
          ? jsonResponse(400, { hint: 'Invalid refresh token', status: 400 })
          : jsonResponse(401, { title: 'Unauthorized', status: 401 }),
      );

      await expect(amoRequest(ORG, 'GET', '/api/v4/leads')).rejects.toThrow(AmoReauthRequiredError);
      expect(apiCalls()).toHaveLength(1);
      expect(tokenCalls()).toHaveLength(1);
      expect(harness.row(ORG)!.status).toBe('needs_reauth');
    });
  });

  describe('terminal statuses', () => {
    it('surfaces 403 without a retry — amoCRM answers 403 to EVERY request on a blocked account', async () => {
      seedLive();
      stubFetch(() => jsonResponse(403, { title: 'Forbidden', status: 403, detail: 'Account blocked' }));

      await expect(amoRequest(ORG, 'GET', '/api/v4/leads')).rejects.toMatchObject({
        name: 'AmoApiError',
        status: 403,
        terminal: true,
      });
      expect(apiCalls()).toHaveLength(1);
    });

    it('surfaces 402 (account unpaid) without a retry', async () => {
      seedLive();
      stubFetch(() => jsonResponse(402, { title: 'Payment Required', status: 402 }));

      await expect(amoRequest(ORG, 'GET', '/api/v4/leads')).rejects.toMatchObject({
        status: 402,
        terminal: true,
      });
      expect(apiCalls()).toHaveLength(1);
    });

    it('does not retry a 400 — a malformed filter cannot succeed on the second try', async () => {
      seedLive();
      stubFetch(() =>
        jsonResponse(400, {
          title: 'Bad Request',
          status: 400,
          detail: 'Request validation failed',
          'validation-errors': [{ errors: [{ code: 'NotSupportedChoice', path: 'status_id' }] }],
        }),
      );

      await expect(amoRequest(ORG, 'GET', '/api/v4/leads')).rejects.toBeInstanceOf(AmoApiError);
      expect(apiCalls()).toHaveLength(1);
    });

    it('optionally treats 404 as an empty result', async () => {
      seedLive();
      stubFetch(() => jsonResponse(404, { title: 'Not Found', status: 404 }));

      await expect(
        amoRequest(ORG, 'GET', '/api/v4/leads/9999', undefined, { notFoundAsNull: true }),
      ).resolves.toBeNull();
      await expect(amoRequest(ORG, 'GET', '/api/v4/leads/9999')).rejects.toBeInstanceOf(AmoApiError);
    });
  });

  it('retries a 5xx and reports it as non-terminal when the budget runs out', async () => {
    seedLive();
    stubFetch(() => jsonResponse(502, { title: 'Bad Gateway', status: 502 }));

    await expect(
      amoRequest(ORG, 'GET', '/api/v4/leads', undefined, { maxAttempts: 2 }),
    ).rejects.toMatchObject({ status: 502, terminal: false });

    expect(apiCalls()).toHaveLength(2);
  });

  it('recovers when a 5xx is followed by a success', async () => {
    seedLive();
    let hits = 0;
    stubFetch(() => {
      hits += 1;
      return hits === 1 ? jsonResponse(500, { status: 500 }) : jsonResponse(200, { ok: true });
    });

    await expect(
      amoRequest(ORG, 'GET', '/api/v4/leads', undefined, { maxAttempts: 3 }),
    ).resolves.toEqual({ ok: true });
  });

  it('backs the WHOLE org bucket off on a 429, reading the amoCRM body field', async () => {
    seedLive();
    // amoCRM documents `retry_after` as a BODY field in seconds, not the RFC header.
    stubFetch(() => jsonResponse(429, { title: 'Too Many Requests', status: 429, retry_after: 120 }));

    await expect(
      amoRequest(ORG, 'GET', '/api/v4/leads', undefined, { maxAttempts: 1 }),
    ).rejects.toBeInstanceOf(AmoRateLimitError);

    // Every other worker for this organisation is now stalled too — a per-request
    // sleep would not have done that, and amoCRM counted our aggregate rate.
    const remaining = getThrottle(ORG).backoffRemainingMs;
    expect(remaining).toBeGreaterThan(110_000);
    expect(remaining).toBeLessThanOrEqual(120_000);
    resetThrottles();
  });

  it('falls back to the Retry-After header when the body carries no retry_after', async () => {
    seedLive();
    stubFetch(() => jsonResponse(429, { title: 'Too Many Requests' }, { 'Retry-After': '45' }));

    await expect(
      amoRequest(ORG, 'GET', '/api/v4/leads', undefined, { maxAttempts: 1 }),
    ).rejects.toBeInstanceOf(AmoRateLimitError);

    expect(getThrottle(ORG).backoffRemainingMs).toBeGreaterThan(40_000);
    resetThrottles();
  });
});

describe('paginate', () => {
  it('walks _links.next at limit=250 and stops when the link is gone', async () => {
    seedLive();
    stubFetch((call) => {
      const page = new URL(call.url).searchParams.get('page');
      if (page === '1') {
        return jsonResponse(200, {
          _page: 1,
          _links: { next: { href: 'https://acme.amocrm.ru/api/v4/contacts?limit=250&page=2' } },
          _embedded: { contacts: [{ id: 1 }, { id: 2 }] },
        });
      }
      return jsonResponse(200, {
        _page: 2,
        _links: { self: { href: 'https://acme.amocrm.ru/api/v4/contacts?limit=250&page=2' } },
        _embedded: { contacts: [{ id: 3 }] },
      });
    });

    const seen: number[] = [];
    for await (const batch of paginate<{ id: number }>(ORG, '/api/v4/contacts')) {
      seen.push(...batch.map((c) => c.id));
    }

    expect(seen).toEqual([1, 2, 3]);
    expect(new URL(apiCalls()[0].url).searchParams.get('limit')).toBe('250');
    expect(apiCalls()).toHaveLength(2);
  });

  it('stops on 204 without yielding anything', async () => {
    seedLive();
    stubFetch(() => jsonResponse(204, null));

    const batches: unknown[][] = [];
    for await (const batch of paginate(ORG, '/api/v4/leads')) {
      batches.push(batch);
    }

    expect(batches).toEqual([]);
    expect(apiCalls()).toHaveLength(1);
  });

  it('honours a caller-supplied start page, so a resumed import does not re-read from 1', async () => {
    seedLive();
    stubFetch(() => jsonResponse(200, { _embedded: { leads: [{ id: 7 }] } }));

    const batches: unknown[][] = [];
    for await (const batch of paginate(ORG, '/api/v4/leads', { limit: 100, page: 5 })) {
      batches.push(batch);
    }

    const url = new URL(apiCalls()[0].url);
    expect(url.searchParams.get('page')).toBe('5');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(batches).toEqual([[{ id: 7 }]]);
  });

  it('clamps a page size above the amoCRM maximum of 250', async () => {
    seedLive();
    stubFetch(() => jsonResponse(200, { _embedded: { leads: [] } }));

    for await (const batch of paginate(ORG, '/api/v4/leads', { limit: 1000 })) {
      expect(batch).toBeDefined();
    }

    expect(new URL(apiCalls()[0].url).searchParams.get('limit')).toBe('250');
  });

  it('REFUSES a next href that points anywhere but the account itself', async () => {
    seedLive();
    stubFetch(() =>
      jsonResponse(200, {
        _links: { next: { href: 'https://evil.example/api/v4/contacts?page=2' } },
        _embedded: { contacts: [{ id: 1 }] },
      }),
    );

    const walk = async () => {
      for await (const batch of paginate(ORG, '/api/v4/contacts')) {
        expect(batch).toBeDefined();
      }
    };

    // A client that follows a server-supplied absolute URL is an SSRF relay,
    // even when the server is one we chose to trust.
    await expect(walk()).rejects.toBeInstanceOf(AmoSubdomainError);
    expect(apiCalls()).toHaveLength(1);
  });

  it('stops rather than spinning when a page is empty but still advertises a next link', async () => {
    seedLive();
    stubFetch(() =>
      jsonResponse(200, {
        _links: { next: { href: 'https://acme.amocrm.ru/api/v4/leads?page=2' } },
        _embedded: { leads: [] },
      }),
    );

    for await (const batch of paginate(ORG, '/api/v4/leads')) {
      expect(batch).toBeDefined();
    }

    expect(apiCalls()).toHaveLength(1);
  });

  it('finds the collection for a nested path and for an explicit key', async () => {
    seedLive();
    stubFetch(() =>
      jsonResponse(200, { _embedded: { pipelines: [{ id: 1, name: 'Основная' }] } }),
    );

    const found: unknown[] = [];
    for await (const batch of paginate(ORG, '/api/v4/leads/pipelines')) {
      found.push(...batch);
    }
    expect(found).toEqual([{ id: 1, name: 'Основная' }]);

    const explicit: unknown[] = [];
    for await (const batch of paginate(ORG, '/api/v4/something/odd', {}, { embeddedKey: 'pipelines' })) {
      explicit.push(...batch);
    }
    expect(explicit).toEqual([{ id: 1, name: 'Основная' }]);
  });
});

describe('chunkForBatch', () => {
  it('splits at 250 by default and never exceeds the amoCRM hard 500 ceiling', () => {
    const items = Array.from({ length: 620 }, (_, i) => i);

    expect(chunkForBatch(items).map((c) => c.length)).toEqual([250, 250, 120]);
    expect(chunkForBatch(items, 500).map((c) => c.length)).toEqual([500, 120]);
    // A caller asking for more than amoCRM accepts gets the ceiling, not a 400.
    expect(chunkForBatch(items, 5_000).map((c) => c.length)).toEqual([500, 120]);
    expect(chunkForBatch([])).toEqual([]);
  });
});
