import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

import { DEFAULT_API_URL, resolveApiUrl } from '../../../src/utils/api';

describe('resolveApiUrl', () => {
  it('prefers EXPO_PUBLIC_API_URL over stale bundled Expo runtime URLs', () => {
    expect(
      resolveApiUrl({
        envApiUrl: ' https://fresh.example.com/api/v1/// ',
        expoApiUrl: 'https://stale.example.com/api/v1',
        expoApiUrls: {
          production: 'https://also-stale.example.com/api/v1',
        },
        appEnv: 'production',
      }),
    ).toBe('https://fresh.example.com/api/v1');
  });

  it('falls back to the app environment entry from Expo apiUrls', () => {
    expect(
      resolveApiUrl({
        expoApiUrls: {
          development: 'http://dev.example.com/api/v1',
          staging: 'https://staging.example.com/api/v1/',
        },
        appEnv: 'staging',
      }),
    ).toBe('https://staging.example.com/api/v1');
  });

  it('uses the Expo development URL when a non-production app environment is missing', () => {
    expect(
      resolveApiUrl({
        expoApiUrls: {
          development: 'http://dev.example.com/api/v1/',
        },
        appEnv: 'qa',
      }),
    ).toBe('http://dev.example.com/api/v1');
  });

  it('uses EXPO_PUBLIC_API_URL when Expo config does not provide a usable URL', () => {
    expect(
      resolveApiUrl({
        expoApiUrl: '   ',
        expoApiUrls: {
          development: '',
        },
        appEnv: 'development',
        envApiUrl: ' http://localhost:3000/api/v1/ ',
      }),
    ).toBe('http://localhost:3000/api/v1');
  });

  it('ignores malformed and unsupported URL values before falling back', () => {
    expect(
      resolveApiUrl({
        expoApiUrl: 'not a url',
        expoApiUrls: {
          development: 'ftp://example.com/api/v1',
        },
        appEnv: 'development',
        envApiUrl: 'https://api.example.com/api/v1',
      }),
    ).toBe('https://api.example.com/api/v1');
  });

  it('does not fall back to development or default URLs in production', () => {
    expect(() =>
      resolveApiUrl({
        expoApiUrls: {
          development: 'http://localhost:3000/api/v1',
        },
        appEnv: 'production',
      }),
    ).toThrow(/Production API URL is not configured/);

    expect(() =>
      resolveApiUrl({
        nodeEnv: 'production',
      }),
    ).toThrow(/Production API URL is not configured/);
  });

  it('rejects localhost and placeholder URLs in production', () => {
    expect(() =>
      resolveApiUrl({
        appEnv: 'production',
        envApiUrl: 'http://localhost:3000/api/v1',
      }),
    ).toThrow(/must point to a deployed API/);

    expect(() =>
      resolveApiUrl({
        appEnv: 'production',
        expoApiUrl: 'https://api.railway.app/api/v1',
      }),
    ).toThrow(/must point to a deployed API/);
  });

  it('uses the default URL when no runtime source is available', () => {
    expect(resolveApiUrl()).toBe(DEFAULT_API_URL);
  });
});
