import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSmsSendingEnabled, sendSms } from '../../../backend/services/sms';

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  SMSRU_API_ID: process.env.SMSRU_API_ID,
  SMSRU_SEND_ENABLED: process.env.SMSRU_SEND_ENABLED,
  SMSRU_SENDER: process.env.SMSRU_SENDER,
  SMSRU_TIMEOUT_MS: process.env.SMSRU_TIMEOUT_MS,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('SMS.ru outbound service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    restoreEnv();
  });

  it('disables sending by default in test unless explicitly enabled', () => {
    expect(isSmsSendingEnabled({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSmsSendingEnabled({
      NODE_ENV: 'test',
      SMSRU_SEND_ENABLED: 'true',
    } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('does not call the provider when SMSRU_SEND_ENABLED is false', async () => {
    process.env.SMSRU_API_ID = 'api-secret';
    process.env.SMSRU_SEND_ENABLED = 'false';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendSms('+15550001000', 'hello world')).resolves.toEqual({
      success: false,
      errorCode: 'SMS_SEND_DISABLED',
      disabled: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends via POST body instead of leaking api_id or message text in the URL', async () => {
    process.env.SMSRU_API_ID = 'api-secret';
    process.env.SMSRU_SEND_ENABLED = 'true';
    process.env.SMSRU_SENDER = 'CRM';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.toString() : String(input);
      expect(url).toBe('https://sms.ru/sms/send');
      expect(url).not.toContain('?');
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBeInstanceOf(AbortSignal);

      const body = new URLSearchParams(String(init?.body));
      expect(body.get('api_id')).toBe('api-secret');
      expect(body.get('to')).toBe('+15550001000');
      expect(body.get('msg')).toBe('hello world');
      expect(body.get('from')).toBe('CRM');
      expect(body.get('json')).toBe('1');

      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'OK',
          sms: { '+15550001000': { status: 'OK', sms_id: 'sms-1' } },
        }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendSms('+15550001000', 'hello world')).resolves.toEqual({
      success: true,
      smsId: 'sms-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps provider request aborts to TIMEOUT', async () => {
    process.env.SMSRU_API_ID = 'api-secret';
    process.env.SMSRU_SEND_ENABLED = 'true';
    process.env.SMSRU_TIMEOUT_MS = '10';

    vi.stubGlobal('fetch', vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }));

    await expect(sendSms('+15550001000', 'hello world')).resolves.toEqual({
      success: false,
      errorCode: 'TIMEOUT',
    });
  });
});
