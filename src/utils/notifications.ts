import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { API_URL } from './api';

const DEFAULT_NOTIFICATION_CHANNEL_ID = 'default';

export type NotificationPermissionSnapshot = {
  status: string;
  granted: boolean;
  canAskAgain: boolean;
};

export type PushRegistrationResult =
  | { ok: true; message: string }
  | { ok: false; reason: string; message: string };

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

    const projectId = getExpoPushProjectId();
    if (!projectId) {
      return {
        ok: false,
        reason: 'missing-project-id',
        message: 'Push notifications are not configured for this build.',
      };
    }

    const pushTokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const response = await fetch(`${API_URL}/notifications/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ token: pushTokenData.data }),
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: 'server-error',
        message:
          (await parseErrorMessage(response)) ??
          `Push registration failed with status ${response.status}.`,
      };
    }

    return { ok: true, message: 'Push notifications enabled.' };
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
