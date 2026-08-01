/**
 * PushDevice registration, lookup and pruning.
 *
 * `User.push_token` held exactly one token and recorded nothing about which service that
 * token belonged to. Both assumptions are now false: a user has a phone and a tablet, and
 * Android has to leave FCM for RuStore while iOS stays on Expo/APNs, so the transport is a
 * property of the token rather than of the build.
 *
 * `User.push_token` is deliberately still written and read here. It is kept in step for one
 * release so a rollback to the previous server does not mute every device on Earth.
 */

import { Prisma } from '@prisma/client';
import { db } from './db';

export type PushProvider = 'rustore' | 'apns' | 'expo' | 'fcm';
export type PushPlatform = 'android' | 'ios' | 'web' | 'unknown';

export const PUSH_PROVIDERS: readonly PushProvider[] = ['rustore', 'apns', 'expo', 'fcm'];
export const PUSH_PLATFORMS: readonly PushPlatform[] = ['android', 'ios', 'web', 'unknown'];

export function isPushProvider(value: unknown): value is PushProvider {
  return typeof value === 'string' && (PUSH_PROVIDERS as readonly string[]).includes(value);
}

export function isPushPlatform(value: unknown): value is PushPlatform {
  return typeof value === 'string' && (PUSH_PLATFORMS as readonly string[]).includes(value);
}

/** A device row as the router consumes it. `id === null` means it was synthesised from the
 *  legacy `User.push_token` column and has no row of its own to delete. */
export type PushDeviceRecord = {
  id: string | null;
  user_id: string;
  token: string;
  provider: PushProvider;
  platform: string;
  app_version: string | null;
  device_name: string | null;
};

const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

/**
 * Best-effort provider for a bare token, used only where the caller gave us no provider:
 * the legacy `sendPush(token, ...)` entry point and the legacy `User.push_token` column.
 *
 * Expo tokens are self-describing. A raw token is not: FCM and RuStore registration tokens
 * are both opaque strings and cannot be told apart by shape. Anything registered before this
 * release is FCM by construction, so that is the fallback — new devices always arrive with an
 * explicit provider from the client and never reach this function.
 */
export function inferProviderFromToken(token: string, platform?: string): PushProvider {
  if (EXPO_TOKEN_RE.test(token)) return 'expo';
  if (platform === 'ios') return 'apns';
  return 'fcm';
}

export function isExpoPushToken(token: string): boolean {
  return EXPO_TOKEN_RE.test(token);
}

type RawDeviceRow = {
  id: string;
  user_id: string;
  token: string;
  provider: string;
  platform: string;
  app_version: string | null;
  device_name: string | null;
};

function normalizeRow(row: RawDeviceRow): PushDeviceRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    token: row.token,
    // A row whose provider string is not one we know about would otherwise be dispatched to
    // `undefined` and throw. Fall back rather than crash the whole fan-out.
    provider: isPushProvider(row.provider) ? row.provider : inferProviderFromToken(row.token, row.platform),
    platform: row.platform,
    app_version: row.app_version,
    device_name: row.device_name,
  };
}

/**
 * Every device we should push to for this user.
 *
 * Includes the legacy `User.push_token` when it is not already represented by a row, so the
 * rollout does not lose anyone who has not yet reopened the app. The migration backfills
 * these as `provider = 'expo'`, so in practice this only covers tokens registered against a
 * server that predates the backfill.
 */
export async function listUserPushDevices(userId: string): Promise<PushDeviceRecord[]> {
  const [rows, user] = await Promise.all([
    db.pushDevice
      .findMany({
        where: { user_id: userId },
        select: {
          id: true,
          user_id: true,
          token: true,
          provider: true,
          platform: true,
          app_version: true,
          device_name: true,
        },
      })
      .catch(() => [] as RawDeviceRow[]),
    db.user
      .findUnique({ where: { id: userId }, select: { push_token: true } })
      .catch(() => null),
  ]);

  const devices = (rows as RawDeviceRow[]).map(normalizeRow);
  const seen = new Set(devices.map((d) => d.token));

  const legacy = user?.push_token;
  if (legacy && !seen.has(legacy)) {
    devices.push({
      id: null,
      user_id: userId,
      token: legacy,
      provider: inferProviderFromToken(legacy),
      platform: 'unknown',
      app_version: null,
      device_name: null,
    });
  }

  return devices;
}

export type RegisterPushDeviceInput = {
  userId: string;
  token: string;
  provider: PushProvider;
  platform: PushPlatform | string;
  appVersion?: string | null;
  deviceName?: string | null;
  /** When given, a duplicate of this token is only cleared off users inside this org. */
  organizationId?: string | null;
};

export class PushDeviceOrgConflictError extends Error {
  readonly code = 'PUSH_DEVICE_ORG_CONFLICT';

  constructor() {
    super('This push token is already registered to another organization');
    this.name = 'PushDeviceOrgConflictError';
  }
}

/**
 * Attach a token to a user, moving it off whoever held it before.
 *
 * A push token identifies a device, not a person. If someone else's row still carries it,
 * that org keeps pushing to a handset they no longer control, so the old row must go. The
 * `token` column is unique, which makes this an upsert rather than an insert.
 */
export async function registerPushDevice(input: RegisterPushDeviceInput): Promise<PushDeviceRecord> {
  const data = {
    user_id: input.userId,
    provider: input.provider,
    platform: input.platform,
    app_version: input.appVersion ?? null,
    device_name: input.deviceName ?? null,
    last_seen_at: new Date(),
  };

  const row = (await db.$transaction(
    async (tx) => {
      if (input.organizationId) {
        const existing = await tx.pushDevice.findUnique({
          where: { token: input.token },
          select: { user: { select: { organization_id: true } } },
        });
        if (existing && existing.user.organization_id !== input.organizationId) {
          throw new PushDeviceOrgConflictError();
        }
      }

      return tx.pushDevice.upsert({
        where: { token: input.token },
        create: { token: input.token, ...data },
        update: data,
        select: {
          id: true,
          user_id: true,
          token: true,
          provider: true,
          platform: true,
          app_version: true,
          device_name: true,
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )) as RawDeviceRow;

  return normalizeRow(row);
}

/** Refresh `last_seen_at` without rewriting the rest of the row. */
export async function touchPushDevice(token: string): Promise<void> {
  await db.pushDevice
    .updateMany({ where: { token }, data: { last_seen_at: new Date() } })
    .catch(() => undefined);
}

/**
 * Drop a device the provider has told us is gone.
 *
 * This replaces `scheduler.ts`'s `push_token: null` write, which was already wrong for a
 * single device (it clears the column even when the failing token is not the one stored
 * there) and is catastrophically wrong once a user has two: one dead tablet muted the phone
 * as well.
 *
 * The legacy column is still cleared, but only when it holds this exact token.
 */
export async function deletePushDeviceByToken(token: string): Promise<void> {
  await db.pushDevice.deleteMany({ where: { token } }).catch(() => undefined);
  await db.user.updateMany({ where: { push_token: token }, data: { push_token: null } }).catch(() => undefined);
}

export async function findPushDeviceByToken(token: string): Promise<PushDeviceRecord | null> {
  const row = (await db.pushDevice
    .findUnique({
      where: { token },
      select: {
        id: true,
        user_id: true,
        token: true,
        provider: true,
        platform: true,
        app_version: true,
        device_name: true,
      },
    })
    .catch(() => null)) as RawDeviceRow | null;

  return row ? normalizeRow(row) : null;
}
