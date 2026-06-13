import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { initI18n } from '../i18n';
import { getStoredLanguage, hasSelectedLanguage } from '../i18n/storage';

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
        const user = parseStoredUser(userJson);
        if (!token || !user) {
          router.replace('/login');
          return;
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
