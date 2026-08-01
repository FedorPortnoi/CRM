import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The push provider router.
 *
 * What these tests are actually guarding: a user now has N devices and each names its own
 * transport, so the two failure modes that matter are (a) dispatching a token to the wrong
 * service — an opaque RuStore token and an opaque FCM token look identical — and (b) letting
 * one dead device mute the others, which is exactly what the old
 * `User.push_token = null` prune did.
 */

const dbMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  pushDevice: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

import {
  __resetPushTransports,
  __setPushTransports,
  sendPush,
  sendPushToUser,
  pushDualSendEnabled,
  type PushResult,
  type PushTransport,
} from '../../../backend/services/push';
import { classifyRuStoreError } from '../../../backend/services/push-rustore';
import {
  PushDeviceOrgConflictError,
  registerPushDevice,
} from '../../../backend/services/push-devices';

const USER = 'user-1';

type Row = {
  id: string;
  user_id: string;
  token: string;
  provider: string;
  platform: string;
  app_version: string | null;
  device_name: string | null;
};

function row(partial: Partial<Row> & { token: string; provider: string }): Row {
  return {
    id: `dev-${partial.token}`,
    user_id: USER,
    platform: 'android',
    app_version: null,
    device_name: null,
    ...partial,
  };
}

/** A transport that records what it was asked to send. */
function fakeTransport(result: PushResult = { ok: true }): PushTransport & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (token: string, title: string, body: string) => {
    calls.push([token, title, body]);
    return result;
  }) as PushTransport & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

function givenDevices(rows: Row[], legacyToken: string | null = null): void {
  dbMock.pushDevice.findMany.mockResolvedValue(rows);
  dbMock.user.findUnique.mockResolvedValue({ push_token: legacyToken });
}

let consoleLog: ReturnType<typeof vi.spyOn>;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetPushTransports();
  delete process.env.PUSH_DUAL_SEND;
  dbMock.pushDevice.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.pushDevice.findUnique.mockResolvedValue(null);
  dbMock.user.updateMany.mockResolvedValue({ count: 0 });
  dbMock.user.findUnique.mockResolvedValue({ push_token: null });
  dbMock.pushDevice.findMany.mockResolvedValue([]);
  dbMock.$transaction.mockImplementation(async (work: (tx: typeof dbMock) => Promise<unknown>) => work(dbMock));
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('push device registration tenant boundary', () => {
  it('refuses to move a token away from a user in another organization', async () => {
    dbMock.pushDevice.findUnique.mockResolvedValue({
      user: { organization_id: 'org-a' },
    });

    await expect(
      registerPushDevice({
        userId: USER,
        organizationId: 'org-b',
        token: 'shared-token',
        provider: 'rustore',
        platform: 'android',
      }),
    ).rejects.toBeInstanceOf(PushDeviceOrgConflictError);
    expect(dbMock.pushDevice.upsert).not.toHaveBeenCalled();
  });

  it('allows the same physical device to move between users inside one organization', async () => {
    dbMock.pushDevice.findUnique.mockResolvedValue({
      user: { organization_id: 'org-a' },
    });
    dbMock.pushDevice.upsert.mockResolvedValue(
      row({ token: 'shared-token', provider: 'rustore', user_id: USER }),
    );

    const registered = await registerPushDevice({
      userId: USER,
      organizationId: 'org-a',
      token: 'shared-token',
      provider: 'rustore',
      platform: 'android',
    });

    expect(registered.user_id).toBe(USER);
    expect(dbMock.pushDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { token: 'shared-token' },
        update: expect.objectContaining({ user_id: USER, provider: 'rustore' }),
      }),
    );
  });
});

afterEach(() => {
  __resetPushTransports();
  consoleLog.mockRestore();
  consoleError.mockRestore();
});

describe('sendPushToUser — transport routing', () => {
  it('dispatches each device through the transport its provider names', async () => {
    const rustore = fakeTransport();
    const expo = fakeTransport();
    const fcm = fakeTransport();
    __setPushTransports({ rustore, expo, fcm });

    givenDevices([
      row({ token: 'rustore-token', provider: 'rustore', platform: 'android' }),
      row({ token: 'ExponentPushToken[ios]', provider: 'expo', platform: 'ios' }),
      row({ token: 'fcm-token', provider: 'fcm', platform: 'android' }),
    ]);

    const result = await sendPushToUser(USER, 'Напоминание', 'Позвонить клиенту', { taskId: 't-1' });

    expect(rustore.calls).toEqual([['rustore-token', 'Напоминание', 'Позвонить клиенту']]);
    expect(expo.calls).toEqual([['ExponentPushToken[ios]', 'Напоминание', 'Позвонить клиенту']]);
    expect(fcm.calls).toEqual([['fcm-token', 'Напоминание', 'Позвонить клиенту']]);

    expect(result.attempted).toBe(3);
    expect(result.sent).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.devices.map((d) => d.provider).sort()).toEqual(['expo', 'fcm', 'rustore']);
  });

  it('never sends a RuStore token through the FCM transport', async () => {
    const rustore = fakeTransport();
    const fcm = fakeTransport();
    __setPushTransports({ rustore, fcm });

    // Both tokens are opaque strings of the same shape. Only the stored provider tells them
    // apart — the whole reason PushDevice.provider exists.
    givenDevices([
      row({ token: 'c2VjcmV0LXRva2Vu', provider: 'rustore' }),
      row({ token: 'ZmNtLXRva2VuLXg=', provider: 'fcm' }),
    ]);

    await sendPushToUser(USER, 'T', 'B');

    expect(rustore.calls.map((c) => c[0])).toEqual(['c2VjcmV0LXRva2Vu']);
    expect(fcm.calls.map((c) => c[0])).toEqual(['ZmNtLXRva2VuLXg=']);
  });

  it('stringifies data payload values before handing them to a transport', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const rustore: PushTransport = async (_t, _ti, _b, data) => {
      seen.push(data);
      return { ok: true };
    };
    __setPushTransports({ rustore });

    givenDevices([row({ token: 'rs', provider: 'rustore' })]);

    await sendPushToUser(USER, 'T', 'B', { taskId: 42, done: false, missing: undefined });

    expect(seen).toEqual([{ taskId: '42', done: 'false' }]);
  });

  it('accepts the legacy (userId, orgId, payload) call shape used by notificationEngine', async () => {
    const rustore = fakeTransport();
    __setPushTransports({ rustore });

    givenDevices([row({ token: 'rs', provider: 'rustore' })]);

    const result = await sendPushToUser(USER, 'org-1', {
      title: 'Новая задача',
      body: 'Проверить счёт',
      data: { entityType: 'task', entityId: 'e-1' },
    });

    expect(rustore.calls).toEqual([['rs', 'Новая задача', 'Проверить счёт']]);
    expect(result.sent).toBe(1);
  });
});

describe('sendPushToUser — unregistered device pruning', () => {
  it('deletes the PushDevice row for a permanently unregistered device', async () => {
    __setPushTransports({
      rustore: fakeTransport({ ok: false, code: 'DEVICE_NOT_REGISTERED', message: 'gone' }),
    });

    givenDevices([row({ token: 'dead-token', provider: 'rustore' })]);

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(dbMock.pushDevice.deleteMany).toHaveBeenCalledWith({ where: { token: 'dead-token' } });
    expect(result.pruned).toBe(1);
    expect(result.devices[0]?.pruned).toBe(true);
  });

  it('prunes only the dead device and leaves the user\'s other devices addressable', async () => {
    // The bug this replaces: scheduler.ts nulled User.push_token on any DEVICE_NOT_REGISTERED,
    // which silences every device the user owns, not the one that died.
    __setPushTransports({
      rustore: fakeTransport({ ok: false, code: 'DEVICE_NOT_REGISTERED', message: 'gone' }),
      expo: fakeTransport({ ok: true }),
    });

    givenDevices([
      row({ token: 'dead-tablet', provider: 'rustore' }),
      row({ token: 'live-phone', provider: 'expo', platform: 'ios' }),
    ]);

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(dbMock.pushDevice.deleteMany).toHaveBeenCalledTimes(1);
    expect(dbMock.pushDevice.deleteMany).toHaveBeenCalledWith({ where: { token: 'dead-tablet' } });

    // The legacy column is cleared only when it holds this exact token — never blanket-nulled.
    expect(dbMock.user.updateMany).toHaveBeenCalledWith({
      where: { push_token: 'dead-tablet' },
      data: { push_token: null },
    });

    expect(result.pruned).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.devices.find((d) => d.token === 'live-phone')?.pruned).toBe(false);
  });

  it('does not prune on a transient send failure', async () => {
    __setPushTransports({
      rustore: fakeTransport({ ok: false, code: 'SEND_FAILED', message: 'INTERNAL: upstream 500' }),
    });

    givenDevices([row({ token: 'flaky', provider: 'rustore' })]);

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(dbMock.pushDevice.deleteMany).not.toHaveBeenCalled();
    expect(result.pruned).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('does not prune when a transport throws instead of returning a result', async () => {
    // A throwing transport is our bug, not a dead device. Pruning here would delete live rows
    // on every deploy that broke a transport.
    __setPushTransports({
      rustore: async () => {
        throw new Error('boom NOT_FOUND');
      },
    });

    givenDevices([row({ token: 'rs', provider: 'rustore' })]);

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(dbMock.pushDevice.deleteMany).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(result.pruned).toBe(0);
  });
});

describe('sendPushToUser — partial failure', () => {
  it('reports per-device outcomes when only some devices fail', async () => {
    __setPushTransports({
      rustore: fakeTransport({ ok: true }),
      fcm: fakeTransport({ ok: false, code: 'SEND_FAILED', message: 'no play services' }),
      expo: fakeTransport({ ok: false, code: 'DEVICE_NOT_REGISTERED', message: 'DeviceNotRegistered' }),
    });

    givenDevices([
      row({ token: 'rs', provider: 'rustore' }),
      row({ token: 'fc', provider: 'fcm' }),
      row({ token: 'ex', provider: 'expo', platform: 'ios' }),
    ]);

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(result.attempted).toBe(3);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.pruned).toBe(1);

    const byToken = Object.fromEntries(result.devices.map((d) => [d.token, d]));
    expect(byToken.rs?.result).toEqual({ ok: true });
    expect(byToken.fc?.result).toMatchObject({ ok: false, code: 'SEND_FAILED' });
    expect(byToken.ex?.result).toMatchObject({ ok: false, code: 'DEVICE_NOT_REGISTERED' });
  });

  it('does not let one failing device stop the others from being attempted', async () => {
    const expo = fakeTransport({ ok: true });
    __setPushTransports({
      rustore: async () => {
        throw new Error('transport exploded');
      },
      expo,
    });

    givenDevices([
      row({ token: 'rs', provider: 'rustore' }),
      row({ token: 'ex', provider: 'expo', platform: 'ios' }),
    ]);

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(expo.calls).toHaveLength(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('survives a database failure while pruning', async () => {
    dbMock.pushDevice.deleteMany.mockRejectedValue(new Error('db down'));
    __setPushTransports({
      rustore: fakeTransport({ ok: false, code: 'DEVICE_NOT_REGISTERED', message: 'gone' }),
    });

    givenDevices([row({ token: 'rs', provider: 'rustore' })]);

    await expect(sendPushToUser(USER, 'T', 'B')).resolves.toMatchObject({ attempted: 1 });
  });
});

describe('sendPushToUser — no devices', () => {
  it('returns an empty result and touches no transport when the user has zero devices', async () => {
    const rustore = fakeTransport();
    const expo = fakeTransport();
    __setPushTransports({ rustore, expo });

    givenDevices([]);

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(result).toEqual({
      user_id: USER,
      attempted: 0,
      sent: 0,
      failed: 0,
      pruned: 0,
      skipped: 0,
      devices: [],
    });
    expect(rustore.calls).toHaveLength(0);
    expect(expo.calls).toHaveLength(0);
  });

  it('still reaches a user whose only token is the legacy User.push_token column', async () => {
    const expo = fakeTransport();
    __setPushTransports({ expo });

    givenDevices([], 'ExponentPushToken[legacy]');

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(expo.calls.map((c) => c[0])).toEqual(['ExponentPushToken[legacy]']);
    expect(result.devices[0]?.device_id).toBeNull();
  });

  it('does not double-send when the legacy column duplicates a PushDevice row', async () => {
    const expo = fakeTransport();
    __setPushTransports({ expo });

    givenDevices([row({ token: 'ExponentPushToken[same]', provider: 'expo' })], 'ExponentPushToken[same]');

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(expo.calls).toHaveLength(1);
    expect(result.attempted).toBe(1);
  });

  it('returns an empty result rather than throwing when the device lookup fails', async () => {
    dbMock.pushDevice.findMany.mockRejectedValue(new Error('db down'));
    dbMock.user.findUnique.mockRejectedValue(new Error('db down'));

    await expect(sendPushToUser(USER, 'T', 'B')).resolves.toMatchObject({ attempted: 0 });
  });
});

describe('dual-send migration window', () => {
  it('defaults to on so nothing stops being delivered mid-migration', () => {
    delete process.env.PUSH_DUAL_SEND;
    expect(pushDualSendEnabled()).toBe(true);
    process.env.PUSH_DUAL_SEND = 'true';
    expect(pushDualSendEnabled()).toBe(true);
    process.env.PUSH_DUAL_SEND = 'false';
    expect(pushDualSendEnabled()).toBe(false);
  });

  it('delivers to both the RuStore and the legacy row for the same phone while on', async () => {
    process.env.PUSH_DUAL_SEND = 'true';
    const rustore = fakeTransport();
    const fcm = fakeTransport();
    __setPushTransports({ rustore, fcm });

    givenDevices([
      row({ token: 'rs', provider: 'rustore', platform: 'android' }),
      row({ token: 'fc', provider: 'fcm', platform: 'android' }),
    ]);

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(rustore.calls).toHaveLength(1);
    expect(fcm.calls).toHaveLength(1);
    expect(result.attempted).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it('suppresses Android fcm/expo rows once switched off, for users who have RuStore', async () => {
    process.env.PUSH_DUAL_SEND = 'false';
    const rustore = fakeTransport();
    const fcm = fakeTransport();
    const expo = fakeTransport();
    __setPushTransports({ rustore, fcm, expo });

    givenDevices([
      row({ token: 'rs', provider: 'rustore', platform: 'android' }),
      row({ token: 'fc', provider: 'fcm', platform: 'android' }),
      row({ token: 'ios', provider: 'expo', platform: 'ios' }),
      row({ token: 'unk', provider: 'expo', platform: 'unknown' }),
    ]);

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(rustore.calls).toHaveLength(1);
    expect(fcm.calls).toHaveLength(0);
    // iOS and unknown-platform rows must survive: an unknown-platform backfill row may well
    // be an iPhone, and suppressing it would silence iOS.
    expect(expo.calls.map((c) => c[0]).sort()).toEqual(['ios', 'unk']);
    expect(result.skipped).toBe(1);
  });

  it('keeps sending to FCM when the user has no RuStore device, even with dual-send off', async () => {
    process.env.PUSH_DUAL_SEND = 'false';
    const fcm = fakeTransport();
    __setPushTransports({ fcm });

    givenDevices([row({ token: 'fc', provider: 'fcm', platform: 'android' })]);

    const result = await sendPushToUser(USER, 'T', 'B');

    expect(fcm.calls).toHaveLength(1);
    expect(result.skipped).toBe(0);
  });
});

describe('sendPush — single-token compatibility path', () => {
  it('routes an Expo token to the Expo transport without a database lookup', async () => {
    const expo = fakeTransport();
    __setPushTransports({ expo });

    const result = await sendPush('ExponentPushToken[abc]', 'T', 'B');

    expect(expo.calls).toEqual([['ExponentPushToken[abc]', 'T', 'B']]);
    expect(dbMock.pushDevice.findUnique).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('consults the PushDevice row to route an opaque token to RuStore', async () => {
    const rustore = fakeTransport();
    const fcm = fakeTransport();
    __setPushTransports({ rustore, fcm });

    dbMock.pushDevice.findUnique.mockResolvedValue(
      row({ token: 'opaque-token', provider: 'rustore' }),
    );

    await sendPush('opaque-token', 'T', 'B');

    expect(rustore.calls).toHaveLength(1);
    expect(fcm.calls).toHaveLength(0);
  });

  it('falls back to FCM for an opaque token with no row, preserving pre-RuStore behaviour', async () => {
    const fcm = fakeTransport();
    __setPushTransports({ fcm });

    dbMock.pushDevice.findUnique.mockResolvedValue(null);

    await sendPush('legacy-opaque', 'T', 'B');

    expect(fcm.calls).toHaveLength(1);
  });

  it('still reports DEVICE_NOT_REGISTERED, which existing callers branch on', async () => {
    __setPushTransports({
      expo: fakeTransport({ ok: false, code: 'DEVICE_NOT_REGISTERED', message: 'DeviceNotRegistered' }),
    });

    const result = await sendPush('ExponentPushToken[dead]', 'T', 'B');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('DEVICE_NOT_REGISTERED');
  });

  it('does not prune — that decision still belongs to the caller', async () => {
    __setPushTransports({
      expo: fakeTransport({ ok: false, code: 'DEVICE_NOT_REGISTERED', message: 'gone' }),
    });

    await sendPush('ExponentPushToken[dead]', 'T', 'B');

    expect(dbMock.pushDevice.deleteMany).not.toHaveBeenCalled();
  });
});

describe('RuStore error classification', () => {
  it('treats 404 NOT_FOUND as a dead token', () => {
    expect(
      classifyRuStoreError(404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }),
    ).toMatchObject({ ok: false, code: 'DEVICE_NOT_REGISTERED' });
  });

  it('treats a registration-token INVALID_ARGUMENT as a dead token', () => {
    expect(
      classifyRuStoreError(400, {
        error: {
          code: 400,
          message: 'The registration token is not a valid FCM registration token',
          status: 'INVALID_ARGUMENT',
        },
      }),
    ).toMatchObject({ ok: false, code: 'DEVICE_NOT_REGISTERED' });
  });

  it('does NOT treat a bad service token as a dead device', () => {
    // PERMISSION_DENIED means our credential is wrong. Classifying it as a device fault would
    // delete every PushDevice row in the table on the first tick after a credential rotation,
    // and no rollback restores tokens.
    expect(
      classifyRuStoreError(401, { error: { code: 401, message: 'Invalid service token', status: 'PERMISSION_DENIED' } }),
    ).toMatchObject({ ok: false, code: 'SEND_FAILED' });
  });

  it('treats throttling and provider faults as retryable', () => {
    expect(classifyRuStoreError(429, { error: { status: 'TOO_MANY_REQUESTS', message: 'slow down' } })).toMatchObject({
      code: 'SEND_FAILED',
    });
    expect(classifyRuStoreError(500, { error: { status: 'INTERNAL', message: 'oops' } })).toMatchObject({
      code: 'SEND_FAILED',
    });
    expect(classifyRuStoreError(503, null)).toMatchObject({ code: 'SEND_FAILED' });
  });

  it('does not misread a generic 400 as a dead token', () => {
    expect(
      classifyRuStoreError(400, { error: { code: 400, message: 'message is too large', status: 'INVALID_ARGUMENT' } }),
    ).toMatchObject({ ok: false, code: 'SEND_FAILED' });
  });
});
