import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { useSyncStore } from '../store/syncStore';

const STORAGE_KEY = 'crm-offline-queue';
const BODY_KEY_PREFIX = 'crm-offline-queue-body-';

export type QueuedMutation = {
  id: string;
  url: string;
  method: string;
  body: string;
  enqueuedAt: number;
  bodyKey?: string;
  followUp?: QueuedMutationFollowUp;
};

export type QueuedMutationFollowUp = {
  kind: 'matchCaptureToCreatedContact';
  url: string;
  method: 'POST';
};

type StoredQueuedMutation = Omit<QueuedMutation, 'body'> & {
  bodyKey?: string;
  body?: string;
};

let queueOperation: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isQueuedMutationFollowUp(value: unknown): value is QueuedMutationFollowUp {
  return (
    isRecord(value) &&
    value.kind === 'matchCaptureToCreatedContact' &&
    typeof value.url === 'string' &&
    value.method === 'POST'
  );
}

function isStoredQueuedMutation(value: unknown): value is StoredQueuedMutation {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.url === 'string' &&
    typeof value.method === 'string' &&
    (value.body === undefined || typeof value.body === 'string') &&
    (value.bodyKey === undefined || typeof value.bodyKey === 'string') &&
    typeof value.enqueuedAt === 'number' &&
    (value.followUp === undefined || isQueuedMutationFollowUp(value.followUp))
  );
}

function bodyKeyFor(id: string): string {
  return `${BODY_KEY_PREFIX}${id}`;
}

async function withQueueLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = queueOperation.then(operation, operation);
  queueOperation = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readStoredQueue(): Promise<StoredQueuedMutation[]> {
  const value: string | null = await AsyncStorage.getItem(STORAGE_KEY);

  if (!value) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isStoredQueuedMutation);
  } catch {
    return [];
  }
}

async function readQueue(): Promise<QueuedMutation[]> {
  const storedQueue = await readStoredQueue();
  const queue: QueuedMutation[] = [];

  for (const storedMutation of storedQueue) {
    let body: string | null;

    if (storedMutation.bodyKey) {
      try {
        body = await SecureStore.getItemAsync(storedMutation.bodyKey);
      } catch {
        body = null;
      }

      if (body === null) {
        continue;
      }
    } else {
      body = storedMutation.body ?? '';
    }

    queue.push({
      id: storedMutation.id,
      url: storedMutation.url,
      method: storedMutation.method,
      body,
      enqueuedAt: storedMutation.enqueuedAt,
      bodyKey: storedMutation.bodyKey,
      followUp: storedMutation.followUp,
    });
  }

  return queue;
}

async function writeQueue(queue: QueuedMutation[]): Promise<void> {
  const storedQueue: StoredQueuedMutation[] = [];

  for (const mutation of queue) {
    const bodyKey = mutation.bodyKey ?? bodyKeyFor(mutation.id);
    await SecureStore.setItemAsync(bodyKey, mutation.body);
    storedQueue.push({
      id: mutation.id,
      url: mutation.url,
      method: mutation.method,
      enqueuedAt: mutation.enqueuedAt,
      bodyKey,
      followUp: mutation.followUp,
    });
    mutation.bodyKey = bodyKey;
  }

  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));
}

function createQueueId(): string {
  return `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueue(
  mutation: Omit<QueuedMutation, 'id' | 'enqueuedAt'>,
): Promise<QueuedMutation> {
  return withQueueLock(async () => {
    const queue: QueuedMutation[] = await readQueue();
    const id = createQueueId();
    const queuedMutation: QueuedMutation = {
      ...mutation,
      id,
      bodyKey: bodyKeyFor(id),
      enqueuedAt: Date.now(),
    };

    queue.push(queuedMutation);

    await writeQueue(queue);
    return queuedMutation;
  });
}

export async function dequeue(): Promise<QueuedMutation | null> {
  return withQueueLock(async () => {
    const queue: QueuedMutation[] = await readQueue();

    if (queue.length === 0) {
      return null;
    }

    const mutation: QueuedMutation | undefined = queue.shift();
    await writeQueue(queue);

    if (mutation?.bodyKey) {
      await SecureStore.deleteItemAsync(mutation.bodyKey);
    }

    return mutation ?? null;
  });
}

function entityFromUrl(url: string): string {
  const parts = url.replace(/\?.*$/, '').split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!/^[0-9a-f-]{8,}$/i.test(parts[i])) return parts[i];
  }
  return 'record';
}

function idFromUrl(url: string, fallback: string): string {
  const last = url.replace(/\?.*$/, '').split('/').pop() ?? '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last)
    ? last
    : fallback;
}

function parseJsonValue(value: string): unknown {
  if (value.trim() === '') {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text.trim() === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function idFromCreateResponse(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.id === 'string') {
    return value.id;
  }

  const data = value.data;
  return isRecord(data) && typeof data.id === 'string' ? data.id : null;
}

function mutationForFollowUp(
  source: QueuedMutation,
  responseBody: unknown,
): QueuedMutation | null {
  if (!source.followUp) {
    return null;
  }

  const contactId = idFromCreateResponse(responseBody);
  if (!contactId) {
    return null;
  }

  return {
    id: `${source.id}-follow-up`,
    url: source.followUp.url,
    method: source.followUp.method,
    body: JSON.stringify({ contact_id: contactId }),
    enqueuedAt: Date.now(),
  };
}

async function sendQueuedMutation(
  mutation: QueuedMutation,
  token: string,
): Promise<{ response: Response; body: unknown | null }> {
  const response = await fetch(mutation.url, {
    method: mutation.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: mutation.body || undefined,
  });

  return {
    response,
    body: mutation.followUp ? await readResponseJson(response) : null,
  };
}

function addConflictFromMutation(mutation: QueuedMutation, serverValue: unknown): void {
  useSyncStore.getState().addConflict({
    entity: entityFromUrl(mutation.url),
    id: idFromUrl(mutation.url, mutation.id),
    localValue: parseJsonValue(mutation.body),
    serverValue,
    resolvedAt: new Date().toISOString(),
  });
}

export async function flush(): Promise<void> {
  await withQueueLock(async () => {
    const queue: QueuedMutation[] = await readQueue();
    const remaining: QueuedMutation[] = [...queue];
    const processedBodyKeys: string[] = [];

    for (const mutation of queue) {
      const token: string | null = await SecureStore.getItemAsync('crm_auth_token');

      if (!token) {
        await writeQueue(remaining);
        return;
      }

      try {
        const { response, body } = await sendQueuedMutation(mutation, token);

        if (response.status === 409) {
          const serverValue: unknown = body ?? (await readResponseJson(response));
          addConflictFromMutation(mutation, serverValue);
          remaining.shift();
          if (mutation.bodyKey) processedBodyKeys.push(mutation.bodyKey);
          continue;
        }

        if (!response.ok) {
          break;
        }

        remaining.shift();
        if (mutation.bodyKey) processedBodyKeys.push(mutation.bodyKey);

        const followUpMutation = mutationForFollowUp(mutation, body);
        if (followUpMutation) {
          try {
            const { response: followUpResponse } = await sendQueuedMutation(followUpMutation, token);

            if (followUpResponse.status === 409) {
              addConflictFromMutation(followUpMutation, await readResponseJson(followUpResponse));
            } else if (!followUpResponse.ok) {
              remaining.unshift(followUpMutation);
              break;
            }
          } catch {
            remaining.unshift(followUpMutation);
            break;
          }
        }
      } catch {
        break;
      }
    }

    await writeQueue(remaining);

    for (const bodyKey of processedBodyKeys) {
      await SecureStore.deleteItemAsync(bodyKey);
    }
  });
}

export async function clear(): Promise<void> {
  await withQueueLock(async () => {
    const storedQueue = await readStoredQueue();

    await AsyncStorage.removeItem(STORAGE_KEY);

    await Promise.all(
      storedQueue
        .map((mutation) => mutation.bodyKey)
        .filter((bodyKey): bodyKey is string => typeof bodyKey === 'string')
        .map((bodyKey) => SecureStore.deleteItemAsync(bodyKey)),
    );
  });
}
