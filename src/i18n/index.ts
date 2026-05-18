import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en';
import ru from './locales/ru';

// Initialize synchronously on import so useTranslation() always has an
// instance — even before _layout.tsx's useEffect fires. initImmediate: false
// makes i18next skip the setTimeout and complete in the same JS tick.
// Language is overridden to the stored preference by initI18n() in _layout.tsx.
i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ru: { translation: ru } },
  lng: 'ru',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  compatibilityJSON: 'v4',
  initImmediate: false,
});

export type Language = 'ru' | 'en';

export async function initI18n(lang: Language = 'ru'): Promise<void> {
  await i18n.changeLanguage(lang);
}

export async function changeAppLanguage(lang: Language): Promise<void> {
  const { setStoredLanguage } = await import('./storage');
  await setStoredLanguage(lang);
  await initI18n(lang);
}

export default i18n;
