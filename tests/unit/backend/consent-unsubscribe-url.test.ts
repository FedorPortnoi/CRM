/**
 * ФЗ-38 requires a working opt-out in every marketing message, and the fine is per
 * message. The fallback base URL used to be EXPO_PUBLIC_API_URL, which already ends in
 * /api/v1, while buildUnsubscribeUrl appends /api/v1/... itself — so every unsubscribe
 * link in a deployment without PUBLIC_APP_URL pointed at
 *   .../api/v1/api/v1/consent/unsubscribe/<token>
 * and 404'd. The link looked present in the email, so nothing failed loudly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getUnsubscribeBaseUrl, buildUnsubscribeUrl } from '../../../backend/services/consent';

const ORIGINAL = { ...process.env };

describe('unsubscribe URL construction', () => {
  beforeEach(() => {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.EXPO_PUBLIC_API_URL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('does not double the API prefix when falling back to EXPO_PUBLIC_API_URL', () => {
    process.env.EXPO_PUBLIC_API_URL = 'http://111.88.149.122:3000/api/v1';

    const url = buildUnsubscribeUrl('tok123');

    expect(url).toBe('http://111.88.149.122:3000/api/v1/consent/unsubscribe/tok123');
    expect(url).not.toContain('/api/v1/api/v1');
  });

  it('prefers PUBLIC_APP_URL when it is set', () => {
    process.env.PUBLIC_APP_URL = 'https://4kub.ru';
    process.env.EXPO_PUBLIC_API_URL = 'https://4kub.ru/api/v1';

    expect(buildUnsubscribeUrl('tok')).toBe('https://4kub.ru/api/v1/consent/unsubscribe/tok');
  });

  it('strips trailing slashes as well as the API prefix', () => {
    process.env.EXPO_PUBLIC_API_URL = 'https://4kub.ru/api/v1///';

    expect(getUnsubscribeBaseUrl()).toBe('https://4kub.ru');
  });

  it('leaves a base URL without an API prefix alone', () => {
    process.env.PUBLIC_APP_URL = 'https://app.4kub.ru';

    expect(getUnsubscribeBaseUrl()).toBe('https://app.4kub.ru');
  });

  it('still produces a usable link when nothing is configured', () => {
    expect(buildUnsubscribeUrl('tok')).toBe('http://localhost:3001/api/v1/consent/unsubscribe/tok');
  });

  it('percent-encodes the token', () => {
    process.env.PUBLIC_APP_URL = 'https://4kub.ru';

    expect(buildUnsubscribeUrl('a b/c')).toBe(
      'https://4kub.ru/api/v1/consent/unsubscribe/a%20b%2Fc',
    );
  });
});
