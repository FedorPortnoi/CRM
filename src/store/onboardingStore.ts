import { create } from 'zustand';
import { API_URL } from '../utils/api';

interface BackendOnboardingState {
  completed_steps?: string[];
  dismissed_tooltips?: string[];
  example_data_loaded?: boolean;
  completed_at?: string | null;
  completed?: boolean;
}

interface OnboardingStore {
  remoteState: BackendOnboardingState | null;
  visible: boolean;
  currentStepIndex: number;
  fetch: (token: string) => Promise<void>;
  completeStep: (token: string, step: string) => Promise<void>;
  skipAll: (token: string) => Promise<void>;
}

export const WALKTHROUGH_STEPS = ['contacts', 'deals', 'tasks', 'calendar'] as const;

function completedSteps(state: BackendOnboardingState): string[] {
  if (Array.isArray(state.completed_steps)) return state.completed_steps;
  return state.completed === true ? [...WALKTHROUGH_STEPS] : [];
}

function isCompleted(state: BackendOnboardingState): boolean {
  return state.completed === true || typeof state.completed_at === 'string';
}

async function patchRemote(token: string, body: Partial<BackendOnboardingState>): Promise<BackendOnboardingState> {
  const res = await fetch(`${API_URL}/onboarding`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data: BackendOnboardingState };
  return json.data;
}

export const useOnboardingStore = create<OnboardingStore>()((set, get) => ({
  remoteState: null,
  visible: false,
  currentStepIndex: 0,

  fetch: async (token: string): Promise<void> => {
    try {
      const res = await fetch(`${API_URL}/onboarding`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const json = (await res.json()) as { data: BackendOnboardingState };
      const state = json.data;
      const steps = completedSteps(state);
      const allDone = isCompleted(state);
      const nextIdx = WALKTHROUGH_STEPS.findIndex((s) => !steps.includes(s));
      set({
        remoteState: state,
        visible: !allDone && nextIdx !== -1,
        currentStepIndex: nextIdx === -1 ? WALKTHROUGH_STEPS.length - 1 : nextIdx,
      });
    } catch {
      // network unavailable — silently skip walkthrough
    }
  },

  completeStep: async (token: string, step: string): Promise<void> => {
    const { remoteState } = get();
    if (!remoteState) return;
    const newSteps = Array.from(new Set([...completedSteps(remoteState), step]));
    const allDone = WALKTHROUGH_STEPS.every((s) => newSteps.includes(s));
    const updated = await patchRemote(token, {
      completed_steps: newSteps,
      ...(allDone ? { completed_at: new Date().toISOString() } : {}),
    });
    const updatedSteps = completedSteps(updated);
    const nextIdx = WALKTHROUGH_STEPS.findIndex((s) => !updatedSteps.includes(s));
    set({
      remoteState: updated,
      visible: !allDone,
      currentStepIndex: nextIdx === -1 ? WALKTHROUGH_STEPS.length - 1 : nextIdx,
    });
  },

  skipAll: async (token: string): Promise<void> => {
    await patchRemote(token, {
      completed_steps: [...WALKTHROUGH_STEPS],
      completed_at: new Date().toISOString(),
    });
    set({ visible: false });
  },
}));
