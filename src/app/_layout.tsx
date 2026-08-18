import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Stack, useRouter, usePathname } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useUserStore } from '../store/userStore';
import {
  cleanupLegacyTaskDueReminders,
  getInitialRuStoreNotification,
  registerDevicePushToken,
  subscribeToRuStoreOpenedNotifications,
  subscribeToRuStorePushTokenRefresh,
} from '../utils/notifications';
import { queryClient, persistOptions } from '../utils/queryClient';
import SyncStatusBar from '../components/SyncStatusBar';
import AnimatedSplash from '../components/AnimatedSplash';
import { ConflictToast } from '../components/ConflictToast';
import { OnboardingWalkthrough } from '../components/OnboardingWalkthrough';
import NavHeader from '../components/NavHeader';
import { registerBackgroundSync } from '../utils/backgroundSync';
import { initCallCapture } from '../utils/callCapture';
import { useOnboardingStore } from '../store/onboardingStore';
import { initI18n } from '../i18n';
import '../utils/network';
import { initSentry } from '../utils/sentry';
import Constants from 'expo-constants';
import { API_URL } from '../utils/api';
import { isUnauthenticatedRoute } from '../utils/authRoutes';

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
  const pathname = usePathname();
  const { token, user, restoreSession } = useUserStore();
  const fetchOnboarding = useOnboardingStore((s) => s.fetch);
  const [isRestoring, setIsRestoring] = useState<boolean>(true);
  const [splashDone, setSplashDone] = useState<boolean>(false);
  const pushRegistrationAttemptRef = useRef<string | null>(null);
  const callCaptureCleanupRef = useRef<(() => void) | null>(null);
  const handledNotifRef = useRef<string | null>(null);
  const lastNotificationResponse = Notifications.useLastNotificationResponse();

  const routeNotificationData = useCallback(
    (data: Record<string, string | undefined>, notificationId: string) => {
      if (handledNotifRef.current === notificationId) return;
      handledNotifRef.current = notificationId;

      if (data.type === 'chat:message' && data.channel) {
        router.push({
          pathname: '/chat/[channel]',
          params: { channel: data.channel, name: data.channel_name ?? 'Чат' },
        } as never);
        return;
      }

      const taskId = data.taskId ?? data.task_id ?? (data.entityType === 'task' ? data.entityId : undefined);
      if (taskId) {
        router.push(`/task/${taskId}` as never);
      } else if (data.type === 'pending_captures') {
        router.push('/captures' as never);
      }
    },
    [router],
  );

  useEffect(() => {
    void initI18n('ru')
      .then(() => restoreSession())
      .finally(() => setIsRestoring(false));
    void registerBackgroundSync();
    void cleanupLegacyTaskDueReminders();

    const currentVersionCode = Constants.expoConfig?.android?.versionCode ?? 0;
    fetch(`${API_URL.replace('/api/v1', '')}/version`)
      .then((r) => r.json())
      .then((body: { versionCode?: number }) => {
        if (typeof body.versionCode === 'number' && body.versionCode > currentVersionCode) {
          Alert.alert(
            'Доступна новая версия',
            `Выйдите и скачайте новую версию 4КУБ для получения обновлений.`,
            [{ text: 'OK' }],
          );
        }
      })
      .catch(() => {});
  }, [restoreSession]);

  /**
   * Routes an unauthenticated user may legitimately be on.
   *
   * WITHOUT this exemption the invite flow is unreachable on a cold start, and
   * silently so. An invitee has `token === null` by definition — that is the
   * whole point of an invite — so the redirect below fires on them. On a warm
   * link the redirect has already run and its deps never change again, which is
   * why hand-testing a running app shows the invite screen working perfectly;
   * on a COLD start from the link, React runs child effects before parent ones,
   * so InviteScreen mounts, starts a lookup that mints an accept token — and is
   * then thrown away by this redirect. The accept token is stranded, and the
   * invitee lands on a login screen for an account that does not exist.
   */
  useEffect(() => {
    if (isRestoring || token !== null) return;
    if (isUnauthenticatedRoute(pathname)) return;
    router.replace('/login');
  }, [token, isRestoring, router, pathname]);

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

  // RuStore can rotate a device token after the initial session registration. The SDK does
  // not upload the replacement itself; without this session-long listener the old row stays
  // on the server and the phone silently stops receiving reminders.
  useEffect(() => {
    if (!token) return undefined;
    return subscribeToRuStorePushTokenRefresh(() => token);
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
    const data = lastNotificationResponse.notification.request.content.data as Record<string, string | undefined>;
    routeNotificationData(data, notifId);
  }, [lastNotificationResponse, token, isRestoring, routeNotificationData]);

  // Expo owns APNs/FCM tap responses; RuStore owns its Android tray responses. Both feed the
  // same router and dedupe key so a warm-open event racing the cold-start lookup navigates once.
  useEffect(() => {
    if (!token || isRestoring) return undefined;
    let active = true;
    void getInitialRuStoreNotification().then((message) => {
      if (!active || !message) return;
      const id = message.messageId ?? `rustore:${JSON.stringify(message.data ?? {})}`;
      routeNotificationData(message.data ?? {}, id);
    });
    const unsubscribe = subscribeToRuStoreOpenedNotifications((message) => {
      const id = message.messageId ?? `rustore:${JSON.stringify(message.data ?? {})}`;
      routeNotificationData(message.data ?? {}, id);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [token, isRestoring, routeNotificationData]);

  if (isRestoring) {
    return (
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          {/* Dark, not a white spinner: the animated splash overlays this
              branch, and the backdrop must match its #0A0A0A so a slow video
              first-frame can never flash white. The spinner stays as the
              no-video fallback underneath. */}
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0A0A0A' }}>
            <ActivityIndicator size="large" color="#CC785C" />
          </View>
          {/* key must match the main branch so React keeps ONE splash instance
              (and one playing video) across the isRestoring branch switch. */}
          <AnimatedSplash key="animated-splash" ready={false} onFinish={() => setSplashDone(true)} />
        </GestureHandlerRootView>
      </PersistQueryClientProvider>
    );
  }

  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <StatusBar style="light" />
        <SyncStatusBar />
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
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
          <Stack.Screen name="language-select" options={{ headerShown: false }} />
          <Stack.Screen name="set-password" options={{ headerShown: false }} />
          <Stack.Screen name="workflows/index" options={{ headerShown: false }} />
        </Stack>
        <OnboardingWalkthrough />
        <ConflictToast />
        {!splashDone && (
          <AnimatedSplash
            key="animated-splash"
            // `/` still has asynchronous boot routing to do (language,
            // SecureStore, and a bounded /auth/me refresh). Keep the animated
            // layer over it until AppIndex has selected the real destination.
            ready={pathname !== '/'}
            onFinish={() => setSplashDone(true)}
          />
        )}
      </GestureHandlerRootView>
    </PersistQueryClientProvider>
  );
}
