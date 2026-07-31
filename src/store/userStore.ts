import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../utils/api';
import { clearQueue } from '../utils/offlineQueue';
import { queryClient } from '../utils/queryClient';

// Mirrors LAST_SYNC_KEY in src/utils/backgroundSync.ts. It is duplicated rather than imported
// because importing that module runs TaskManager.defineTask() as an import side effect, which
// must not happen just because somebody signed out.
const LAST_SYNC_KEY = 'crm-last-sync-at';

// Runs one best-effort storage step. SecureStore and AsyncStorage are native modules: they can
// reject (locked keychain, corrupt keystore, a Keychain error surfaced as a rejection) and they
// can throw before they ever return a promise, which a trailing `.catch()` does not cover.
// logout() uses this on every step so that one failure cannot skip the steps behind it.
async function bestEffort<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}

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
  acceptInvite: (input: { acceptToken: string; phone: string; email: string; password: string }) => Promise<void>;
  verifyOtp: (userId: string, code: string, channel: 'email') => Promise<void>;
  resendVerification: (userId: string, channel: 'email') => Promise<void>;
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

  /**
   * Redeem an invite: the invitee supplies their own phone, email and password,
   * and the account is created at the role the owner bound at mint time.
   *
   * Deliberately shaped like `join` rather than like `login`: no account exists
   * until this call succeeds, so there is nothing to authenticate against
   * beforehand. The role is NEVER sent — it lives on the server's invite row,
   * and accepting a client-supplied role would make a forwarded link an
   * escalation primitive.
   */
  acceptInvite: async (input: {
    acceptToken: string;
    phone: string;
    email: string;
    password: string;
  }): Promise<void> => {
    set({ isLoading: true, error: null });
    try {
      const response = await fetch(`${API_URL}/auth/invites/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accept_token: input.acceptToken,
          phone: input.phone.trim(),
          email: input.email.trim().toLowerCase(),
          password: input.password,
        }),
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

  verifyOtp: async (userId: string, code: string, channel: 'email'): Promise<void> => {
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

  resendVerification: async (userId: string, channel: 'email'): Promise<void> => {
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
    // EVERY step below is wrapped, including the SecureStore ones, and the whole body sits in a
    // try/finally whose `finally` clears the store. That is not defensive padding: the three
    // bare SecureStore awaits this replaced were the hole. A rejection on the second delete
    // skipped the queue purge, the cache clear, the watermark reset and the set() itself, so
    // logout() threw with `user` and `token` still populated and the previous account's PII
    // still queued — precisely the half-logged-out state the notes below say cannot happen.
    // Each step is independent, so each failure is contained to its own step.
    try {
      const token = await bestEffort(() => SecureStore.getItemAsync('crm_auth_token'));
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

      await bestEffort(() => SecureStore.deleteItemAsync('crm_auth_token'));
      await bestEffort(() => SecureStore.deleteItemAsync('crm_auth_user'));

      // Credentials alone are not the session. Three things outlive them, all of them scoped to
      // the account that just left, and all of them visible to whoever signs in next on this
      // device — a shared phone is the normal case for this product, not an edge case.
      //
      // Ordering: credentials go first because that is the step that must never be skipped.
      //
      // 1. The offline queue. flush() re-reads the bearer token at send time, so a queue left
      //    behind by user A is replayed under user B's token, into B's org, from a background
      //    task with no UI. clearQueue() also deletes the per-item SecureStore bodies, which are
      //    keyed separately and would otherwise be unreachable garbage holding A's payloads.
      //    flush() additionally refuses to send items stamped with a different owner, which is
      //    what covers a logout interrupted before this line runs.
      await bestEffort(() => clearQueue());

      // 2. The in-memory react-query cache. The persisted half already excludes PII collections
      //    (see queryClient.ts), but the live cache still holds A's contacts, deals and reports
      //    and would render them to B for as long as it takes the first refetch to land.
      try {
        queryClient.clear();
      } catch {
        // Never let a cache failure keep the user signed in.
      }

      // 3. The delta-sync watermark. It is device-global, so B's first delta sync would ask the
      //    server for "everything since A last synced" and permanently skip every record that
      //    changed before that moment — a silent, unrecoverable gap in B's data.
      await bestEffort(() => AsyncStorage.removeItem(LAST_SYNC_KEY));
    } finally {
      // The one step with no storage behind it, and therefore the one step that can always be
      // completed. Signing the user out of the UI is never conditional on the device's storage
      // cooperating.
      set({ user: null, token: null, error: null });
    }
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
