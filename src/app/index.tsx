import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { initI18n } from '../i18n';
import { getStoredLanguage, hasSelectedLanguage } from '../i18n/storage';

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
      if (mounted) {
        router.replace('/onboarding' as never);
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
