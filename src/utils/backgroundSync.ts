import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { queryClient } from './queryClient';
import * as offlineQueue from './offlineQueue';
import { useSyncStore } from '../store/syncStore';
import { API_URL, authHeaders } from './api';

export const BACKGROUND_SYNC_TASK_NAME = 'crm-background-sync';
const LAST_SYNC_KEY = 'crm-last-sync-at';

type DeltaPayload = {
  data: {
    contacts: unknown[];
    deals: unknown[];
    tasks: unknown[];
    events: unknown[];
  };
  meta: { since: string; server_time: string };
};

async function performSync(): Promise<void> {
  await offlineQueue.flush();

  const lastSyncAt = await AsyncStorage.getItem(LAST_SYNC_KEY);
  const sinceParam = lastSyncAt ? `?since=${encodeURIComponent(lastSyncAt)}` : '';

  const response = await fetch(`${API_URL}/sync/delta${sinceParam}`, {
    headers: await authHeaders(),
  });

  if (!response.ok) return;

  const body = (await response.json()) as DeltaPayload;

  if (
    body.data.contacts.length > 0 ||
    body.data.deals.length > 0 ||
    body.data.tasks.length > 0 ||
    body.data.events.length > 0
  ) {
    await queryClient.invalidateQueries({ queryKey: ['contacts'] });
    await queryClient.invalidateQueries({ queryKey: ['events'] });
  }

  await AsyncStorage.setItem(LAST_SYNC_KEY, body.meta.server_time);
}

TaskManager.defineTask(BACKGROUND_SYNC_TASK_NAME, async () => {
  try {
    await performSync();
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  try {
    await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK_NAME, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch {
    // Background fetch not available in Expo Go; silently skip.
  }
}
