import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { API_URL } from './api';

const DEFAULT_NOTIFICATION_CHANNEL_ID = 'default';

export async function ensureDefaultNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync(DEFAULT_NOTIFICATION_CHANNEL_ID, {
    name: 'Default',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

export async function registerDevicePushToken(authToken: string): Promise<boolean> {
  await ensureDefaultNotificationChannel();

  const existingPermission = await Notifications.getPermissionsAsync();
  let finalStatus = existingPermission.status;

  if (finalStatus !== 'granted') {
    const requestedPermission = await Notifications.requestPermissionsAsync();
    finalStatus = requestedPermission.status;
  }

  if (finalStatus !== 'granted') return false;

  const pushTokenData = await Notifications.getExpoPushTokenAsync();
  const response = await fetch(`${API_URL}/notifications/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ token: pushTokenData.data }),
  });

  return response.ok;
}

function taskReminderIdentifier(taskId: string): string {
  return `task-due-${taskId}`;
}

function taskReminderDate(dueDate: string): Date {
  const dateOnly = dueDate.includes('T') ? dueDate.slice(0, 10) : dueDate;
  return new Date(`${dateOnly}T09:00:00`);
}

export async function scheduleTaskDueReminder(taskId: string, title: string, dueDate: string): Promise<void> {
  const triggerDate = taskReminderDate(dueDate);

  await cancelTaskDueReminder(taskId);

  if (triggerDate <= new Date()) return;

  await ensureDefaultNotificationChannel();

  await Notifications.scheduleNotificationAsync({
    identifier: taskReminderIdentifier(taskId),
    content: {
      title: 'Task Due Today',
      body: title,
      data: { taskId },
      sound: 'default',
    },
    trigger: {
      date: triggerDate,
      channelId: DEFAULT_NOTIFICATION_CHANNEL_ID,
    },
  });
}

export async function cancelTaskDueReminder(taskId: string): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(taskReminderIdentifier(taskId));
  } catch {
    // Cancellation is best-effort; unsupported platforms should not block task flows.
  }
}
