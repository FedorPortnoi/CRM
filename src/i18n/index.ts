import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en';
import ru from './locales/ru';

export type Language = 'ru' | 'en';

export async function initI18n(lang: Language = 'ru'): Promise<void> {
  if (i18n.isInitialized) {
    await i18n.changeLanguage(lang);
    return;
  }

  await i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, ru: { translation: ru } },
    lng: lang,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    compatibilityJSON: 'v4',
  });
}

export async function changeAppLanguage(lang: Language): Promise<void> {
  const { setStoredLanguage } = await import('./storage');
  await setStoredLanguage(lang);
  await initI18n(lang);
}

export default i18n;
