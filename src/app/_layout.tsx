import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, usePathname, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useUserStore } from '../store/userStore';
import { registerDevicePushToken } from '../utils/notifications';
import { queryClient, asyncStoragePersister } from '../utils/queryClient';
import OfflineBanner from '../components/OfflineBanner';
import { registerBackgroundSync } from '../utils/backgroundSync';
import { initI18n } from '../i18n';
import { getStoredLanguage, hasSelectedLanguage } from '../i18n/storage';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const { token, user, restoreSession } = useUserStore();
  const [isRestoring, setIsRestoring] = useState<boolean>(true);
  const [languageStatus, setLanguageStatus] = useState<'checking' | 'selecting' | 'ready'>('checking');
  const pushRegistrationAttemptRef = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;

    void (async () => {
      const selected = await hasSelectedLanguage();
      if (!mounted) return;

      if (!selected) {
        setLanguageStatus('selecting');
        router.replace('/language-select' as never);
        return;
      }

      const lang = await getStoredLanguage();
      await initI18n(lang ?? 'ru');
      if (mounted) {
        setLanguageStatus('ready');
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (languageStatus !== 'selecting' || pathname === '/language-select') {
      return;
    }

    let mounted = true;
    void (async () => {
      const selected = await hasSelectedLanguage();
      if (!selected) return;

      const lang = await getStoredLanguage();
      await initI18n(lang ?? 'ru');
      if (mounted) {
        setLanguageStatus('ready');
      }
    })();

    return () => {
      mounted = false;
    };
  }, [languageStatus, pathname]);

  useEffect(() => {
    void restoreSession().finally(() => {
      setIsRestoring(false);
    });
    void registerBackgroundSync();
  }, []);

  useEffect(() => {
    if (languageStatus === 'ready' && !isRestoring && token === null) {
      router.replace('/login');
    }
  }, [token, isRestoring, languageStatus]);

  useEffect(() => {
    if (languageStatus === 'ready' && !isRestoring && token !== null && user?.onboarding_completed === false) {
      router.replace('/onboarding' as never);
    }
  }, [token, user?.onboarding_completed, isRestoring, languageStatus]);

  useEffect(() => {
    if (token === null) {
      pushRegistrationAttemptRef.current = null;
      return;
    }

    if (pushRegistrationAttemptRef.current === token) return;
    pushRegistrationAttemptRef.current = token;

    void (async () => {
      try {
        const registered = await registerDevicePushToken(token);
        if (!registered && pushRegistrationAttemptRef.current === token) {
          pushRegistrationAttemptRef.current = null;
        }
      } catch {
        if (pushRegistrationAttemptRef.current === token) {
          pushRegistrationAttemptRef.current = null;
        }
      }
    })();
  }, [token]);

  if (languageStatus === 'checking' || (languageStatus === 'ready' && isRestoring)) {
    return (
      <PersistQueryClientProvider client={queryClient} persistOptions={{ persister: asyncStoragePersister }}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" />
          </View>
        </GestureHandlerRootView>
      </PersistQueryClientProvider>
    );
  }

  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister: asyncStoragePersister }}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <OfflineBanner />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="language-select" options={{ headerShown: false, gestureEnabled: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="register" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        </Stack>
      </GestureHandlerRootView>
    </PersistQueryClientProvider>
  );
}
