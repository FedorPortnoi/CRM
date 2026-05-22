import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../utils/api';

type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  org_id: string;
  onboarding_completed?: boolean;
};

interface UserState {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    name: string,
    orgName: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  restoreSession: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
}

function extractErrorMessage(body: unknown, status: number): string {
  if (body !== null && typeof body === 'object') {
    // Branch 1: custom envelope { error: { message: string } }
    if (
      'error' in body &&
      body.error !== null &&
      typeof body.error === 'object' &&
      'message' in body.error &&
      typeof (body.error as Record<string, unknown>).message === 'string'
    ) {
      return (body.error as Record<string, unknown>).message as string;
    }
    // Branch 2: Fastify/Zod top-level { message: string }
    if ('message' in body && typeof (body as Record<string, unknown>).message === 'string') {
      return (body as Record<string, unknown>).message as string;
    }
  }
  return `Request failed with status ${status}`;
}

export const useUserStore = create<UserState>()((set) => ({
  user: null,
  token: null,
  isLoading: false,
  error: null,

  login: async (email: string, password: string): Promise<void> => {
    set({ isLoading: true, error: null });
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(extractErrorMessage(body, response.status));
      }
      const { data } = body as { data: { user: AuthUser; token: string } };
      const { user, token } = data;
      await SecureStore.setItemAsync('crm_auth_token', token);
      await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(user));
      set({ user, token, isLoading: false });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      set({ error: msg, isLoading: false });
    }
  },

  register: async (
    email: string,
    password: string,
    name: string,
    orgName: string,
  ): Promise<void> => {
    set({ isLoading: true, error: null });
    try {
      const response = await fetch(`${API_URL}/auth/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name, org_name: orgName }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(extractErrorMessage(body, response.status));
      }
      const { data } = body as { data: { user: AuthUser; token: string } };
      const { user, token } = data;
      await SecureStore.setItemAsync('crm_auth_token', token);
      await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(user));
      set({ user, token, isLoading: false });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      set({ error: msg, isLoading: false });
    }
  },

  logout: async (): Promise<void> => {
    await SecureStore.deleteItemAsync('crm_auth_token');
    await SecureStore.deleteItemAsync('crm_auth_user');
    set({ user: null, token: null, error: null });
  },

  completeOnboarding: async (): Promise<void> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const userJson = await SecureStore.getItemAsync('crm_auth_user');
    if (!token || !userJson) return;

    const response = await fetch(`${API_URL}/onboarding`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        completed_steps: ['contacts', 'deals', 'tasks', 'calendar'],
        completed_at: new Date().toISOString(),
      }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new Error(extractErrorMessage(body, response.status));
    }

    const currentUser = JSON.parse(userJson) as AuthUser;
    const nextUser = { ...currentUser, onboarding_completed: true };
    await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(nextUser));
    set({ user: nextUser });
  },

  restoreSession: async (): Promise<void> => {
    try {
      const token = await SecureStore.getItemAsync('crm_auth_token');
      const userJson = await SecureStore.getItemAsync('crm_auth_user');
      if (token !== null && userJson !== null) {
        const user = JSON.parse(userJson) as AuthUser;
        set({ user, token });
      } else {
        await SecureStore.deleteItemAsync('crm_auth_token');
        await SecureStore.deleteItemAsync('crm_auth_user');
        set({ user: null, token: null });
      }
    } catch (e: unknown) {
      await SecureStore.deleteItemAsync('crm_auth_token');
      await SecureStore.deleteItemAsync('crm_auth_user');
      set({ user: null, token: null });
    }
  },
}));
