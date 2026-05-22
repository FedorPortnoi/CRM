import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  getCorsOrigin,
  getJwtSecret,
  getRequiredSecret,
} from '../../../backend/config/security';

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
});
