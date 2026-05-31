import { Resend } from 'resend';

type SendResult = {
  success: boolean;
  messageId?: string;
  errorCode?: string;
};

function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  return new Resend(apiKey);
}

export function isEmailSendingEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export function getFromEmail(): string {
  return process.env.RESEND_FROM_EMAIL?.trim() ?? 'CRM <onboarding@resend.dev>';
}

export async function sendEmail(to: string, subject: string, text: string): Promise<SendResult> {
  const client = getResendClient();
  if (!client) {
    return { success: false, errorCode: 'SERVICE_NOT_CONFIGURED' };
  }

  try {
    const { data, error } = await client.emails.send({
      from: getFromEmail(),
      to,
      subject,
      text,
    });

    if (error) {
      return { success: false, errorCode: error.name ?? 'RESEND_ERROR' };
    }

    return { success: true, messageId: data?.id };
  } catch (err) {
    return { success: false, errorCode: err instanceof Error ? err.message : 'SEND_FAILED' };
  }
}
