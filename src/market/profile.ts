export type MarketCode = 'RU' | 'US';

export type MarketProfile = {
  code: MarketCode;
  primaryLanguage: string;
  fallbackLanguage: string;
  locale: string;
  timeZone: string;
  currency: string;
  countryCallingCode: string;
  phoneNationalPrefixes: readonly string[];
  companyIdentifiers: readonly string[];
};

export type MoneyFormatOptions = {
  empty?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
};

export const RUSSIA_MARKET_PROFILE = {
  code: 'RU',
  primaryLanguage: 'ru',
  fallbackLanguage: 'en',
  locale: 'ru-RU',
  timeZone: 'Europe/Moscow',
  currency: 'RUB',
  countryCallingCode: '+7',
  phoneNationalPrefixes: ['8'],
  companyIdentifiers: ['inn', 'kpp', 'ogrn'],
} as const satisfies MarketProfile;

export const US_MARKET_PROFILE = {
  code: 'US',
  primaryLanguage: 'en',
  fallbackLanguage: 'en',
  locale: 'en-US',
  timeZone: 'America/New_York',
  currency: 'USD',
  countryCallingCode: '+1',
  phoneNationalPrefixes: ['1'],
  companyIdentifiers: ['ein', 'dba'],
} as const satisfies MarketProfile;

const MARKET_PROFILES: Record<MarketCode, MarketProfile> = {
  RU: RUSSIA_MARKET_PROFILE,
  US: US_MARKET_PROFILE,
};

export function getMarketProfile(code: MarketCode): MarketProfile {
  return MARKET_PROFILES[code];
}

function resolveActiveMarketProfile(): MarketProfile {
  // EXPO_PUBLIC_* vars are inlined at bundle time by Expo Metro
  const code = (process.env.EXPO_PUBLIC_MARKET_CODE ?? '').trim().toUpperCase();
  return code in MARKET_PROFILES ? MARKET_PROFILES[code as MarketCode] : RUSSIA_MARKET_PROFILE;
}

export const DEFAULT_MARKET_PROFILE: MarketProfile = resolveActiveMarketProfile();

export function normalizeMarketCurrency(value: string | null | undefined): string {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^[A-Z]{3}$/.test(normalized)
    ? normalized
    : DEFAULT_MARKET_PROFILE.currency;
}

export function formatMoney(
  value: number | string | null | undefined,
  currency?: string | null,
  options: MoneyFormatOptions = {},
): string {
  if (value === null || value === undefined || value === '') {
    return options.empty ?? '--';
  }

  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) {
    return options.empty ?? '--';
  }

  const normalizedCurrency = normalizeMarketCurrency(currency);
  const minimumFractionDigits = options.minimumFractionDigits ?? 0;
  const maximumFractionDigits =
    options.maximumFractionDigits ?? (Number.isInteger(amount) ? 0 : 2);

  try {
    return new Intl.NumberFormat(DEFAULT_MARKET_PROFILE.locale, {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits,
      maximumFractionDigits,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString(DEFAULT_MARKET_PROFILE.locale, {
      minimumFractionDigits,
      maximumFractionDigits,
    })} ${normalizedCurrency}`;
  }
}

function parseMarketDate(value: string | Date | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatMarketNumber(
  value: number,
  options: Intl.NumberFormatOptions = {},
): string {
  return value.toLocaleString(DEFAULT_MARKET_PROFILE.locale, options);
}

export function formatMarketDate(
  value: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' },
): string {
  const date = parseMarketDate(value);
  return date ? date.toLocaleDateString(DEFAULT_MARKET_PROFILE.locale, options) : '';
}

export function formatMarketDateTime(
  value: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  },
): string {
  const date = parseMarketDate(value);
  return date ? date.toLocaleString(DEFAULT_MARKET_PROFILE.locale, options) : '';
}

export function formatMarketTime(
  value: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' },
): string {
  const date = parseMarketDate(value);
  return date ? date.toLocaleTimeString(DEFAULT_MARKET_PROFILE.locale, options) : '';
}
