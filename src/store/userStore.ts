import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../utils/api';

function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return typeof payload.exp === 'number' && payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

type AuthUser = {
  id: string;
  email: string | null;
  username?: string | null;
  name: string;
  role: string;
  org_id: string;
  onboarding_completed?: boolean;
  must_change_password?: boolean;
  must_change_email?: boolean;
};

interface UserState {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  join: (companyCode: string, username: string, password: string) => Promise<void>;
  verifyOtp: (userId: string, code: string, channel: 'sms' | 'email') => Promise<void>;
  resendVerification: (userId: string, channel: 'sms' | 'email') => Promise<void>;
  changePassword: (newPassword: string) => Promise<void>;
  setCredentials: (email: string, newPassword: string) => Promise<void>;
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

  join: async (companyCode: string, username: string, password: string): Promise<void> => {
    set({ isLoading: true, error: null });
    try {
      const response = await fetch(`${API_URL}/auth/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_code: companyCode, username, password }),
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

  verifyOtp: async (userId: string, code: string, channel: 'sms' | 'email'): Promise<void> => {
    set({ isLoading: true, error: null });
    try {
      const response = await fetch(`${API_URL}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, code, channel }),
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

  resendVerification: async (userId: string, channel: 'sms' | 'email'): Promise<void> => {
    try {
      await fetch(`${API_URL}/auth/verify/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, channel }),
      });
    } catch {
      // silent — UI shows generic "try again" message
    }
  },

  changePassword: async (newPassword: string): Promise<void> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const response = await fetch(`${API_URL}/auth/me/password`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: newPassword }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(extractErrorMessage(body, response.status));

    const userJson = await SecureStore.getItemAsync('crm_auth_user');
    if (userJson) {
      const user = JSON.parse(userJson) as AuthUser;
      const updated = { ...user, must_change_password: false };
      await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(updated));
      set({ user: updated });
    }
  },

  setCredentials: async (email: string, newPassword: string): Promise<void> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const response = await fetch(`${API_URL}/auth/me/credentials`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, new_password: newPassword }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(extractErrorMessage(body, response.status));

    const { data } = body as { data: { user: AuthUser } };
    await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(data.user));
    set({ user: data.user });
  },

  logout: async (): Promise<void> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    if (token) {
      try {
        await fetch(`${API_URL}/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // Local logout must still clear credentials if the network is unavailable.
      }
    }

    await SecureStore.deleteItemAsync('crm_auth_token');
    await SecureStore.deleteItemAsync('crm_auth_user');
    set({ user: null, token: null, error: null });
  },

  completeOnboarding: async (): Promise<void> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const userJson = await SecureStore.getItemAsync('crm_auth_user');
    if (!token || !userJson) {
      throw new Error('Cannot complete onboarding without an active session');
    }

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
        if (isTokenExpired(token)) {
          await SecureStore.deleteItemAsync('crm_auth_token');
          await SecureStore.deleteItemAsync('crm_auth_user');
          set({ user: null, token: null });
          return;
        }
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
