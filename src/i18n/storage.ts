import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Language } from './index';

const LANG_KEY = 'app_language';
const SEL_KEY = 'language_selected';

export const getStoredLanguage = async (): Promise<Language | null> => {
  const lang = await AsyncStorage.getItem(LANG_KEY);
  return lang === 'ru' || lang === 'en' ? lang : null;
};

export const setStoredLanguage = async (lang: Language): Promise<void> => {
  await AsyncStorage.setItem(LANG_KEY, lang);
  await AsyncStorage.setItem(SEL_KEY, 'true');
};

export const hasSelectedLanguage = async (): Promise<boolean> => (
  (await AsyncStorage.getItem(SEL_KEY)) === 'true'
);

export type AppLanguage = Language;
