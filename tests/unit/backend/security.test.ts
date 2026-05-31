import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  getCorsOrigin,
  getDeploymentSafeUrl,
  getJwtSecret,
  getRequiredSecret,
  getTokenEncryptionSecret,
  getYandexWebhookSecret,
  validateProductionConfig,
} from '../../../backend/config/security';

const jwtSecret = 'j'.repeat(32);
const tokenEncryptionKey = 't'.repeat(32);
const webhookSecret = 'w'.repeat(32);

function validProductionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    JWT_SECRET: jwtSecret,
    TOKEN_ENCRYPTION_KEY: tokenEncryptionKey,
    YANDEX_WEBHOOK_SECRET: webhookSecret,
    CRM_CORS_ORIGINS: 'https://app.example.com',
    DATABASE_URL: 'postgresql://crm_user:StrongDbPass123!@db.example.com:5432/crm_db',
  };

  return { ...env, ...overrides } as NodeJS.ProcessEnv;
}

describe('backend security config', () => {
  it('requires JWT_SECRET to be present', () => {
    expect(() => getJwtSecret({} as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
  });

  it('rejects weak or too-short JWT secrets', () => {
    expect(() => getJwtSecret({ JWT_SECRET: 'secret' } as unknown as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
    expect(() => getJwtSecret({ JWT_SECRET: 'x'.repeat(31) } as unknown as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
  });

  it('accepts a strong required secret', () => {
    const secret = 'a'.repeat(32);
    expect(getRequiredSecret('JWT_SECRET', {}, { JWT_SECRET: secret } as unknown as NodeJS.ProcessEnv)).toBe(secret);
  });

  it('requires a separate token encryption key in production', () => {
    expect(getTokenEncryptionSecret({
      NODE_ENV: 'development',
      JWT_SECRET: jwtSecret,
    } as NodeJS.ProcessEnv)).toBe(jwtSecret);

    expect(() => getTokenEncryptionSecret({
      NODE_ENV: 'production',
      JWT_SECRET: jwtSecret,
    } as NodeJS.ProcessEnv)).toThrow(ConfigurationError);

    expect(() => getTokenEncryptionSecret({
      NODE_ENV: 'production',
      JWT_SECRET: jwtSecret,
      TOKEN_ENCRYPTION_KEY: jwtSecret,
    } as NodeJS.ProcessEnv)).toThrow(ConfigurationError);

    expect(getTokenEncryptionSecret(validProductionEnv())).toBe(tokenEncryptionKey);
  });

  it('requires a strong Yandex webhook secret in production', () => {
    expect(getYandexWebhookSecret({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(() => getYandexWebhookSecret({
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
    expect(getYandexWebhookSecret(validProductionEnv())).toBe(webhookSecret);
  });

  it('uses practical local CORS defaults outside production', () => {
    expect(getCorsOrigin({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('requires an explicit production CORS allowlist', () => {
    expect(() => getCorsOrigin({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(ConfigurationError);

    expect(getCorsOrigin({
      NODE_ENV: 'production',
      CRM_CORS_ORIGINS: 'https://app.example.com, https://admin.example.com',
    } as NodeJS.ProcessEnv)).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it('validates deployment URLs before using them for redirects', () => {
    expect(getDeploymentSafeUrl('CALLBACK_URL', {}, { NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(() => getDeploymentSafeUrl(
      'CALLBACK_URL',
      {},
      { CALLBACK_URL: 'not a url' } as unknown as NodeJS.ProcessEnv,
    )).toThrow(ConfigurationError);

    expect(getDeploymentSafeUrl(
      'CALLBACK_URL',
      {},
      { NODE_ENV: 'production', CALLBACK_URL: 'https://app.example.com/oauth/callback' } as NodeJS.ProcessEnv,
    )).toBe('https://app.example.com/oauth/callback');
  });

  it('rejects unsafe production deployment URLs', () => {
    expect(() => getDeploymentSafeUrl(
      'CALLBACK_URL',
      {},
      { NODE_ENV: 'production', CALLBACK_URL: 'http://app.example.com/oauth/callback' } as NodeJS.ProcessEnv,
    )).toThrow(ConfigurationError);
    expect(() => getDeploymentSafeUrl(
      'CALLBACK_URL',
      {},
      { NODE_ENV: 'production', CALLBACK_URL: 'https://localhost/oauth/callback' } as NodeJS.ProcessEnv,
    )).toThrow(ConfigurationError);
    expect(() => getDeploymentSafeUrl(
      'CALLBACK_URL',
      { requiredInProduction: true },
      { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
    )).toThrow(ConfigurationError);
  });

  it('allows explicitly allowlisted custom app redirect protocols', () => {
    expect(getDeploymentSafeUrl(
      'SUCCESS_URL',
      { allowedProtocols: ['https:', 'crm:'] },
      { NODE_ENV: 'production', SUCCESS_URL: 'crm://calendar' } as NodeJS.ProcessEnv,
    )).toBe('crm://calendar');
    expect(() => getDeploymentSafeUrl(
      'SUCCESS_URL',
      { allowedProtocols: ['https:', 'crm:'] },
      { NODE_ENV: 'production', SUCCESS_URL: 'javascript:alert(1)' } as NodeJS.ProcessEnv,
    )).toThrow(ConfigurationError);
  });

  it('accepts a complete production security configuration', () => {
    expect(() => validateProductionConfig(validProductionEnv({
      EXPO_PUBLIC_API_URL: 'https://api.example.com/api/v1',
      REDIS_URL: 'rediss://cache.example.com:6379',
      YANDEX_CLIENT_ID: 'client-id',
      YANDEX_CLIENT_SECRET: 'client-secret',
      YANDEX_REDIRECT_URI: 'https://api.example.com/api/v1/calendar/sync/yandex/callback',
      YANDEX_CALENDAR_SUCCESS_URL: 'crm://calendar',
    }))).not.toThrow();
  });

  it('rejects unsafe production database and integration configuration', () => {
    expect(() => validateProductionConfig(validProductionEnv({
      DATABASE_URL: 'postgresql://postgres:password@localhost:5432/crm_db',
    }))).toThrow(ConfigurationError);

    expect(() => validateProductionConfig(validProductionEnv({
      YANDEX_CLIENT_ID: 'client-id',
    }))).toThrow(ConfigurationError);

    expect(() => validateProductionConfig(validProductionEnv({
      EXPO_PUBLIC_API_URL: 'http://api.example.com/api/v1',
    }))).toThrow(ConfigurationError);
  });
});
