import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Check } from 'lucide-react-native';
import { initI18n, Language } from '../i18n';
import { setStoredLanguage } from '../i18n/storage';
import { useUserStore } from '../store/userStore';

export default function LanguageSelectScreen() {
  const token = useUserStore((s) => s.token);
  const user = useUserStore((s) => s.user);
  const [loading, setLoading] = useState<Language | null>(null);

  const selectLanguage = async (language: Language) => {
    setLoading(language);
    await setStoredLanguage(language);
    await initI18n(language);

    if (token) {
      router.replace((user?.onboarding_completed === false ? '/onboarding' : '/(tabs)/settings') as never);
      return;
    }

    router.replace('/login');
  };

  return (
    <View style={styles.container}>
      <View style={styles.circle1} pointerEvents="none" />
      <View style={styles.circle2} pointerEvents="none" />
      <View style={styles.circle3} pointerEvents="none" />

      <View style={styles.inner}>
        <View style={styles.logoContainer}>
          <View style={styles.logoSquare}>
            <Check size={36} color="#FFFFFF" strokeWidth={3} />
          </View>
        </View>

        <Text style={styles.title}>Welcome{'\n'}Добро пожаловать</Text>
        <Text style={styles.subtitle}>Choose your language / Выберите язык</Text>

        <View style={styles.options}>
          <Pressable
            style={({ pressed }) => [
              styles.langCard,
              pressed && styles.langCardPressed,
              loading === 'en' && styles.langCardActive,
            ]}
            onPress={() => { void selectLanguage('en'); }}
            disabled={loading !== null}
            accessibilityRole="button"
          >
            {loading === 'en' ? (
              <ActivityIndicator color="#C45A10" />
            ) : (
              <>
                <Text style={styles.langFlag}>EN</Text>
                <View style={styles.langTextBlock}>
                  <Text style={styles.langName}>English</Text>
                  <Text style={styles.langNative}>English</Text>
                </View>
                {loading === null && <View style={styles.langArrow}><Text style={styles.langArrowText}>{'>'}</Text></View>}
              </>
            )}
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.langCard,
              pressed && styles.langCardPressed,
              loading === 'ru' && styles.langCardActive,
            ]}
            onPress={() => { void selectLanguage('ru'); }}
            disabled={loading !== null}
            accessibilityRole="button"
          >
            {loading === 'ru' ? (
              <ActivityIndicator color="#C45A10" />
            ) : (
              <>
                <Text style={styles.langFlag}>RU</Text>
                <View style={styles.langTextBlock}>
                  <Text style={styles.langName}>Russian</Text>
                  <Text style={styles.langNative}>Русский</Text>
                </View>
                {loading === null && <View style={styles.langArrow}><Text style={styles.langArrowText}>{'>'}</Text></View>}
              </>
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  circle1: {
    position: 'absolute',
    width: 350,
    height: 350,
    borderRadius: 175,
    backgroundColor: 'rgba(6,95,70,0.04)',
    top: -80,
    right: -100,
  },
  circle2: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: 'rgba(6,95,70,0.03)',
    bottom: 100,
    left: -80,
  },
  circle3: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(6,95,70,0.03)',
    top: '40%',
    right: -60,
  },
  inner: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  logoContainer: {
    marginBottom: 28,
  },
  logoSquare: {
    width: 80,
    height: 80,
    borderRadius: 20,
    backgroundColor: '#C45A10',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#C45A10',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#383432',
    textAlign: 'center',
    marginBottom: 10,
    lineHeight: 34,
  },
  subtitle: {
    fontSize: 14,
    color: '#B07868',
    textAlign: 'center',
    marginBottom: 40,
    lineHeight: 20,
  },
  options: {
    width: '100%',
    maxWidth: 400,
    gap: 12,
  },
  langCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderWidth: 1.5,
    borderColor: '#E8DDD6',
    borderRadius: 16,
    padding: 18,
    gap: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  langCardPressed: {
    backgroundColor: 'rgba(6,95,70,0.04)',
    borderColor: '#C45A10',
  },
  langCardActive: {
    backgroundColor: 'rgba(6,95,70,0.06)',
    borderColor: '#C45A10',
    justifyContent: 'center',
  },
  langFlag: {
    fontSize: 24,
    fontWeight: '700',
    color: '#C45A10',
    width: 44,
  },
  langTextBlock: {
    flex: 1,
  },
  langName: {
    fontSize: 17,
    fontWeight: '600',
    color: '#383432',
  },
  langNative: {
    fontSize: 13,
    color: '#B07868',
    marginTop: 2,
  },
  langArrow: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(6,95,70,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  langArrowText: {
    fontSize: 18,
    color: '#C45A10',
    fontWeight: '600',
    lineHeight: 22,
  },
});
