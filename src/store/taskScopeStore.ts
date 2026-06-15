import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

export type TaskScope = 'direct' | 'subtree';

const STORAGE_KEY = 'crm_task_scope';

interface TaskScopeState {
  /** 'direct' = my reports (one level, default); 'subtree' = whole team. */
  scope: TaskScope;
  hydrated: boolean;
  /** Load the manager's saved default from the device. */
  hydrate: () => Promise<void>;
  /** Change the view and persist it as the new default. */
  setScope: (scope: TaskScope) => Promise<void>;
}

/**
 * Persists each manager's preferred task-list depth ("My reports" vs "Whole
 * team") on the device, so the app re-opens to whatever they last chose. The
 * value is sent to the API as `?scope=`; the server enforces the actual cone.
 */
export const useTaskScopeStore = create<TaskScopeState>((set) => ({
  scope: 'direct',
  hydrated: false,

  hydrate: async (): Promise<void> => {
    try {
      const saved = await SecureStore.getItemAsync(STORAGE_KEY);
      set({ scope: saved === 'subtree' ? 'subtree' : 'direct', hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  setScope: async (scope: TaskScope): Promise<void> => {
    set({ scope });
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, scope);
    } catch {
      // best-effort persistence; the in-memory value still applies this session
    }
  },
}));
