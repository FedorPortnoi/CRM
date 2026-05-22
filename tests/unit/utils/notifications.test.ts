import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const testGlobal = globalThis as typeof globalThis & {
    __DEV__?: boolean;
    expo?: any;
  };
  class TestEventEmitter {
    addListener() {
      return { remove: vi.fn() };
    }
    removeListener() {}
    removeAllListeners() {}
    emit() {}
  }

  testGlobal.__DEV__ = false;
  testGlobal.expo = {
    EventEmitter: TestEventEmitter,
    NativeModule: TestEventEmitter,
    SharedObject: TestEventEmitter,
    SharedRef: TestEventEmitter,
    modules: {},
  };

  const state: { platformOS: string; projectId: string | null } = {
    platformOS: 'ios',
    projectId: 'test-expo-project-id',
  };

  return {
    get platformOS() {
      return state.platformOS;
    },
    setPlatformOS: vi.fn((os: string) => {
      state.platformOS = os;
    }),
    get projectId() {
      return state.projectId;
    },
    setProjectId: vi.fn((projectId: string | null) => {
      state.projectId = projectId;
    }),
    setNotificationChannelAsync: vi.fn(),
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
    scheduleNotificationAsync: vi.fn(),
    cancelScheduledNotificationAsync: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mocks.platformOS;
    },
  },
  NativeModules: {},
  TurboModuleRegistry: {
    get: vi.fn(),
    getEnforcing: vi.fn(),
  },
}));

function notificationModuleMock() {
  const notificationModule = {
    AndroidImportance: { DEFAULT: 3 },
    setNotificationChannelAsync: mocks.setNotificationChannelAsync,
    getPermissionsAsync: mocks.getPermissionsAsync,
    requestPermissionsAsync: mocks.requestPermissionsAsync,
    getExpoPushTokenAsync: mocks.getExpoPushTokenAsync,
    scheduleNotificationAsync: mocks.scheduleNotificationAsync,
    cancelScheduledNotificationAsync: mocks.cancelScheduledNotificationAsync,
  };

  return {
    ...notificationModule,
    default: notificationModule,
  };
}

vi.mock('expo-notifications', notificationModuleMock);
vi.mock('expo-notifications/build/index.js', notificationModuleMock);

vi.mock('expo-constants', () => ({
  default: {
    get easConfig() {
      return mocks.projectId ? { projectId: mocks.projectId } : null;
    },
    get expoConfig() {
      return mocks.projectId ? { extra: { eas: { projectId: mocks.projectId } } } : { extra: {} };
    },
  },
}));

vi.mock('../../../src/utils/api', () => ({
  API_URL: 'https://api.example.com/api/v1',
}));

let notifyUnknownCallCapture: typeof import('../../../src/utils/notifications').notifyUnknownCallCapture;
let notifyPendingCaptureCount: typeof import('../../../src/utils/notifications').notifyPendingCaptureCount;
let registerDevicePushToken: typeof import('../../../src/utils/notifications').registerDevicePushToken;
let scheduleTaskDueReminder: typeof import('../../../src/utils/notifications').scheduleTaskDueReminder;

describe('notifications utilities', () => {
  beforeAll(async () => {
    const expoNotifications = await import('expo-notifications');
    vi.spyOn(expoNotifications, 'setNotificationChannelAsync').mockImplementation((...args) =>
      mocks.setNotificationChannelAsync(...args),
    );
    vi.spyOn(expoNotifications, 'getPermissionsAsync').mockImplementation((...args) =>
      mocks.getPermissionsAsync(...args),
    );
    vi.spyOn(expoNotifications, 'requestPermissionsAsync').mockImplementation((...args) =>
      mocks.requestPermissionsAsync(...args),
    );
    vi.spyOn(expoNotifications, 'getExpoPushTokenAsync').mockImplementation((...args) =>
      mocks.getExpoPushTokenAsync(...args),
    );
    vi.spyOn(expoNotifications, 'scheduleNotificationAsync').mockImplementation((...args) =>
      mocks.scheduleNotificationAsync(...args),
    );
    vi.spyOn(expoNotifications, 'cancelScheduledNotificationAsync').mockImplementation(
      (...args) => mocks.cancelScheduledNotificationAsync(...args),
    );

    const notifications = await import('../../../src/utils/notifications');
    notifyUnknownCallCapture = notifications.notifyUnknownCallCapture;
    notifyPendingCaptureCount = notifications.notifyPendingCaptureCount;
    registerDevicePushToken = notifications.registerDevicePushToken;
    scheduleTaskDueReminder = notifications.scheduleTaskDueReminder;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T12:00:00.000Z'));
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    mocks.setPlatformOS('ios');
    mocks.setProjectId('test-expo-project-id');
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    delete (globalThis as { expo?: unknown }).expo;
  });

  it('does not register a push token when notification permission is denied', async () => {
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
    mocks.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    const registered = await registerDevicePushToken('token-1');

    expect(registered).toBe(false);
    expect(mocks.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('requests permission when needed before registering a push token', async () => {
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    mocks.requestPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mocks.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[requested]' });
    mocks.fetch.mockResolvedValue(new Response('', { status: 200 }));

    const registered = await registerDevicePushToken('token-requested');

    expect(registered).toBe(true);
    expect(mocks.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mocks.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'test-expo-project-id' });
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/notifications/register',
      expect.objectContaining({
        body: JSON.stringify({ token: 'ExponentPushToken[requested]' }),
      }),
    );
  });

  it('registers an Expo push token with the shared API URL', async () => {
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mocks.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[test]' });
    mocks.fetch.mockResolvedValue(new Response('', { status: 200 }));

    const registered = await registerDevicePushToken('token-2');

    expect(registered).toBe(true);
    expect(mocks.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'test-expo-project-id' });
    expect(mocks.fetch).toHaveBeenCalledWith('https://api.example.com/api/v1/notifications/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-2',
      },
      body: JSON.stringify({ token: 'ExponentPushToken[test]' }),
    });
  });

  it('does not register a push token when the Expo project id is missing', async () => {
    mocks.setProjectId(null);
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'granted' });

    const registered = await registerDevicePushToken('token-no-project');

    expect(registered).toBe(false);
    expect(mocks.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('returns false when the backend rejects push token registration', async () => {
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mocks.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[test]' });
    mocks.fetch.mockResolvedValue(new Response('', { status: 500 }));

    const registered = await registerDevicePushToken('token-3');

    expect(registered).toBe(false);
  });

  it('creates the default Android notification channel before registering', async () => {
    mocks.setPlatformOS('android');
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mocks.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[android]' });
    mocks.fetch.mockResolvedValue(new Response('', { status: 200 }));

    await registerDevicePushToken('android-token');

    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledWith('default', {
      name: 'Default',
      importance: 3,
    });
  });

  it('does not schedule a task reminder when due date is missing or invalid', async () => {
    await scheduleTaskDueReminder('task-1', 'Call customer', null);
    await scheduleTaskDueReminder('task-1', 'Call customer', 'not-a-date');

    expect(mocks.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect(mocks.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('cancels but does not schedule reminders for past due dates', async () => {
    await scheduleTaskDueReminder('task-2', 'Past task', '2026-05-20');

    expect(mocks.cancelScheduledNotificationAsync).toHaveBeenCalledWith('task-due-task-2');
    expect(mocks.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('replaces and schedules future task due reminders at 9 AM local time', async () => {
    await scheduleTaskDueReminder('task-3', 'Future task', '2026-05-22');

    expect(mocks.cancelScheduledNotificationAsync).toHaveBeenCalledWith('task-due-task-3');
    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'task-due-task-3',
      content: {
        title: 'Task Due Today',
        body: 'Future task',
        data: { taskId: 'task-3' },
        sound: 'default',
      },
      trigger: {
        date: new Date('2026-05-22T09:00:00'),
        channelId: 'default',
      },
    });
  });

  it('still schedules a future task reminder when canceling the old reminder fails', async () => {
    mocks.cancelScheduledNotificationAsync.mockRejectedValueOnce(new Error('missing reminder'));

    await scheduleTaskDueReminder('task-4', 'Recover reminder', '2026-05-22');

    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: 'task-due-task-4',
      }),
    );
  });

  it('does not schedule unknown caller notifications without permission', async () => {
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await notifyUnknownCallCapture('+15551234567');

    expect(mocks.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('schedules unknown caller notifications when permission is granted', async () => {
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'granted' });

    await notifyUnknownCallCapture('+15551234567');

    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: {
        title: 'Unknown call',
        body: 'Unknown caller +15551234567 - add to CRM?',
        data: { type: 'call_capture', phone: '+15551234567' },
        sound: 'default',
      },
      trigger: null,
    });
  });

  it('does not schedule pending capture notifications when count is zero', async () => {
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'granted' });

    await notifyPendingCaptureCount('Pending captures', 'Nothing pending', 0);

    expect(mocks.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('schedules pending capture notifications when permission is granted and count is positive', async () => {
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'granted' });

    await notifyPendingCaptureCount('Pending captures', '3 captures need review', 3);

    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: {
        title: 'Pending captures',
        body: '3 captures need review',
        data: { type: 'pending_captures' },
        sound: 'default',
      },
      trigger: null,
    });
  });
});
