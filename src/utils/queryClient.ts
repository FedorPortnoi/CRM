import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';

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
