const SMS_RU_BASE = 'https://sms.ru';
const DEFAULT_TIMEOUT_MS = 5000;

type SmsRuResponse = {
  status?: string;
  status_code?: number;
  sms?: Record<string, { status?: string; status_code?: number; sms_id?: string }>;
};

type SendResult = {
  success: boolean;
  smsId?: string;
  errorCode?: string;
  disabled?: boolean;
};

function readTrimmedEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isSmsSendingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = readTrimmedEnv('SMSRU_SEND_ENABLED', env)?.toLowerCase();
  if (configured === undefined) return env.NODE_ENV !== 'test';
  return configured === '1' || configured === 'true' || configured === 'yes' || configured === 'on';
}

function getTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(readTrimmedEnv('SMSRU_TIMEOUT_MS', env));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function normalizeNetworkError(error: unknown): string {
  return error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
}

async function sendSmsRu(to: string, text: string): Promise<SendResult> {
  const apiId = readTrimmedEnv('SMSRU_API_ID');
  if (!apiId) return { success: false, errorCode: 'SERVICE_NOT_CONFIGURED' };

  const sender = readTrimmedEnv('SMSRU_SENDER') ?? 'CRM';
  const params = new URLSearchParams({ api_id: apiId, to, msg: text, from: sender, json: '1' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const response = await fetch(new URL('/sms/send', SMS_RU_BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: controller.signal,
    });

    if (!response.ok) return { success: false, errorCode: `HTTP_${response.status}` };

    const body = await response.json() as SmsRuResponse;
    const smsEntry = body.sms ? Object.values(body.sms)[0] : undefined;
    if (body.status === 'OK' && (!smsEntry || smsEntry.status === 'OK')) {
      return { success: true, smsId: smsEntry?.sms_id };
    }
    return { success: false, errorCode: String(smsEntry?.status_code ?? body.status_code ?? 'SMSRU_ERROR') };
  } catch (error) {
    return { success: false, errorCode: normalizeNetworkError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendSms(phone: string, text: string): Promise<SendResult> {
  if (!isSmsSendingEnabled()) return { success: false, errorCode: 'SMS_SEND_DISABLED', disabled: true };
  return sendSmsRu(phone, text);
}

export async function sendOtp(phone: string, code: string): Promise<SendResult> {
  return sendSms(phone, `Ваш код подтверждения: ${code}. Действителен 10 минут.`);
}
