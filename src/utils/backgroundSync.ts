import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import { queryClient } from './queryClient';
import * as offlineQueue from './offlineQueue';
import { useSyncStore } from '../store/syncStore';

const TASK_NAME = 'crm-background-sync';
const LAST_SYNC_KEY = 'crm-last-sync-at';

const API_URL_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:3000/api/v1';

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
  const token = await SecureStore.getItemAsync('crm_auth_token');
  if (!token) return;

  const lastSyncAt = await AsyncStorage.getItem(LAST_SYNC_KEY);
  const sinceParam = lastSyncAt ? `?since=${encodeURIComponent(lastSyncAt)}` : '';

  const response = await fetch(`${API_URL_BASE}/sync/delta${sinceParam}`, {
    headers: { Authorization: `Bearer ${token}` },
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
    await queryClient.invalidateQueries({ queryKey: ['deals'] });
    await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    await queryClient.invalidateQueries({ queryKey: ['events'] });
  }

  await offlineQueue.flush();
  await AsyncStorage.setItem(LAST_SYNC_KEY, body.meta.server_time);
}

TaskManager.defineTask(TASK_NAME, async () => {
  try {
    await performSync();
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  try {
    await BackgroundFetch.registerTaskAsync(TASK_NAME, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch {
    // Background fetch not available in Expo Go; silently skip.
  }
}

export async function runSync(): Promise<void> {
  const { setSyncing, setSynced } = useSyncStore.getState();
  setSyncing();
  try {
    await performSync();
    setSynced();
  } catch {
    setSynced();
  }
}
