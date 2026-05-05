import React, { useState, useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useUserStore } from '../store/userStore';

export default function RootLayout() {
  const router = useRouter();
  const { token, restoreSession } = useUserStore();
  const [isRestoring, setIsRestoring] = useState<boolean>(true);

  useEffect(() => {
    void restoreSession().finally(() => {
      setIsRestoring(false);
    });
  }, []);

  useEffect(() => {
    if (!isRestoring && token === null) {
      router.replace('/login');
    }
  }, [token, isRestoring]);

  if (isRestoring) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" />
        </View>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="register" options={{ headerShown: false }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
