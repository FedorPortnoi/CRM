import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { PersistQueryClientProviderProps } from '@tanstack/react-query-persist-client';

type PersistOptions = NonNullable<PersistQueryClientProviderProps['persistOptions']>;
type ShouldDehydrateQuery = NonNullable<
  NonNullable<PersistOptions['dehydrateOptions']>['shouldDehydrateQuery']
>;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: (failureCount: number, error: unknown) => {
        if (error instanceof Error && error.message.includes('status 401')) return false;
        return failureCount < 3;
      },
      retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 30000),
    },
  },
});

export const asyncStoragePersister = createAsyncStoragePersister({
  key: 'crm-query-cache',
  storage: AsyncStorage,
});

// The persisted cache lives in PLAINTEXT AsyncStorage (readable via adb backup, a
// stolen device, or an unencrypted iCloud/iTunes backup). Two kinds of secrets must
// never be dehydrated into it:
//   1. The bearer JWT — it is embedded as an element inside nearly every query key
//      (e.g. ['contacts', ..., token]), so a leaking KEY exposes the token even though
//      the token value itself lives in expo-secure-store.
//   2. Org PII and the company/join code — the data payloads of these collections.
// Offline behaviour does not depend on this cache: mutations are handled by the offline
// queue and reads are re-fetched by the background delta sync, so excluding these
// queries costs only cold-start stale reads, which is an acceptable trade for keeping
// secrets out of plaintext.

// Matches the three base64url segments of a JWT: header.payload.signature.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// First query-key segments whose data is org PII or contains the company/join code.
const SENSITIVE_KEY_PREFIXES = new Set<string>([
  'company-code',
  'org-users',
  'audit-log',
  'contacts',
  'contacts-counts',
  'deals',
  'tasks-today',
  'tasks-all',
  'task-assignees',
  'calendar-events',
  'events',
]);

const shouldDehydrateQuery: ShouldDehydrateQuery = (query) => {
  // Only ever persist successful queries (matches the library default).
  if (query.state.status !== 'success') return false;

  const key = query.queryKey;
  if (Array.isArray(key)) {
    for (const part of key) {
      // Block any key carrying the bearer token in JWT form.
      if (typeof part === 'string' && JWT_SHAPE.test(part)) return false;
    }
    const [head] = key;
    if (typeof head === 'string' && SENSITIVE_KEY_PREFIXES.has(head)) return false;
  }

  return true;
};

export const persistOptions: PersistOptions = {
  persister: asyncStoragePersister,
  // Expire the whole persisted blob after 24h so stale cached data cannot linger.
  maxAge: 24 * 60 * 60 * 1000,
  dehydrateOptions: {
    shouldDehydrateQuery,
  },
};
