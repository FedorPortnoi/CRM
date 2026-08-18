import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { initI18n } from '../i18n';
import { getStoredLanguage, hasSelectedLanguage } from '../i18n/storage';
import { API_URL } from '../utils/api';

type StoredUser = {
  onboarding_completed?: boolean;
  must_change_password?: boolean;
  must_change_email?: boolean;
};

function parseStoredUser(value: string | null): StoredUser | null {
  if (value === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as StoredUser;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// How long the boot gate waits on GET /auth/me before falling back to the
// SecureStore snapshot. Short enough that a slow or absent network never stalls
// the launch screen, long enough to beat a warm mobile round trip.
const ME_REFRESH_TIMEOUT_MS = 4000;

/**
 * Best-effort reconciliation against the server. SecureStore's cached user only
 * ever changes locally — on login, or on completing /set-password — so a
 * server-side correction to must_change_password/must_change_email (an ops fix
 * to a bad row, say) can never reach an already-installed app without this: the
 * device would otherwise keep re-showing /set-password on every cold start
 * forever, no matter how many times it's closed and reopened. Returns null on
 * any failure (offline, timeout, expired token, ...) so the caller falls back to
 * the cached snapshot exactly as it did before this existed.
 */
async function fetchFreshUser(token: string): Promise<StoredUser | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ME_REFRESH_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { data?: StoredUser };
    return body.data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export default function AppIndex() {
  useEffect(() => {
    let mounted = true;

    async function routeInitialScreen() {
      const selected = await hasSelectedLanguage();
      if (!mounted) {
        return;
      }

      if (!selected) {
        router.replace('/language-select' as never);
        return;
      }

      const lang = await getStoredLanguage();
      await initI18n(lang ?? 'ru');

      const [token, userJson] = await Promise.all([
        SecureStore.getItemAsync('crm_auth_token'),
        SecureStore.getItemAsync('crm_auth_user'),
      ]);

      if (mounted) {
        const cachedUser = parseStoredUser(userJson);
        if (!token || !cachedUser) {
          // The invite-code screen is the front door now, not the login form —
          // it auto-discovers an install-time invite (referrer/clipboard/link)
          // and falls back to its own manual-code entry with a "already have an
          // account? log in" escape hatch, so an existing user is never stuck.
          router.replace('/invite' as never);
          return;
        }

        const freshUser = await fetchFreshUser(token);
        if (!mounted) {
          return;
        }

        let user = cachedUser;
        if (freshUser !== null) {
          user = { ...cachedUser, ...freshUser };
          // Persist the reconciled copy so restoreSession() (src/store/userStore.ts)
          // and every other screen see it too, not just this one routing decision.
          await SecureStore.setItemAsync('crm_auth_user', JSON.stringify(user));
        }

        if (user.must_change_password || user.must_change_email) {
          router.replace('/set-password' as never);
          return;
        }

        router.replace((user.onboarding_completed === false ? '/onboarding' : '/(tabs)') as never);
      }
    }

    routeInitialScreen();

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <View style={styles.center}>
      <ActivityIndicator />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
});
