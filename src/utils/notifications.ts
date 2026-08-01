import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from './api';

const DEFAULT_NOTIFICATION_CHANNEL_ID = 'default';
const LEGACY_TASK_REMINDER_CLEANUP_KEY = '@4kub/notifications/server-reminders-v1';

export type NotificationPermissionSnapshot = {
  status: string;
  granted: boolean;
  canAskAgain: boolean;
};

export type PushRegistrationResult =
  | { ok: true; message: string; provider?: PushProvider }
  | { ok: false; reason: string; message: string };

export type PushProvider = 'rustore' | 'apns' | 'expo' | 'fcm';

export type DevicePushRegistration = {
  token: string;
  provider: PushProvider;
  platform: 'android' | 'ios' | 'web';
  app_version?: string;
  device_name?: string;
};

export async function ensureDefaultNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync(DEFAULT_NOTIFICATION_CHANNEL_ID, {
    name: 'Default',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function getExpoPushProjectId(): string | null {
  return (
    nonEmptyString(Constants.easConfig?.projectId) ??
    nonEmptyString(Constants.expoConfig?.extra?.eas?.projectId)
  );
}

// ─── RuStore push ────────────────────────────────────────────────────────────
//
// Android builds shipped through RuStore usually run on devices with no Google Play
// Services. FCM does not fail on such a device — it accepts the send and delivers nothing —
// so an Expo/FCM token registered from a RuStore install is a token that will never ring.
// On Android we therefore prefer a RuStore token and fall back to Expo only when RuStore is
// unavailable (Expo Go, a dev client without the native module, an unconfigured build).
//
// The SDK is `react-native-rustore-push` 6.9.1, distributed ONLY as a git dependency from
// gitflic.ru. The identically-named package on the public npm registry is an abandoned 2023
// mirror of an earlier, different product (last publish 0.9.2, Oct 2023) with no token
// getter at all — do not install that one.
//
// The guarded loader still returns null in unit tests and Expo Go. A production Android bundle
// must keep the GitFlic package and plugins/withRuStorePush.js together; either half on its own
// is incomplete.

/**
 * 6.x supports automatic native initialization.
 *
 * The underlying native SDK initializes itself from the `ru.rustore.sdk.pushclient.project_id`
 * metadata that `plugins/withRuStorePush.js` writes into AndroidManifest.xml. The package's
 * README also documents a manual `RustorePush.init(...)` option, but the manifest path is the
 * supported automatic alternative and avoids patching the generated Application class. That is the
 * single most breakable part of this integration: with the package installed but the plugin
 * not applied, the module loads, every symbol resolves, and only `getToken()` rejects — at
 * runtime, on a user's phone, looking exactly like a network blip.
 *
 * Surface below is taken from the SDK's own `src/index.tsx` at tag 6.9.1, not from the prose
 * docs — the docs alternate between `RuStorePushClient` and `RustorePushClient` and name a
 * `removePushEmitter` that the source calls `deletePushEmitter`.
 */
type RuStoreRemoteMessage = {
  messageId?: string;
  from?: string;
  data?: Record<string, string>;
  notification?: { title?: string; body?: string; channelId?: string };
};

/** The package's default export: `NativeModules.RustorePush`. */
type RuStorePushClient = {
  getToken: () => Promise<string>;
  deleteToken: () => Promise<boolean>;
  checkPushAvailability: () => Promise<boolean>;
  createPushEmitter: () => void;
  deletePushEmitter: () => void;
  getInitialNotification: () => Promise<RuStoreRemoteMessage | null>;
};

type RuStoreSubscription = { remove: () => void };

type RuStoreEventEmitter = {
  addListener: (event: string, listener: (payload: never) => void) => RuStoreSubscription;
};

type RuStorePushModule = {
  default?: RuStorePushClient;
  eventEmitter?: RuStoreEventEmitter;
};

type RuStoreTokenEvent = string | { token?: string };

// `PushEvents` enum values, inlined so this file never has to import from the package.
const RUSTORE_EVENT_NEW_TOKEN = 'ON_NEW_TOKEN';
const RUSTORE_EVENT_MESSAGE_RECEIVED = 'ON_MESSAGE_RECEIVED';

let ruStoreModuleCache: RuStorePushModule | null | undefined;

function loadRuStorePushModule(): RuStorePushModule | null {
  if (ruStoreModuleCache !== undefined) return ruStoreModuleCache;

  try {
    // Keep the specifier literal: Metro cannot include a native dependency referenced by
    // `require(variable)`. Until the package is installed this throws in Node/unit tests and
    // the catch keeps them on Expo; production builds wire the package before bundling.
    // @ts-ignore — native git dependency has no bundled TypeScript declarations.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    ruStoreModuleCache = require('react-native-rustore-push') as RuStorePushModule;
  } catch {
    ruStoreModuleCache = null;
  }

  return ruStoreModuleCache;
}

function ruStoreClient(): RuStorePushClient | null {
  const mod = loadRuStorePushModule();
  // The package sets `export default NativeModules.RustorePush`, so under CommonJS interop
  // the client is either `.default` or the module object itself.
  const client = (mod?.default ?? mod) as RuStorePushClient | undefined;
  return client && typeof client.getToken === 'function' ? client : null;
}

function ruStoreEmitter(): RuStoreEventEmitter | null {
  return loadRuStorePushModule()?.eventEmitter ?? null;
}

/** Test seam — lets a suite drop the memoised module without reloading the file. */
export function __resetRuStorePushModuleCache(): void {
  ruStoreModuleCache = undefined;
}

/** Test seam for the optional native module; production never calls this. */
export function __setRuStorePushModuleForTests(module: RuStorePushModule | null): void {
  ruStoreModuleCache = module;
}

/**
 * The JS-side opt-in gate.
 *
 * In 6.x the value the native SDK actually uses comes from the manifest, not from here. This
 * copy exists so a build can be shipped with the package linked but RuStore switched off,
 * and so the two halves are configured from one value. Set it to the same project id as the
 * plugin option.
 */
export function getRuStoreProjectId(): string | null {
  return (
    nonEmptyString(process.env.EXPO_PUBLIC_RUSTORE_PROJECT_ID) ??
    nonEmptyString((Constants.expoConfig?.extra as { rustoreProjectId?: unknown } | undefined)?.rustoreProjectId)
  );
}

/**
 * Expo Go cannot load a custom native module, so RuStore is structurally unavailable there
 * no matter what is configured. Development keeps working on Expo push.
 */
function isExpoGo(): boolean {
  return (Constants as { appOwnership?: string | null }).appOwnership === 'expo';
}

/** Cheap synchronous gate: could this build possibly use RuStore? */
export function isRuStorePushConfigured(): boolean {
  return Platform.OS === 'android' && !isExpoGo() && getRuStoreProjectId() !== null;
}

/**
 * Ask the SDK whether a distributor app (RuStore) is actually installed, authorised, and
 * allowed to run in the background.
 *
 * This is the check that separates "shipped through RuStore" from "will actually receive a
 * push". It rejects rather than returning false for the interesting cases —
 * `HostAppNotInstalledException`, `UnauthorizedException`,
 * `HostAppBackgroundWorkPermissionNotGranted` — so a throw is treated as unavailable.
 */
export async function checkRuStorePushAvailability(): Promise<boolean> {
  if (!isRuStorePushConfigured()) return false;
  const client = ruStoreClient();
  if (!client) return false;

  try {
    return (await client.checkPushAvailability()) === true;
  } catch {
    return false;
  }
}

async function acquireRuStorePushToken(): Promise<string | null> {
  if (!(await checkRuStorePushAvailability())) return null;

  const client = ruStoreClient();
  if (!client) return null;

  try {
    // getToken() mints a token if the user does not have one yet.
    return nonEmptyString(await client.getToken());
  } catch {
    // A RuStore failure must never block registration; Expo is still there.
    return null;
  }
}

/** Release the RuStore token, e.g. on logout. Best-effort. */
export async function deleteRuStorePushToken(): Promise<void> {
  try {
    await ruStoreClient()?.deleteToken();
  } catch {
    // Nothing to do — the server prunes the device on its next unregistered receipt.
  }
}

/**
 * Subscribe to RuStore token rotation.
 *
 * RuStore's docs are explicit that once ON_NEW_TOKEN fires "your application becomes
 * responsible for delivering the new token to your server". Nothing re-registers on its own,
 * and a rotated token is indistinguishable from a working one from the server's side — the
 * old row simply stops delivering and is eventually pruned as unregistered. Without this
 * subscription a device goes quiet permanently, at a moment nobody is watching.
 *
 * Returns an unsubscribe function. Call it from a screen that lives as long as the session.
 */
export function subscribeToRuStorePushTokenRefresh(
  authTokenProvider: () => string | null | Promise<string | null>,
): () => void {
  const emitter = ruStoreEmitter();
  const client = ruStoreClient();
  if (!emitter || !client) return () => undefined;

  try {
    // Events do not fire until the emitter exists on the native side.
    client.createPushEmitter();
  } catch {
    return () => undefined;
  }

  const subscription = emitter.addListener(RUSTORE_EVENT_NEW_TOKEN, ((event: RuStoreTokenEvent) => {
    void (async () => {
      // Tag 6.9.1's native source emits `{ token }`; accepting a bare string as
      // well keeps compatibility with older builds and test doubles.
      const trimmed = nonEmptyString(typeof event === 'string' ? event : event?.token);
      if (!trimmed) return;
      const authToken = await authTokenProvider();
      if (!authToken) return;

      await postDeviceRegistration(authToken, {
        token: trimmed,
        provider: 'rustore',
        platform: 'android',
        app_version: currentAppVersion(),
        device_name: currentDeviceName(),
      }).catch(() => undefined);
    })();
  }) as (payload: never) => void);

  return () => {
    try {
      subscription.remove();
    } catch {
      // Already torn down.
    }
  };
}

/**
 * Subscribe to incoming RuStore messages.
 *
 * Needed for data-only payloads: the SDK renders a notification tray entry only when the
 * server sent a `notification` block, so a silent data push is delivered here and nowhere
 * else.
 */
export function subscribeToRuStorePushMessages(
  onMessage: (message: RuStoreRemoteMessage) => void,
): () => void {
  const emitter = ruStoreEmitter();
  const client = ruStoreClient();
  if (!emitter || !client) return () => undefined;

  try {
    client.createPushEmitter();
  } catch {
    return () => undefined;
  }

  const subscription = emitter.addListener(RUSTORE_EVENT_MESSAGE_RECEIVED, ((
    message: RuStoreRemoteMessage,
  ) => {
    try {
      onMessage(message);
    } catch {
      // A listener fault must not take down the emitter.
    }
  }) as (payload: never) => void);

  return () => {
    try {
      subscription.remove();
    } catch {
      // Already torn down.
    }
  };
}

/** The notification the app was cold-started from, if any. */
export async function getInitialRuStoreNotification(): Promise<RuStoreRemoteMessage | null> {
  try {
    return (await ruStoreClient()?.getInitialNotification()) ?? null;
  } catch {
    return null;
  }
}

// ─── Device descriptor ───────────────────────────────────────────────────────

function currentPlatform(): 'android' | 'ios' | 'web' {
  if (Platform.OS === 'android') return 'android';
  if (Platform.OS === 'ios') return 'ios';
  return 'web';
}

function currentAppVersion(): string | undefined {
  return (
    nonEmptyString(Constants.expoConfig?.version) ??
    nonEmptyString((Constants as { nativeAppVersion?: string | null }).nativeAppVersion) ??
    undefined
  );
}

function currentDeviceName(): string | undefined {
  // `expo-device` is not a dependency, so this reads whatever expo-constants exposes and
  // degrades to undefined. `device_name` is a human label in the admin UI, never a key.
  return nonEmptyString((Constants as { deviceName?: string | null }).deviceName) ?? undefined;
}

/** Subscribe to notification taps while the app is already running. */
export function subscribeToRuStoreOpenedNotifications(
  onOpen: (message: RuStoreRemoteMessage) => void,
): () => void {
  const emitter = ruStoreEmitter();
  const client = ruStoreClient();
  if (!emitter || !client) return () => undefined;

  try {
    client.createPushEmitter();
  } catch {
    return () => undefined;
  }

  const subscription = emitter.addListener('ON_OPENED', ((message: RuStoreRemoteMessage) => {
    try {
      onOpen(message);
    } catch {
      // Navigation callbacks are application code; never let one tear down the emitter.
    }
  }) as (payload: never) => void);

  return () => {
    try {
      subscription.remove();
    } catch {
      // Already removed.
    }
  };
}

/** Persist one provider-qualified device token on the server. */
async function postDeviceRegistration(
  authToken: string,
  registration: DevicePushRegistration,
): Promise<void> {
  const response = await fetch(`${API_URL}/notifications/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      token: registration.token,
      provider: registration.provider,
      platform: registration.platform,
      ...(registration.app_version ? { app_version: registration.app_version } : {}),
      ...(registration.device_name ? { device_name: registration.device_name } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(
      (await parseErrorMessage(response)) ??
        `Push registration failed with status ${response.status}.`,
    );
  }
}

/**
 * Resolve the token this device should be reachable at, and which transport owns it.
 *
 * Android prefers RuStore; iOS and every development build stay on Expo push.
 */
export async function resolveDevicePushRegistration(): Promise<DevicePushRegistration | null> {
  const platform = currentPlatform();
  const app_version = currentAppVersion();
  const device_name = currentDeviceName();

  if (platform === 'android') {
    const ruStoreToken = await acquireRuStorePushToken();
    if (ruStoreToken) {
      return { token: ruStoreToken, provider: 'rustore', platform, app_version, device_name };
    }
  }

  const projectId = getExpoPushProjectId();
  if (!projectId) return null;

  const pushTokenData = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = nonEmptyString(pushTokenData?.data);
  if (!token) return null;

  return { token, provider: 'expo', platform, app_version, device_name };
}

export async function getNotificationPermissionSnapshot(): Promise<NotificationPermissionSnapshot> {
  const permission = await Notifications.getPermissionsAsync();
  return {
    status: permission.status,
    granted: permission.granted === true || permission.status === 'granted',
    canAskAgain: permission.canAskAgain !== false,
  };
}

async function parseErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { message?: string }; message?: string };
    return body.error?.message ?? body.message ?? null;
  } catch {
    return null;
  }
}

export async function registerDevicePushTokenDetailed(authToken: string): Promise<PushRegistrationResult> {
  try {
    await ensureDefaultNotificationChannel();

    const existingPermission = await Notifications.getPermissionsAsync();
    let finalPermission = existingPermission;

    if (finalPermission.status !== 'granted' && finalPermission.canAskAgain !== false) {
      finalPermission = await Notifications.requestPermissionsAsync();
    }

    if (finalPermission.status !== 'granted') {
      return {
        ok: false,
        reason: 'permission-denied',
        message:
          finalPermission.canAskAgain === false
            ? 'Notification permission is blocked. Enable it in system settings.'
            : 'Notification permission was not granted.',
      };
    }

    const registration = await resolveDevicePushRegistration();
    if (!registration) {
      return {
        ok: false,
        reason: 'missing-project-id',
        message: 'Push notifications are not configured for this build.',
      };
    }

    // The backend now needs the transport, not just the string: an opaque RuStore token and
    // an opaque FCM token are indistinguishable by shape, so a bare token would be dispatched
    // to the wrong service.
    await postDeviceRegistration(authToken, registration);

    return {
      ok: true,
      message: 'Push notifications enabled.',
      provider: registration.provider,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: 'registration-error',
      message: error instanceof Error ? error.message : 'Push registration failed.',
    };
  }
}

export async function registerDevicePushToken(authToken: string): Promise<boolean> {
  const result = await registerDevicePushTokenDetailed(authToken);
  return result.ok;
}

export async function notifyUnknownCallCapture(phone: string): Promise<void> {
  try {
    await ensureDefaultNotificationChannel();

    const existingPermission = await Notifications.getPermissionsAsync();
    if (existingPermission.status !== 'granted') return;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Неизвестный звонок',
        body: `Звонок с номера ${phone} — добавить в CRM?`,
        data: { type: 'call_capture', phone },
        sound: 'default',
      },
      trigger: null,
    });
  } catch {
    // Local call-capture notifications are best-effort.
  }
}

export async function notifyPendingCaptureCount(title: string, body: string, count = 1): Promise<void> {
  try {
    if (count <= 0) return;

    await ensureDefaultNotificationChannel();

    const existingPermission = await Notifications.getPermissionsAsync();
    if (existingPermission.status !== 'granted') return;

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { type: 'pending_captures' },
        sound: 'default',
      },
      trigger: null,
    });
  } catch {
    // Pending capture notifications are best-effort.
  }
}

function taskReminderIdentifier(taskId: string): string {
  return `task-due-${taskId}`;
}

function taskReminderDate(dueDate: string): Date {
  const dateOnly = dueDate.includes('T') ? dueDate.slice(0, 10) : dueDate;
  return new Date(`${dateOnly}T09:00:00`);
}

export async function scheduleTaskDueReminder(
  taskId: string,
  title: string,
  dueDate: string | null | undefined,
  reminderAt?: string | null,
): Promise<void> {
  let triggerDate: Date;
  if (reminderAt) {
    triggerDate = new Date(reminderAt);
  } else {
    if (!dueDate) return;
    triggerDate = taskReminderDate(dueDate);
  }
  if (Number.isNaN(triggerDate.getTime())) return;
  await cancelTaskDueReminder(taskId);
  if (triggerDate <= new Date()) return;
  await ensureDefaultNotificationChannel();
  await Notifications.scheduleNotificationAsync({
    identifier: taskReminderIdentifier(taskId),
    content: {
      title: 'Напоминание о задаче',
      body: title,
      data: { taskId },
      sound: 'default',
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: triggerDate },
  });
}

export async function cancelTaskDueReminder(taskId: string): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(taskReminderIdentifier(taskId));
  } catch {
    // Cancellation is best-effort; unsupported platforms should not block task flows.
  }
}

/**
 * Remove one-off task alarms created by builds before TaskReminder became server-authoritative.
 *
 * The database migration turns the same legacy Task.reminder_at values into server schedules. If
 * the old local alarms survive an app upgrade, the first occurrence rings twice. Only identifiers
 * owned by the old task scheduler are touched; call-capture and every other local notification stay
 * intact. The completion marker is written only after every matching cancellation succeeds, so a
 * transient native-module failure is retried on the next launch.
 */
export async function cleanupLegacyTaskDueReminders(): Promise<number> {
  try {
    if ((await AsyncStorage.getItem(LEGACY_TASK_REMINDER_CLEANUP_KEY)) === 'done') return 0;

    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const legacyIds = scheduled
      .map((notification) => notification.identifier)
      .filter((identifier) => identifier.startsWith('task-due-'));
    const results = await Promise.allSettled(
      legacyIds.map((identifier) => Notifications.cancelScheduledNotificationAsync(identifier)),
    );
    if (results.some((result) => result.status === 'rejected')) return 0;

    await AsyncStorage.setItem(LEGACY_TASK_REMINDER_CLEANUP_KEY, 'done');
    return legacyIds.length;
  } catch {
    return 0;
  }
}
