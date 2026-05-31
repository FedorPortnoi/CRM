export type MarketCode = 'RU' | 'US';

export type PaymentProviderId =
  | 'sbp'
  | 'mir_acquiring'
  | 'bank_invoice'
  | 'stripe'
  | 'ach_transfer';

export type ExternalIntegrationId =
  | 'sms_ru'
  | 'yandex_calendar'
  | 'yandex_vision'
  | 'yandex_speechkit'
  | 'yandex_object_storage'
  | 'one_c'
  | 'twilio'
  | 'google_calendar'
  | 'google_vision'
  | 'openai_whisper'
  | 'aws_s3';

export type ComplianceCapability =
  | 'personal_data_localization'
  | 'operator_notification'
  | 'audit_events'
  | 'consent_tracking'
  | 'cross_border_transfer_review'
  | 'ccpa_consumer_rights'
  | 'soc2_audit_log';

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
  paymentProviders: readonly PaymentProviderId[];
  integrations: readonly ExternalIntegrationId[];
  compliance: readonly ComplianceCapability[];
  dataResidency: {
    personalDataRegion: string;
    crossBorderTransfer: 'restricted' | 'allowed';
  };
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
  paymentProviders: ['sbp', 'mir_acquiring', 'bank_invoice'],
  integrations: ['sms_ru', 'yandex_calendar', 'yandex_vision', 'yandex_speechkit', 'yandex_object_storage', 'one_c'],
  compliance: [
    'personal_data_localization',
    'operator_notification',
    'audit_events',
    'consent_tracking',
    'cross_border_transfer_review',
  ],
  dataResidency: {
    personalDataRegion: 'RU',
    crossBorderTransfer: 'restricted',
  },
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
  paymentProviders: ['stripe', 'ach_transfer'],
  integrations: ['twilio', 'google_calendar', 'google_vision', 'openai_whisper', 'aws_s3'],
  compliance: ['audit_events', 'ccpa_consumer_rights', 'soc2_audit_log'],
  dataResidency: {
    personalDataRegion: 'US',
    crossBorderTransfer: 'allowed',
  },
} as const satisfies MarketProfile;

const MARKET_PROFILES: Record<MarketCode, MarketProfile> = {
  RU: RUSSIA_MARKET_PROFILE,
  US: US_MARKET_PROFILE,
};

export function getMarketProfile(code: MarketCode): MarketProfile {
  return MARKET_PROFILES[code];
}

function resolveActiveMarketProfile(): MarketProfile {
  const code = (process.env.MARKET_CODE ?? '').trim().toUpperCase();
  return code in MARKET_PROFILES ? MARKET_PROFILES[code as MarketCode] : RUSSIA_MARKET_PROFILE;
}

export const DEFAULT_MARKET_PROFILE: MarketProfile = resolveActiveMarketProfile();

export function normalizeCurrencyCode(value: string): string {
  return value.trim().toUpperCase();
}
