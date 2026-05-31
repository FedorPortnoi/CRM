import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKET_PROFILE,
  RUSSIA_MARKET_PROFILE,
  US_MARKET_PROFILE,
  formatMarketDate,
  formatMarketDateTime,
  formatMarketNumber,
  formatMarketTime,
  formatMoney,
  getMarketProfile,
  normalizeMarketCurrency,
} from '../../../src/market/profile';

describe('market profile', () => {
  it('uses Russia as the default market profile', () => {
    expect(DEFAULT_MARKET_PROFILE).toMatchObject({
      code: 'RU',
      locale: 'ru-RU',
      currency: 'RUB',
      countryCallingCode: '+7',
    });
  });

  it('normalizes missing and lowercase currency codes to the market default', () => {
    expect(normalizeMarketCurrency(undefined)).toBe('RUB');
    expect(normalizeMarketCurrency('rub')).toBe('RUB');
  });

  it('formats money without falling back to US dollar display', () => {
    const formatted = formatMoney(1234, 'RUB');

    expect(formatted).toMatch(/1.*234/);
    expect(formatted).not.toContain('$');
  });

  it('returns the configured empty marker for missing money values', () => {
    expect(formatMoney(null, undefined, { empty: 'empty' })).toBe('empty');
  });

  it('formats dates with the market locale', () => {
    expect(formatMarketDate('2026-05-23', { year: 'numeric' })).toMatch(/2026/);
  });

  it('formats date-time, time, and number values through the market locale', () => {
    expect(formatMarketDateTime('2026-05-23T12:30:00Z')).not.toBe('');
    expect(formatMarketTime('2026-05-23T12:30:00Z')).not.toBe('');
    expect(formatMarketNumber(12.5, { maximumFractionDigits: 1 })).toMatch(/12/);
  });
});

describe('RUSSIA_MARKET_PROFILE', () => {
  it('has correct Russia identifiers', () => {
    expect(RUSSIA_MARKET_PROFILE.code).toBe('RU');
    expect(RUSSIA_MARKET_PROFILE.locale).toBe('ru-RU');
    expect(RUSSIA_MARKET_PROFILE.currency).toBe('RUB');
    expect(RUSSIA_MARKET_PROFILE.countryCallingCode).toBe('+7');
    expect(RUSSIA_MARKET_PROFILE.timeZone).toBe('Europe/Moscow');
  });

  it('includes Russian company identifiers', () => {
    expect(RUSSIA_MARKET_PROFILE.companyIdentifiers).toContain('inn');
    expect(RUSSIA_MARKET_PROFILE.companyIdentifiers).toContain('kpp');
    expect(RUSSIA_MARKET_PROFILE.companyIdentifiers).toContain('ogrn');
  });
});

describe('US_MARKET_PROFILE', () => {
  it('has correct US identifiers', () => {
    expect(US_MARKET_PROFILE.code).toBe('US');
    expect(US_MARKET_PROFILE.locale).toBe('en-US');
    expect(US_MARKET_PROFILE.currency).toBe('USD');
    expect(US_MARKET_PROFILE.countryCallingCode).toBe('+1');
    expect(US_MARKET_PROFILE.timeZone).toBe('America/New_York');
  });

  it('includes US company identifiers', () => {
    expect(US_MARKET_PROFILE.companyIdentifiers).toContain('ein');
    expect(US_MARKET_PROFILE.companyIdentifiers).toContain('dba');
  });

  it('formats USD money correctly using en-US locale', () => {
    const formatted = new Intl.NumberFormat(US_MARKET_PROFILE.locale, {
      style: 'currency',
      currency: US_MARKET_PROFILE.currency,
    }).format(1234);

    expect(formatted).toContain('$');
    expect(formatted).toMatch(/1,234/);
  });

  it('does not use Russian locale or currency', () => {
    expect(US_MARKET_PROFILE.locale).not.toBe('ru-RU');
    expect(US_MARKET_PROFILE.currency).not.toBe('RUB');
    expect(US_MARKET_PROFILE.countryCallingCode).not.toBe('+7');
  });
});

describe('getMarketProfile', () => {
  it('returns RUSSIA_MARKET_PROFILE for RU', () => {
    expect(getMarketProfile('RU')).toBe(RUSSIA_MARKET_PROFILE);
  });

  it('returns US_MARKET_PROFILE for US', () => {
    expect(getMarketProfile('US')).toBe(US_MARKET_PROFILE);
  });

  it('both profiles satisfy the MarketProfile shape', () => {
    const required = ['code', 'locale', 'currency', 'countryCallingCode', 'timeZone', 'companyIdentifiers'];
    for (const key of required) {
      expect(getMarketProfile('RU')).toHaveProperty(key);
      expect(getMarketProfile('US')).toHaveProperty(key);
    }
  });
});
