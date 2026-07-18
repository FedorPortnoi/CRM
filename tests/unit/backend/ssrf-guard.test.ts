import { describe, expect, it } from 'vitest';
import {
  assertAllowedBitrixWebhookUrl,
  OutboundRequestError,
} from '../../../backend/config/security';

describe('assertAllowedBitrixWebhookUrl (SSRF guard)', () => {
  const rejected = [
    'http://127.0.0.1/rest',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5:9200',
    'http://[::ffff:169.254.169.254]/',
    'http://2130706433/',
    'https://evil.com/rest',
    'http://myco.bitrix24.ru/rest', // http, not https
  ];

  for (const url of rejected) {
    it(`rejects ${url}`, () => {
      expect(() => assertAllowedBitrixWebhookUrl(url)).toThrow(OutboundRequestError);
    });
  }

  const allowed = [
    'https://myco.bitrix24.ru/rest/1/token/',
    'https://portal.bitrix24.com/rest/1/abc/',
  ];

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(() => assertAllowedBitrixWebhookUrl(url)).not.toThrow();
    });
  }
});
