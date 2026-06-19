import { create } from 'zustand';

export type SyncStatus = 'offline' | 'syncing' | 'synced';

export interface ConflictRecord {
  entity: string;
  id: string;
  localValue: unknown;
  serverValue: unknown;
  resolvedAt: string;
}

interface SyncState {
  status: SyncStatus;
  conflicts: ConflictRecord[];
  setSyncing: () => void;
  setSynced: () => void;
  addConflict: (c: ConflictRecord) => void;
  clearConflicts: () => void;
}

export const useSyncStore = create<SyncState>()((set) => ({
  status: 'synced',
  conflicts: [],
  setSyncing: () => set({ status: 'syncing' }),
  setSynced: () => set({ status: 'synced' }),
  addConflict: (c) => set((s) => ({ conflicts: [...s.conflicts, c] })),
  clearConflicts: () => set({ conflicts: [] }),
}));
