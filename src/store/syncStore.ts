import { create } from 'zustand';

export type SyncStatus = 'offline' | 'syncing' | 'synced';

interface SyncState {
  status: SyncStatus;
  setOffline: () => void;
  setSyncing: () => void;
  setSynced: () => void;
}

export const useSyncStore = create<SyncState>()((set) => ({
  status: 'synced',
  setOffline: () => set({ status: 'offline' }),
  setSyncing: () => set({ status: 'syncing' }),
  setSynced: () => set({ status: 'synced' }),
}));
