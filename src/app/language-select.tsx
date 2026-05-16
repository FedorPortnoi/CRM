import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { initI18n, Language } from '../i18n';
import { setStoredLanguage } from '../i18n/storage';

export default function LanguageSelectScreen() {
  const [loading, setLoading] = useState<Language | null>(null);

  const selectLanguage = async (language: Language) => {
    setLoading(language);
    await setStoredLanguage(language);
    await initI18n(language);
    router.replace('/(tabs)');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Choose your language / Выберите язык</Text>
      <Pressable
        style={[styles.button, styles.englishButton]}
        onPress={() => { void selectLanguage('en'); }}
        disabled={loading !== null}
        accessibilityRole="button"
      >
        {loading === 'en' ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.buttonText}>  English</Text>}
      </Pressable>
      <Pressable
        style={[styles.button, styles.russianButton]}
        onPress={() => { void selectLanguage('ru'); }}
        disabled={loading !== null}
        accessibilityRole="button"
      >
        {loading === 'ru' ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.buttonText}>  Русский</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: '#111111',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 48,
    textAlign: 'center',
  },
  button: {
    alignItems: 'center',
    borderRadius: 12,
    justifyContent: 'center',
    marginBottom: 16,
    minHeight: 80,
    width: '100%',
    maxWidth: 360,
  },
  englishButton: {
    backgroundColor: '#2563eb',
  },
  russianButton: {
    backgroundColor: '#dc2626',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
  },
});
