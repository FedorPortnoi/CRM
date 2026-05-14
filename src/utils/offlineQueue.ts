import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = 'crm-offline-queue';

export type QueuedMutation = {
  id: string;
  url: string;
  method: string;
  body: string;
  enqueuedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isQueuedMutation(value: unknown): value is QueuedMutation {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.url === 'string' &&
    typeof value.method === 'string' &&
    typeof value.body === 'string' &&
    typeof value.enqueuedAt === 'number'
  );
}

async function readQueue(): Promise<QueuedMutation[]> {
  const value: string | null = await AsyncStorage.getItem(STORAGE_KEY);

  if (!value) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isQueuedMutation);
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueuedMutation[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

function createQueueId(): string {
  return `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueue(
  mutation: Omit<QueuedMutation, 'id' | 'enqueuedAt'>,
): Promise<void> {
  const queue: QueuedMutation[] = await readQueue();

  queue.push({
    ...mutation,
    id: createQueueId(),
    enqueuedAt: Date.now(),
  });

  await writeQueue(queue);
}

export async function dequeue(): Promise<QueuedMutation | null> {
  const queue: QueuedMutation[] = await readQueue();

  if (queue.length === 0) {
    return null;
  }

  const mutation: QueuedMutation | undefined = queue.shift();
  await writeQueue(queue);

  return mutation ?? null;
}

export async function flush(): Promise<void> {
  const queue: QueuedMutation[] = await readQueue();
  const remaining: QueuedMutation[] = [...queue];

  for (const mutation of queue) {
    const token: string | null = await SecureStore.getItemAsync('crm_auth_token');

    if (!token) {
      await writeQueue(remaining);
      return;
    }

    try {
      const response: Response = await fetch(mutation.url, {
        method: mutation.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: mutation.body,
      });

      if (!response.ok) {
        break;
      }

      remaining.shift();
    } catch {
      break;
    }
  }

  await writeQueue(remaining);
}

export async function clear(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
