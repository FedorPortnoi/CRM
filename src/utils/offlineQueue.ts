import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { useSyncStore } from '../store/syncStore';
import { authHeaders } from './api';

const STORAGE_KEY = 'crm-offline-queue';
const BODY_KEY_PREFIX = 'crm-offline-queue-body-';

// Written by userStore on login/restore and deleted by logout(); read here rather than through
// the zustand store so that the session check uses exactly the same source of truth, at exactly
// the same moment, as authHeaders() uses for the token. See currentSession() below.
// Both keys mirror the ones in src/store/userStore.ts and src/utils/api.ts.
const AUTH_TOKEN_KEY = 'crm_auth_token';
const AUTH_USER_KEY = 'crm_auth_user';

export type QueuedMutation = {
  id: string;
  url: string;
  method: string;
  body: string;
  enqueuedAt: number;
  bodyKey?: string;
  followUp?: QueuedMutationFollowUp;
  // Id of the user who authored this write. flush() refuses to send a mutation whose owner is
  // not the current session — see the comment in flush().
  owner?: string;
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
    (value.owner === undefined || typeof value.owner === 'string') &&
    (value.followUp === undefined || isQueuedMutationFollowUp(value.followUp))
  );
}

function bodyKeyFor(id: string): string {
  return `${BODY_KEY_PREFIX}${id}`;
}

// Why the signed-in account's id is, or is not, known.
//
//   'known'      — read and parsed; `userId` holds it.
//   'absent'     — there is no user record on the device at all.
//   'unreadable' — a record exists but its id could not be recovered: SecureStore threw, the
//                  JSON did not parse, or `id` was not a string.
//
// The last two are the same value (`userId: null`) and opposite facts. 'absent' is "nobody is
// signed in"; 'unreadable' is "somebody IS signed in and we cannot tell who" — which is the one
// case where an unstamped queue item must never be adopted. See flush().
type SessionIdentity = 'known' | 'absent' | 'unreadable';

type SessionSnapshot = {
  // Present iff credentials are on the device. Deliberately not the token value — nothing here
  // sends it; authHeaders() re-reads it for that.
  hasToken: boolean;
  // Id of the signed-in account, or null when it cannot be determined. Never compare against
  // this without consulting `identity`: null is ambiguous and the ambiguity is exploitable.
  userId: string | null;
  identity: SessionIdentity;
};

// Reads whose credentials are on the device right now.
//
// This deliberately reads SecureStore instead of useUserStore: flush() runs from a background
// task and from the NetInfo listener, where the zustand store may not have been hydrated yet,
// and authHeaders() reads the token from SecureStore at send time too. Pairing the owner check
// with the same storage the token comes from means the two can never disagree. It also keeps
// this module free of a userStore import, which would be a cycle — userStore calls clearQueue()
// on logout.
async function currentSession(): Promise<SessionSnapshot> {
  let hasToken = false;
  try {
    hasToken = (await SecureStore.getItemAsync(AUTH_TOKEN_KEY)) !== null;
  } catch {
    hasToken = false;
  }

  let userJson: string | null;
  try {
    userJson = await SecureStore.getItemAsync(AUTH_USER_KEY);
  } catch {
    // A read that threw says nothing about whether the record exists. Unreadable, not absent.
    return { hasToken, userId: null, identity: 'unreadable' };
  }

  if (!userJson) {
    return { hasToken, userId: null, identity: 'absent' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(userJson);
  } catch {
    // A record is there; it is corrupt (truncated write, partially overwritten keystore).
    return { hasToken, userId: null, identity: 'unreadable' };
  }

  if (!isRecord(parsed) || typeof parsed.id !== 'string') {
    return { hasToken, userId: null, identity: 'unreadable' };
  }

  return { hasToken, userId: parsed.id, identity: 'known' };
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
      owner: storedMutation.owner,
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
      owner: mutation.owner,
    });
    mutation.bodyKey = bodyKey;
  }

  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));
}

// Every SecureStore body key the persisted index references, taken from the RAW parsed JSON
// rather than from readStoredQueue(). An entry that fails the type guard (truncated write, a
// shape from a future build) still has a body sitting in SecureStore, and clearQueue() has to
// leave nothing behind.
async function referencedBodyKeys(): Promise<string[]> {
  const value: string | null = await AsyncStorage.getItem(STORAGE_KEY);

  if (!value) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const keys: string[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      continue;
    }
    if (typeof entry.bodyKey === 'string') {
      keys.push(entry.bodyKey);
    } else if (typeof entry.id === 'string') {
      keys.push(bodyKeyFor(entry.id));
    }
  }

  return keys;
}

// Drops the whole queue AND the SecureStore bodies it points at. Called by logout(): the index
// lives in AsyncStorage under one key but each body lives under its own SecureStore key, so
// deleting the index alone would leave the previous account's payloads on the device forever
// with nothing left to enumerate them.
export async function clearQueue(): Promise<void> {
  await withQueueLock(async () => {
    const bodyKeys = await referencedBodyKeys();

    // Bodies first, index last, and the order is the whole point. logout() is best-effort and
    // interruptible — force-quit, crash, OS kill — as flush() already documents. Removing the
    // index first means an interruption in the gap leaves the previous account's payloads in
    // SecureStore with the only thing that could enumerate them already gone: unreachable,
    // undeletable, and full of PII. That is the exact outcome this function exists to prevent.
    //
    // In this order an interruption can only leave the opposite state — an index pointing at
    // bodies that are already deleted — and that one is already handled: readQueue() skips any
    // entry whose body reads back null, and the next clearQueue() deletes the index. Crash-safe
    // in both halves rather than only in the one that happens to finish.
    for (const bodyKey of bodyKeys) {
      try {
        await SecureStore.deleteItemAsync(bodyKey);
      } catch {
        // A single body that refuses to delete must not abandon the rest of the sweep.
      }
    }

    await AsyncStorage.removeItem(STORAGE_KEY);
  });
}

function createQueueId(): string {
  return `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueue(
  mutation: Omit<QueuedMutation, 'id' | 'enqueuedAt' | 'owner'>,
): Promise<QueuedMutation> {
  return withQueueLock(async () => {
    const { userId: owner } = await currentSession();
    const queue: QueuedMutation[] = await readQueue();
    const id = createQueueId();
    const queuedMutation: QueuedMutation = {
      ...mutation,
      id,
      bodyKey: bodyKeyFor(id),
      enqueuedAt: Date.now(),
      // Stamped at authoring time, not at send time. This is what lets flush() tell "a write
      // this account made while offline" apart from "a write the previous account left behind".
      owner: owner ?? undefined,
    };

    queue.push(queuedMutation);

    await writeQueue(queue);
    return queuedMutation;
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
    // Inherits the parent's owner: if the follow-up has to be re-queued it must be subject to
    // the same session check as the write that produced it.
    owner: source.owner,
  };
}

async function sendQueuedMutation(
  mutation: QueuedMutation,
  headers: { 'Content-Type': string; Authorization: string },
): Promise<{ response: Response; body: unknown | null }> {
  const response = await fetch(mutation.url, {
    method: mutation.method,
    headers,
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

export type DropReason =
  // Authored by a different account than the one currently signed in on this device.
  | 'foreign-session'
  // The server answered with a status that will never become a success on retry.
  | 'terminal-response';

export type DroppedMutation = {
  id: string;
  url: string;
  method: string;
  enqueuedAt: number;
  droppedAt: number;
  reason: DropReason;
  status?: number;
};

const MAX_DROP_LOG = 20;
let dropLog: DroppedMutation[] = [];

// A drop is not a conflict, so it deliberately does NOT go through useSyncStore.addConflict():
// ConflictToast renders that list as «записи обновлены сервером при синхронизации», which would
// tell the user their edit was reconciled when in fact it was discarded. Until there is a store
// field for discarded writes, the record is a warning plus this bounded in-memory log — enough
// for a bug report and for tests, and never silent.
//
// The body is intentionally not recorded: it is customer PII and the whole point of the
// SecureStore split is to keep it out of anything that might get logged or serialised.
function recordDrop(mutation: QueuedMutation, reason: DropReason, status?: number): void {
  const dropped: DroppedMutation = {
    id: mutation.id,
    url: mutation.url,
    method: mutation.method,
    enqueuedAt: mutation.enqueuedAt,
    droppedAt: Date.now(),
    reason,
    ...(status === undefined ? {} : { status }),
  };

  dropLog = [...dropLog, dropped].slice(-MAX_DROP_LOG);
  console.warn('[offlineQueue] dropped queued mutation', dropped);
}

export function getDroppedMutations(): readonly DroppedMutation[] {
  return dropLog;
}

export function clearDroppedMutations(): void {
  dropLog = [];
}

// Which failures are worth waiting for. 5xx is the server being unwell, 408 is the request
// timing out and 429 is a rate limit — all of them succeed on a later attempt, so the queue
// stops and preserves order. Every other 4xx is the server saying this request is invalid
// forever (403 on a record the user lost access to, 404 on a record deleted elsewhere, 422 on a
// payload the schema no longer accepts); retrying it wedges the queue and buries every edit
// made after it.
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export async function flush(): Promise<void> {
  await withQueueLock(async () => {
    const session = await currentSession();

    // Nobody is signed in on this device. Do not send (authHeaders() would produce a bare
    // "Bearer ", which the server rejects and this loop would then treat as terminal and
    // discard) and do not delete (an interrupted logout may have left work here that its owner
    // can still finish after signing back in). flush() is called from a NetInfo listener that
    // fires regardless of auth state, so this path is reached routinely.
    if (!session.hasToken) {
      return;
    }

    // Credentials are on the device but the account behind them cannot be identified. Fail
    // closed and send nothing.
    //
    // The owner check below is stated as "drop on positive evidence of a mismatch", and that
    // only holds while `session.userId` means what it says. It used to collapse three different
    // situations into null — no user record, unparseable JSON, a non-string id — so a signed-in
    // user B with a corrupt crm_auth_user compared EQUAL to an unstamped item left by user A,
    // and the item was sent under B's token into B's org: the cross-account write the check
    // exists to stop, reached through the check itself.
    //
    // Skipped rather than dropped, for the same reason as the no-token path above: the queue may
    // hold work its owner can still finish, and an unreadable record is often transient (a
    // locked keychain, a half-written login). Nothing is lost — the next flush() re-reads it,
    // and once the id is legible again the owner check answers properly.
    if (session.identity === 'unreadable') {
      return;
    }

    const queue: QueuedMutation[] = await readQueue();
    const remaining: QueuedMutation[] = [...queue];
    const processedBodyKeys: string[] = [];

    const headers = await authHeaders();

    for (const mutation of queue) {
      // Belt and braces behind logout(). logout() clears the queue, but it is best-effort and
      // interruptible — force-quit, crash, OS kill — and this loop runs from a background task
      // the user cannot see. Because authHeaders() re-reads the token at send time, any item
      // surviving a logout would be replayed under the NEXT account's token, writing user A's
      // records into user B's org. An item that is not stamped with the current user id is
      // therefore never sent.
      //
      // The test is "drop on positive evidence of a mismatch". An unstamped item (a queue
      // written by a build that predates this stamp) is dropped as soon as the current session
      // has a known id — adopting it is exactly the cross-account write this check exists to
      // stop, and the loss is bounded to writes left pending across a single app upgrade. It is
      // only sent when the current session's id is *also* unknown, i.e. there is no evidence
      // the account changed at all — and by the guard above, only when that unknown is 'absent'
      // (no user record at all), never 'unreadable' (a record we could not decipher).
      if ((mutation.owner ?? null) !== session.userId) {
        recordDrop(mutation, 'foreign-session');
        remaining.shift();
        if (mutation.bodyKey) processedBodyKeys.push(mutation.bodyKey);
        continue;
      }

      try {
        const { response, body } = await sendQueuedMutation(mutation, headers);

        if (response.status === 409) {
          const serverValue: unknown = body ?? (await readResponseJson(response));
          addConflictFromMutation(mutation, serverValue);
          remaining.shift();
          if (mutation.bodyKey) processedBodyKeys.push(mutation.bodyKey);
          continue;
        }

        if (!response.ok) {
          // Retryable: stop here so ordering is preserved — later items may depend on this one.
          if (isRetryableStatus(response.status)) break;

          // Terminal: this item can never succeed, so drop it and keep going. The old code
          // broke here unconditionally, which meant one permanently-failing PATCH blocked the
          // queue forever and silently swallowed every offline edit made after it.
          recordDrop(mutation, 'terminal-response', response.status);
          remaining.shift();
          if (mutation.bodyKey) processedBodyKeys.push(mutation.bodyKey);
          continue;
        }

        remaining.shift();
        if (mutation.bodyKey) processedBodyKeys.push(mutation.bodyKey);

        const followUpMutation = mutationForFollowUp(mutation, body);
        if (followUpMutation) {
          try {
            const { response: followUpResponse } = await sendQueuedMutation(followUpMutation, headers);

            if (followUpResponse.status === 409) {
              addConflictFromMutation(followUpMutation, await readResponseJson(followUpResponse));
            } else if (!followUpResponse.ok) {
              // Same split as above. Its parent has already been sent and shifted off, so a
              // terminal follow-up is simply recorded and the queue moves on.
              if (isRetryableStatus(followUpResponse.status)) {
                remaining.unshift(followUpMutation);
                break;
              }
              recordDrop(followUpMutation, 'terminal-response', followUpResponse.status);
            }
          } catch {
            remaining.unshift(followUpMutation);
            break;
          }
        }
      } catch {
        // A thrown fetch is a transport failure (no network, DNS, TLS): always retryable.
        break;
      }
    }

    await writeQueue(remaining);

    for (const bodyKey of processedBodyKeys) {
      await SecureStore.deleteItemAsync(bodyKey);
    }
  });
}
