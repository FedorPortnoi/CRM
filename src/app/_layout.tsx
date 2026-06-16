import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
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
import NavHeader from '../components/NavHeader';
import { registerBackgroundSync } from '../utils/backgroundSync';
import { initCallCapture } from '../utils/callCapture';
import { useOnboardingStore } from '../store/onboardingStore';
import { initI18n } from '../i18n';
import '../utils/network';
import { initSentry } from '../utils/sentry';

initSentry();

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
  const pushRegistrationAttemptRef = useRef<string | null>(null);
  const callCaptureCleanupRef = useRef<(() => void) | null>(null);
  const handledNotifRef = useRef<string | null>(null);
  const lastNotificationResponse = Notifications.useLastNotificationResponse();

  useEffect(() => {
    void initI18n('ru')
      .then(() => restoreSession())
      .finally(() => setIsRestoring(false));
    void registerBackgroundSync();
  }, [restoreSession]);

  useEffect(() => {
    if (!isRestoring && token === null) {
      router.replace('/login');
    }
  }, [token, isRestoring, router]);

  useEffect(() => {
    if (!isRestoring && token !== null && user?.onboarding_completed === false) {
      router.replace('/onboarding' as never);
    }
  }, [token, user?.onboarding_completed, isRestoring, router]);

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

  useEffect(() => {
    if (!lastNotificationResponse || !token || isRestoring) return;
    const notifId = lastNotificationResponse.notification.request.identifier;
    if (handledNotifRef.current === notifId) return;
    handledNotifRef.current = notifId;

    const data = lastNotificationResponse.notification.request.content.data as Record<string, string | undefined>;

    if (data.type === 'chat:message' && data.channel) {
      router.push({
        pathname: '/chat/[channel]',
        params: { channel: data.channel, name: data.channel_name ?? 'Чат' },
      } as never);
    } else if (data.taskId) {
      router.push(`/task/${data.taskId}` as never);
    } else if (data.type === 'pending_captures') {
      router.push('/captures' as never);
    }
  }, [lastNotificationResponse, token, isRestoring, router]);

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
        <StatusBar style="light" />
        <OfflineBanner />
        <Stack
          screenOptions={{
            headerShown: true,
            header: ({ options }) => (
              <NavHeader title={options.title} headerRight={options.headerRight} />
            ),
          }}
        >
          {/* Screens that manage their own full-screen UI — no global header */}
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="register" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
          <Stack.Screen name="language-select" options={{ headerShown: false }} />
          <Stack.Screen name="set-password" options={{ headerShown: false }} />
          <Stack.Screen name="join-company" options={{ headerShown: false }} />
          <Stack.Screen name="contacts/import" options={{ headerShown: false }} />
          <Stack.Screen name="workflows/index" options={{ headerShown: false }} />
        </Stack>
        <OnboardingWalkthrough />
        <ConflictToast />
      </GestureHandlerRootView>
    </PersistQueryClientProvider>
  );
}
