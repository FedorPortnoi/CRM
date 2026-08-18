import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../utils/api';
import { clearQueue } from '../utils/offlineQueue';
import { useChatStore } from './chatStore';
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
  // IANA zone the user's reminders are scheduled in. Optional because the auth
  // endpoints have to start returning it before the client can rely on it; until
  // then useDefaultReminderTimezone() falls back to the device zone, then to
  // Europe/Moscow. A reminder set for 09:00 fires according to this, so a wrong
  // value is not cosmetic — it moves when the phone rings.
  timezone?: string;
  onboarding_completed?: boolean;
  must_change_password?: boolean;
  must_change_email?: boolean;
  stay_signed_in?: boolean;
  totp_enabled?: boolean;
};

/**
 * An account that exists on the server but has not yet proven its email address,
 * and therefore has no token and no session.
 *
 * Set by `acceptInvite` when the server answers `needs_verification`. It is the
 * only thing the invite screen has to work with between account creation and
 * `verifyOtp` — that call is what actually returns the user and the token — so
 * losing it means losing the way into a real account whose invite has already
 * been burned. Deliberately NOT persisted: a code lives ten minutes and
 * POST /auth/verify/resend issues another, so a killed app restarts the step
 * rather than resuming a stale one.
 */
type PendingVerification = {
  userId: string;
  email: string | null;
};

/**
 * A login that got the password right but needs a second factor before a
 * session is minted. Set when the endpoint answers 403 TOTP_REQUIRED — see
 * `extractTotpChallenge` below and the backend contract on
 * POST /auth/2fa/verify. Kept SEPARATE from `pendingVerification`: an unproven
 * email address and a missing TOTP code are different challenges with
 * different next screens, and conflating them would let one flow's guard
 * silently swallow the other's state.
 */
type PendingTotp = {
  userId: string;
};

type CredentialUpdateResult =
  | 'authenticated'
  | 'verification-required'
  | 'login-required';

interface UserState {
  user: AuthUser | null;
  token: string | null;
  pendingVerification: PendingVerification | null;
  pendingTotp: PendingTotp | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  acceptInvite: (input: { acceptToken: string; phone: string; email: string; password: string }) => Promise<void>;
  verifyOtp: (userId: string, code: string, channel: 'email') => Promise<void>;
  resendVerification: (userId: string, channel: 'email') => Promise<void>;
  verifyTotp: (userId: string, code: string) => Promise<void>;
  setupTotp: () => Promise<{ secret: string; qrCode: string; otpauthUrl: string }>;
  enableTotp: (code: string) => Promise<{ backupCodes: string[] }>;
  disableTotp: (password: string) => Promise<void>;
  regenerateBackupCodes: (password: string) => Promise<{ backupCodes: string[] }>;
  changePassword: (newPassword: string) => Promise<CredentialUpdateResult>;
  setCredentials: (email: string, newPassword: string) => Promise<CredentialUpdateResult>;
  setTimezone: (timezone: string) => Promise<void>;
  setStaySignedIn: (value: boolean) => Promise<void>;
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

/**
 * Recognizes the 403 ACCOUNT_NOT_VERIFIED shape login() now shares with
 * acceptInvite(): a real account, a correct password, and an address that
 * has not been proven yet. `user_id` is what turns "dead end, ask an admin to
 * re-invite you" into "reattach to /auth/verify and finish the code" — see the
 * comment on this branch in backend/api/controllers/auth.ts for why sending it
 * here is safe.
 */
function extractPendingVerification(body: unknown): PendingVerification | null {
  if (body === null || typeof body !== 'object' || !('error' in body)) return null;
  const err = (body as { error: unknown }).error;
  if (err === null || typeof err !== 'object') return null;
  const { code, user_id: userId, email } = err as Record<string, unknown>;
  if (code !== 'ACCOUNT_NOT_VERIFIED' || typeof userId !== 'string') return null;
  return { userId, email: typeof email === 'string' ? email : null };
}

/**
 * Recognizes the 403 TOTP_REQUIRED shape login() answers with when the
 * password was right and the account has 2FA enabled. `user_id` is what
 * lets /verify-totp complete the SAME login via POST /auth/2fa/verify — see
 * the backend contract's `loginChallengeShape`.
 */
function extractTotpChallenge(body: unknown): PendingTotp | null {
  if (body === null || typeof body !== 'object' || !('error' in body)) return null;
  const err = (body as { error: unknown }).error;
  if (err === null || typeof err !== 'object') return null;
  const { code, user_id: userId } = err as Record<string, unknown>;
  if (code !== 'TOTP_REQUIRED' || typeof userId !== 'string') return null;
  return { userId };
}

export const useUserStore = create<UserState>()((set) => ({
  user: null,
  token: null,
  pendingVerification: null,
  pendingTotp: null,
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
        // A real account, right password, unproven address: not a failure to
        // surface as an error banner, but the same mid-flow state acceptInvite
        // already knows how to resume from. No SecureStore write — there is no
        // session, and persisting a half-account is how a device ends up
        // believing it is signed in as somebody who never proved anything.
        const pending = extractPendingVerification(body);
        if (pending) {
          set({ pendingVerification: pending, user: null, token: null, isLoading: false });
          return;
        }
        const totpChallenge = extractTotpChallenge(body);
        if (totpChallenge) {
          set({ pendingTotp: totpChallenge, user: null, token: null, isLoading: false });
          return;
        }
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
   * Deliberately shaped like account creation rather than like `login`: no
   * account exists until this call succeeds, so there is nothing to
   * authenticate against beforehand. The role is NEVER sent — it lives on the
   * server's invite row,
   * and accepting a client-supplied role would make a forwarded link an
   * escalation primitive.
   *
   * ─── TWO RESPONSE SHAPES, ON PURPOSE ────────────────────────────────────────
   *
   * The server used to answer this call with a seven-day session on an address
   * nobody had proven. It now answers with `needs_verification` and the account
   * id, and the session is minted one screen later by `verifyOtp`, against a
   * code that only reaches the real owner of the address.
   *
   * Both shapes are handled because the ORDER OF ROLLOUT CANNOT BE GUARANTEED.
   * The account is created and the single-use invite is CONSUMED before either
   * shape is written, so a client that understands only one of them strands a
   * real person with a real account and a burned link — the failure is not a
   * retry, it is unrecoverable without an owner minting a fresh invite. Reading
   * whichever shape arrived removes the ordering from the risk entirely: an old
   * server with this build works, and this build against the new server works.
   *
   * Drop the `token` branch only once no build that can reach a pre-fix server
   * is still installed.
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
      const { data } = body as {
        data: {
          user?: AuthUser;
          token?: string;
          user_id?: string;
          email?: string | null;
          needs_verification?: boolean;
        };
      };

      // Pre-fix server: a session arrived. Keyed on the token actually being
      // present rather than on the absence of `needs_verification`, so a
      // half-written response can never be mistaken for a grant.
      if (typeof data.token === 'string' && data.user) {
        const { user, token } = data as { user: AuthUser; token: string };
        await SecureStore.setItemAsync('crm_auth_token', token);
        await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(user));
        set({ user, token, pendingVerification: null, isLoading: false });
        return;
      }

      if (typeof data.user_id === 'string') {
        // Nothing is written to SecureStore: there is no session yet, and
        // persisting a half-account is how a device ends up believing it is
        // signed in as somebody who never proved anything.
        set({
          pendingVerification: { userId: data.user_id, email: data.email ?? input.email.trim().toLowerCase() },
          user: null,
          token: null,
          isLoading: false,
        });
        return;
      }

      throw new Error('Unknown error');
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
      // This is where an invite-accepted account acquires its session — the step
      // that used to happen at accept time, before anything had been proven.
      set({ user, token, pendingVerification: null, isLoading: false });
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

  /**
   * Step two of a login that answered 403 TOTP_REQUIRED — completes the SAME
   * login POST /auth/2fa/verify was called for. `code` is either a live
   * 6-digit TOTP or an XXXX-XXXX backup code; the server tries TOTP first.
   * Shaped exactly like verifyOtp above: no JWT exists yet, so this is public,
   * and failure is reported by setting `error` on the store rather than
   * throwing — /verify-totp reads `state.error`/`state.token` back off the
   * store the same way /verify already does for verifyOtp.
   */
  verifyTotp: async (userId: string, code: string): Promise<void> => {
    set({ isLoading: true, error: null });
    try {
      const response = await fetch(`${API_URL}/auth/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, code }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(extractErrorMessage(body, response.status));
      }
      const { data } = body as { data: { user: AuthUser; token: string } };
      const { user, token } = data;
      await SecureStore.setItemAsync('crm_auth_token', token);
      await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(user));
      set({ user, token, pendingTotp: null, isLoading: false });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      set({ error: msg, isLoading: false });
    }
  },

  /**
   * Starts (or restarts) enrollment: mints a pending TOTP secret and returns it
   * both as a QR code the authenticator app scans and as plaintext for manual
   * entry. `totp_enabled` stays false server-side until enableTotp confirms a
   * live code, so calling this again before confirming just overwrites the
   * pending secret — nothing to reconcile client-side.
   */
  setupTotp: async (): Promise<{ secret: string; qrCode: string; otpauthUrl: string }> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const response = await fetch(`${API_URL}/auth/2fa/setup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(extractErrorMessage(body, response.status));

    const { data } = body as { data: { secret: string; qr_code: string; otpauth_url: string } };
    return { secret: data.secret, qrCode: data.qr_code, otpauthUrl: data.otpauth_url };
  },

  /**
   * Confirms enrollment with a live code from the app that scanned setup's QR.
   * Flips totp_enabled on the server; patches the local user the same way
   * setTimezone does, so the settings screen reflects "enabled" without a
   * refetch.
   */
  enableTotp: async (code: string): Promise<{ backupCodes: string[] }> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const response = await fetch(`${API_URL}/auth/2fa/enable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(extractErrorMessage(body, response.status));

    const { data } = body as { data: { backup_codes: string[] } };

    const userJson = await SecureStore.getItemAsync('crm_auth_user');
    if (userJson) {
      const user = JSON.parse(userJson) as AuthUser;
      const updated = { ...user, totp_enabled: true };
      await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(updated));
      set({ user: updated });
    }

    return { backupCodes: data.backup_codes };
  },

  /**
   * Turns 2FA off after re-proving the account password. Clears the secret and
   * every backup code server-side; patches the local user's totp_enabled the
   * same way setTimezone patches timezone.
   */
  disableTotp: async (password: string): Promise<void> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const response = await fetch(`${API_URL}/auth/2fa/disable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(extractErrorMessage(body, response.status));

    const userJson = await SecureStore.getItemAsync('crm_auth_user');
    if (!userJson) return;
    const user = JSON.parse(userJson) as AuthUser;
    const updated = { ...user, totp_enabled: false };
    await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(updated));
    set({ user: updated });
  },

  /**
   * Re-proves the password and mints 10 fresh backup codes, shown exactly once.
   * Only UNUSED codes are invalidated server-side — spent ones stay for audit
   * history — so this never touches totp_enabled and there is nothing to patch
   * on the local user.
   */
  regenerateBackupCodes: async (password: string): Promise<{ backupCodes: string[] }> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const response = await fetch(`${API_URL}/auth/2fa/backup-codes/regenerate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(extractErrorMessage(body, response.status));

    const { data } = body as { data: { backup_codes: string[] } };
    return { backupCodes: data.backup_codes };
  },

  changePassword: async (newPassword: string): Promise<CredentialUpdateResult> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const response = await fetch(`${API_URL}/auth/me/password`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: newPassword }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(extractErrorMessage(body, response.status));

    const { data } = body as { data: { updated: boolean; token?: unknown } };

    const userJson = await SecureStore.getItemAsync('crm_auth_user');
    let updated: AuthUser | null = null;
    if (userJson) {
      const user = JSON.parse(userJson) as AuthUser;
      updated = { ...user, must_change_password: false };
      await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(updated));
    }

    if (typeof data.token === 'string' && data.token.length > 0) {
      await SecureStore.setItemAsync('crm_auth_token', data.token);
      set({ token: data.token, ...(updated ? { user: updated } : {}) });
      return 'authenticated';
    }

    // Rollout compatibility: an older API revokes the current session but does
    // not return its replacement. Do not route into authenticated screens with
    // that dead JWT. A best-effort disk delete plus an unconditional in-memory
    // clear makes login the explicit recovery path even if SecureStore rejects.
    await bestEffort(() => SecureStore.deleteItemAsync('crm_auth_token'));
    set({ token: null, ...(updated ? { user: updated } : {}) });
    return 'login-required';
  },

  setCredentials: async (email: string, newPassword: string): Promise<CredentialUpdateResult> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const response = await fetch(`${API_URL}/auth/me/credentials`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, new_password: newPassword }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(extractErrorMessage(body, response.status));

    const { data } = body as {
      data: {
        user: AuthUser;
        token?: unknown;
        pending_verification?: { user_id: string; email: string | null };
      };
    };

    // When the server asks for the address to be proven, the session it revoked
    // is already dead: drop the stored token so restoreSession() cannot try it,
    // and hand the verify screen the same pendingVerification handle acceptInvite
    // produces. verifyOtp mints the real session one screen later.
    if (data.pending_verification) {
      await bestEffort(() => SecureStore.deleteItemAsync('crm_auth_token'));
      await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(data.user));
      set({
        user: data.user,
        token: null,
        pendingVerification: {
          userId: data.pending_verification.user_id,
          email: data.pending_verification.email,
        },
      });
      return 'verification-required';
    }

    await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(data.user));
    if (typeof data.token === 'string' && data.token.length > 0) {
      await SecureStore.setItemAsync('crm_auth_token', data.token);
      set({ user: data.user, token: data.token, pendingVerification: null });
      return 'authenticated';
    }

    // See changePassword's compatibility branch above. The credentials did
    // change successfully, so the user can immediately sign in with them; the
    // only unsafe action is pretending the revoked caller token still works.
    await bestEffort(() => SecureStore.deleteItemAsync('crm_auth_token'));
    set({ user: data.user, token: null, pendingVerification: null });
    return 'login-required';
  },

  setTimezone: async (timezone: string): Promise<void> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const response = await fetch(`${API_URL}/auth/me/timezone`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(extractErrorMessage(body, response.status));

    const userJson = await SecureStore.getItemAsync('crm_auth_user');
    if (!userJson) return;
    const user = JSON.parse(userJson) as AuthUser;
    const updated = { ...user, timezone };
    await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(updated));
    set({ user: updated });
  },

  setStaySignedIn: async (value: boolean): Promise<void> => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    const response = await fetch(`${API_URL}/auth/me/session-preference`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stay_signed_in: value }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(extractErrorMessage(body, response.status));

    const { data } = body as { data: { stay_signed_in: boolean; token?: string } };

    const userJson = await SecureStore.getItemAsync('crm_auth_user');
    const updated = userJson
      ? { ...(JSON.parse(userJson) as AuthUser), stay_signed_in: data.stay_signed_in }
      : null;
    if (updated) {
      await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(updated));
    }

    // A token comes back only when turning the toggle ON — the server re-mints
    // the current session at the long expiry right then, because a JWT cannot
    // be extended after the fact. Turning it OFF just persists the preference
    // for next login; the session already running is untouched, so there is
    // nothing new to store.
    if (data.token) {
      await SecureStore.setItemAsync('crm_auth_token', data.token);
      set({ token: data.token, ...(updated ? { user: updated } : {}) });
    } else if (updated) {
      set({ user: updated });
    }
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
      // Close the chat socket BEFORE anything else is torn down. It is
      // authenticated as the departing user and keeps pushing their
      // organisation's messages until it is closed — connect()'s `if (ws)
      // return;` guard means the next user's Chat tab visit will not replace
      // it, so nothing else in the app ever would.
      await bestEffort(async () => useChatStore.getState().disconnect());

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
