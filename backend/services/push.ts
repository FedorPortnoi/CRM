/**
 * Push provider router.
 *
 * One user now has N devices and each device names its own transport, so "send a push" is a
 * fan-out over `PushDevice` rows rather than a single call against `User.push_token`.
 *
 * Transports:
 *   rustore  RuStore / VK Push Notification Service  (Android shipped via RuStore)
 *   expo     Expo push                                (development builds, iOS today)
 *   fcm      Firebase Cloud Messaging v1              (legacy Android, being retired)
 *   apns     Apple Push Notification service          (not yet implemented — see below)
 *
 * The FCM path is kept alive on purpose. Android devices installed from RuStore usually have
 * no Google Play Services, and FCM does not report that: it accepts the send and delivers
 * nothing. That failure is invisible from the server, which is why `PUSH_DUAL_SEND` exists —
 * it keeps both transports live for one release so real delivery can be compared before FCM
 * is switched off, instead of trusting a 200 that means nothing.
 */

import path from 'path';
import fs from 'fs';
import { GoogleAuth } from 'google-auth-library';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { sendRuStorePush } from './push-rustore';
import {
  deletePushDeviceByToken,
  findPushDeviceByToken,
  inferProviderFromToken,
  isExpoPushToken,
  listUserPushDevices,
  type PushDeviceRecord,
  type PushProvider,
} from './push-devices';

export type { PushProvider } from './push-devices';

const expo = new Expo();

const FCM_PROJECT_ID = process.env.FCM_PROJECT_ID ?? '';
const SERVICE_ACCOUNT_PATH = path.resolve(
  process.cwd(),
  process.env.FCM_SERVICE_ACCOUNT_PATH ?? 'firebase-service-account.json',
);

let _googleAuth: GoogleAuth | null = null;

function getGoogleAuth(): GoogleAuth {
  if (!_googleAuth) {
    if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
      throw new Error(`FCM service account file not found: ${SERVICE_ACCOUNT_PATH}`);
    }
    _googleAuth = new GoogleAuth({
      keyFile: SERVICE_ACCOUNT_PATH,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
  }
  return _googleAuth;
}

async function sendFcm(
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  if (!FCM_PROJECT_ID) throw new Error('FCM_PROJECT_ID is not set');

  const auth = getGoogleAuth();
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          ...(data ? { data } : {}),
          android: { priority: 'high' },
        },
      }),
    },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`FCM send failed: ${JSON.stringify(err)}`);
  }
}

async function sendExpo(
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  const message: ExpoPushMessage = {
    to: token,
    sound: 'default',
    title,
    body,
    ...(data ? { data } : {}),
  };

  const [ticket] = await expo.sendPushNotificationsAsync([message]);

  if (ticket?.status === 'error') {
    throw Object.assign(new Error(ticket.message), { details: ticket.details });
  }
}

export type PushResult =
  | { ok: true }
  | { ok: false; code: 'DEVICE_NOT_REGISTERED'; message?: string }
  | { ok: false; code: 'SEND_FAILED'; message: string };

function classifyThrown(err: unknown): PushResult {
  const msg = err instanceof Error ? err.message : String(err);
  const details = (err as { details?: { error?: string } }).details;

  if (
    details?.error === 'DeviceNotRegistered' ||
    msg.includes('UNREGISTERED') ||
    msg.includes('NOT_FOUND')
  ) {
    return { ok: false, code: 'DEVICE_NOT_REGISTERED', message: msg };
  }

  return { ok: false, code: 'SEND_FAILED', message: msg };
}

export type PushTransport = (
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>,
) => Promise<PushResult>;

const expoTransport: PushTransport = async (token, title, body, data) => {
  try {
    await sendExpo(token, title, body, data);
    return { ok: true };
  } catch (err) {
    return classifyThrown(err);
  }
};

const fcmTransport: PushTransport = async (token, title, body, data) => {
  try {
    await sendFcm(token, title, body, data);
    return { ok: true };
  } catch (err) {
    return classifyThrown(err);
  }
};

const rustoreTransport: PushTransport = async (token, title, body, data) => {
  const result = await sendRuStorePush(token, title, body, data);
  if (result.ok) return { ok: true };
  if (result.code === 'DEVICE_NOT_REGISTERED') {
    return { ok: false, code: 'DEVICE_NOT_REGISTERED', message: result.message };
  }
  return { ok: false, code: 'SEND_FAILED', message: result.message };
};

/**
 * There is no direct APNs transport yet — iOS goes through Expo, which fronts APNs. A row
 * can only carry `provider: 'apns'` once a client is built to register one, and shipping a
 * silent no-op for it would be indistinguishable from working. Fail loudly instead.
 */
const apnsTransport: PushTransport = async () => ({
  ok: false,
  code: 'SEND_FAILED',
  message: 'APNs transport is not implemented; iOS delivery goes through the expo provider',
});

const defaultTransports: Record<PushProvider, PushTransport> = {
  rustore: rustoreTransport,
  expo: expoTransport,
  fcm: fcmTransport,
  apns: apnsTransport,
};

let activeTransports: Record<PushProvider, PushTransport> = { ...defaultTransports };

/** Test seam: swap in fake transports. Not used by production code. */
export function __setPushTransports(overrides: Partial<Record<PushProvider, PushTransport>>): void {
  activeTransports = { ...defaultTransports, ...overrides };
}

/** Test seam: restore the real transports. */
export function __resetPushTransports(): void {
  activeTransports = { ...defaultTransports };
}

/**
 * Dual-send window. Defaults to ON: during the migration every registered row is delivered
 * to, so a phone that registered both a RuStore and a legacy Expo/FCM token receives both
 * and the two can be compared. Set `PUSH_DUAL_SEND=false` to stop sending to Android
 * FCM/Expo rows once RuStore delivery is proven.
 */
export function pushDualSendEnabled(): boolean {
  const raw = (process.env.PUSH_DUAL_SEND ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !(raw === 'false' || raw === '0' || raw === 'no' || raw === 'off');
}

/** Providers retired by the RuStore move, on Android only. */
const LEGACY_ANDROID_PROVIDERS: ReadonlySet<PushProvider> = new Set<PushProvider>(['fcm', 'expo']);

/**
 * With dual-send off, drop the legacy Android rows for a user who already has a RuStore
 * device.
 *
 * Scoped to `platform === 'android'` on purpose. Rows backfilled from `User.push_token` carry
 * `platform: 'unknown'` and may well be an iPhone; suppressing those because some *other*
 * device of the same user runs RuStore would silence iOS. They age out as clients
 * re-register with an explicit platform.
 */
function applyDualSendPolicy(devices: PushDeviceRecord[]): {
  send: PushDeviceRecord[];
  skipped: PushDeviceRecord[];
} {
  if (pushDualSendEnabled()) return { send: devices, skipped: [] };

  const hasRuStore = devices.some((d) => d.provider === 'rustore');
  if (!hasRuStore) return { send: devices, skipped: [] };

  const send: PushDeviceRecord[] = [];
  const skipped: PushDeviceRecord[] = [];
  for (const d of devices) {
    if (d.platform === 'android' && LEGACY_ANDROID_PROVIDERS.has(d.provider)) {
      skipped.push(d);
    } else {
      send.push(d);
    }
  }
  return { send, skipped };
}

function transportFor(provider: PushProvider): PushTransport {
  return activeTransports[provider] ?? activeTransports.fcm;
}

/**
 * Send to a single raw token.
 *
 * Kept for callers that already hold a token (`scheduler.ts`, `chat.ts`,
 * `controllers/notifications.ts`). It does NOT prune — those callers own that decision
 * today. New code should call `sendPushToUser`, which prunes correctly.
 *
 * Expo tokens are self-describing. A raw token is not: FCM and RuStore registration tokens
 * are both opaque, so the `PushDevice` row is consulted for the authoritative provider before
 * falling back to the pre-RuStore assumption of FCM.
 */
export async function sendPush(
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<PushResult> {
  let provider: PushProvider;

  if (isExpoPushToken(token)) {
    provider = 'expo';
  } else {
    const device = await findPushDeviceByToken(token).catch(() => null);
    provider = device?.provider ?? inferProviderFromToken(token);
  }

  return transportFor(provider)(token, title, body, data);
}

export type PushDeviceDispatch = {
  device_id: string | null;
  token: string;
  provider: PushProvider;
  platform: string;
  result: PushResult;
  /** The row was deleted because the provider reported the token permanently gone. */
  pruned: boolean;
};

export type PushFanoutResult = {
  user_id: string;
  attempted: number;
  sent: number;
  failed: number;
  pruned: number;
  /** Devices held back by `PUSH_DUAL_SEND=false`. */
  skipped: number;
  devices: PushDeviceDispatch[];
};

function emptyFanout(userId: string): PushFanoutResult {
  return { user_id: userId, attempted: 0, sent: 0, failed: 0, pruned: 0, skipped: 0, devices: [] };
}

function stringifyData(data?: Record<string, unknown>): Record<string, string> | undefined {
  if (!data) return undefined;
  const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, String(v)]));
}

type LegacyPayload = { title: string; body: string; data?: Record<string, unknown> };

function isLegacyPayload(value: unknown): value is LegacyPayload {
  return typeof value === 'object' && value !== null && 'title' in value;
}

/**
 * Fan a notification out to every device a user has registered.
 *
 * Two call shapes are accepted because both exist in the tree and this file cannot change
 * its callers:
 *   sendPushToUser(userId, title, body, data?)               <- preferred
 *   sendPushToUser(userId, orgId, { title, body, data? })    <- notificationEngine.ts
 *
 * Never throws. Push is best-effort everywhere it is called from; `notificationEngine` in
 * particular invokes it as `void sendPushToUser(...)`, where a rejection would surface as an
 * unhandled promise rejection and, under Node's default, take the process down.
 */
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<PushFanoutResult>;
export async function sendPushToUser(
  userId: string,
  orgId: string,
  payload: LegacyPayload,
): Promise<PushFanoutResult>;
export async function sendPushToUser(
  userId: string,
  second: string,
  third: string | LegacyPayload,
  fourth?: Record<string, unknown>,
): Promise<PushFanoutResult> {
  const title = isLegacyPayload(third) ? third.title : second;
  const body = isLegacyPayload(third) ? third.body : third;
  const rawData = isLegacyPayload(third) ? third.data : fourth;
  const data = stringifyData(rawData);

  try {
    return await fanOut(userId, title, body, data);
  } catch (err) {
    console.error(`[push] fan-out failed user=${userId}`, err);
    return emptyFanout(userId);
  }
}

async function fanOut(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<PushFanoutResult> {
  const all = await listUserPushDevices(userId);

  if (all.length === 0) {
    console.log(`[push] fanout user=${userId} devices=0 sent=0 failed=0 pruned=0 skipped=0`);
    return emptyFanout(userId);
  }

  const { send, skipped } = applyDualSendPolicy(all);

  const dispatches = await Promise.all(
    send.map(async (device): Promise<PushDeviceDispatch> => {
      const startedAt = Date.now();
      let result: PushResult;
      try {
        result = await transportFor(device.provider)(device.token, title, body, data);
      } catch (err) {
        // A transport that throws instead of returning is a bug, not a dead device. Never
        // let it prune.
        result = { ok: false, code: 'SEND_FAILED', message: err instanceof Error ? err.message : String(err) };
      }
      const ms = Date.now() - startedAt;

      let pruned = false;
      if (!result.ok && result.code === 'DEVICE_NOT_REGISTERED') {
        // Delete this device's row. The old behaviour nulled `User.push_token`, which mutes
        // every other device the user owns.
        await deletePushDeviceByToken(device.token).catch((err) => {
          console.error(`[push] prune failed user=${userId} provider=${device.provider}`, err);
        });
        pruned = true;
      }

      const code = result.ok ? 'ok' : result.code;
      const line =
        `[push] send user=${userId} provider=${device.provider} platform=${device.platform} ` +
        `device=${device.id ?? 'legacy'} ok=${result.ok} code=${code} pruned=${pruned} ms=${ms}`;
      if (result.ok) console.log(line);
      else console.error(`${line} message=${JSON.stringify('message' in result ? result.message ?? '' : '')}`);

      return {
        device_id: device.id,
        token: device.token,
        provider: device.provider,
        platform: device.platform,
        result,
        pruned,
      };
    }),
  );

  const sent = dispatches.filter((d) => d.result.ok).length;
  const pruned = dispatches.filter((d) => d.pruned).length;
  const failed = dispatches.length - sent;

  const providerMix = dispatches
    .reduce<string[]>((acc, d) => {
      acc.push(`${d.provider}:${d.result.ok ? 'ok' : 'fail'}`);
      return acc;
    }, [])
    .join(',');

  console.log(
    `[push] fanout user=${userId} devices=${dispatches.length} sent=${sent} failed=${failed} ` +
      `pruned=${pruned} skipped=${skipped.length} dual_send=${pushDualSendEnabled()} mix=${providerMix}`,
  );

  return {
    user_id: userId,
    attempted: dispatches.length,
    sent,
    failed,
    pruned,
    skipped: skipped.length,
    devices: dispatches,
  };
}
