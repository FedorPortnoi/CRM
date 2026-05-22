import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useUserStore } from '../store/userStore';
import { registerDevicePushToken } from '../utils/notifications';
import { queryClient, asyncStoragePersister } from '../utils/queryClient';
import OfflineBanner from '../components/OfflineBanner';
import { ConflictToast } from '../components/ConflictToast';
import { OnboardingWalkthrough } from '../components/OnboardingWalkthrough';
import { registerBackgroundSync } from '../utils/backgroundSync';
import { initCallCapture } from '../utils/callCapture';
import { useOnboardingStore } from '../store/onboardingStore';
import { hasSelectedLanguage, getStoredLanguage } from '../i18n/storage';
import { initI18n } from '../i18n';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export default function RootLayout() {
  const router = useRouter();
  const { token, user, restoreSession } = useUserStore();
  const fetchOnboarding = useOnboardingStore((s) => s.fetch);
  const [isRestoring, setIsRestoring] = useState<boolean>(true);
  const [hasLanguage, setHasLanguage] = useState<boolean | undefined>(undefined);
  const pushRegistrationAttemptRef = useRef<string | null>(null);
  const callCaptureCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void Promise.all([restoreSession(), hasSelectedLanguage()])
      .then(async ([, selected]) => {
        if (selected) {
          const lang = await getStoredLanguage();
          if (lang !== null) {
            await initI18n(lang);
          }
        }
        setHasLanguage(selected);
      })
      .finally(() => {
        setIsRestoring(false);
      });
    void registerBackgroundSync();
  }, [restoreSession]);

  useEffect(() => {
    if (!isRestoring && hasLanguage === false) {
      router.replace('/language-select' as never);
    }
  }, [hasLanguage, isRestoring, router]);

  useEffect(() => {
    if (!isRestoring && hasLanguage !== false && token === null) {
      router.replace('/login');
    }
  }, [token, isRestoring, hasLanguage, router]);

  useEffect(() => {
    if (!isRestoring && hasLanguage !== false && token !== null && user?.onboarding_completed === false) {
      router.replace('/onboarding' as never);
    }
  }, [token, user?.onboarding_completed, isRestoring, hasLanguage, router]);

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

  useEffect(() => {
    if (token !== null && !isRestoring) {
      void fetchOnboarding(token);
    }
  }, [token, isRestoring, fetchOnboarding]);

  useEffect(() => {
    if (token === null) {
      callCaptureCleanupRef.current?.();
      callCaptureCleanupRef.current = null;
      return;
    }
    callCaptureCleanupRef.current = initCallCapture(() => token);
    return () => {
      callCaptureCleanupRef.current?.();
      callCaptureCleanupRef.current = null;
    };
  }, [token]);

  if (isRestoring) {
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
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="register" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
          <Stack.Screen name="language-select" options={{ headerShown: false }} />
        </Stack>
        <OnboardingWalkthrough />
        <ConflictToast />
      </GestureHandlerRootView>
    </PersistQueryClientProvider>
  );
}
