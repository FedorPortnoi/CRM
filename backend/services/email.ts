import { Resend, type CreateEmailRequestOptions } from 'resend';

type SendResult = {
  success: boolean;
  messageId?: string;
  errorCode?: string;
};

/**
 * How long ONE provider call may take before it is aborted.
 *
 * There used to be no deadline at all, and `fetch` has none of its own: a request that hung
 * on a half-open socket hung the caller with it, forever. The scheduler's sequence tick
 * sends sequentially and holds a 5 min claim on the enrollment it is sending to
 * (SEQUENCE_SEND_LEASE_MS), so one stuck send outlives the claim, the row falls back to
 * "due", and the next tick mails the same person a second time. The deadline has to stay
 * comfortably under that lease — the lease is per-enrollment and is stamped when the row is
 * claimed, so what matters is that a single send can never approach it.
 */
export const EMAIL_SEND_TIMEOUT_MS = 20_000;

export type SendEmailOptions = {
  /**
   * Extra RFC 5322 headers for this message. Resend passes these through verbatim
   * (`CreateEmailBaseOptions.headers`), so the values must already be header-safe — see
   * sanitizeHeaderValue in services/email-templates.ts. Used for List-Unsubscribe /
   * List-Unsubscribe-Post on sequence sends.
   */
  headers?: Record<string, string>;
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

/**
 * `text` is the message. `html` is an OPTIONAL alternative part: when it is supplied the
 * message goes out as multipart/alternative and a text-only client still renders `text`
 * byte-for-byte, so callers that pass nothing keep the exact behaviour they had before.
 * Anything that only makes sense as markup — a tracking pixel, a real anchor — belongs in
 * `html` and must never be pasted into `text`, where the recipient would read the tags.
 *
 * `options.headers` adds custom headers to this one message; everything else about the call
 * is unchanged, so the four-argument callers keep their exact behaviour.
 *
 * The call is bounded by EMAIL_SEND_TIMEOUT_MS and reports `SEND_TIMEOUT` when it expires.
 * The abort is real — the signal reaches the socket — so a timed-out send is not still in
 * flight somewhere, quietly delivering the message the caller has already recorded as
 * failed and will retry.
 */
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  html?: string,
  options: SendEmailOptions = {},
): Promise<SendResult> {
  const client = getResendClient();
  if (!client) {
    return { success: false, errorCode: 'SERVICE_NOT_CONFIGURED' };
  }

  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, EMAIL_SEND_TIMEOUT_MS);

  // Resend's own request-options type names only query/headers/idempotencyKey, but the
  // client spreads this object straight into `fetch(url, init)` — so `signal` is honoured
  // at the socket. Declared as an intersection rather than cast, so the extra field is
  // stated rather than smuggled past the compiler.
  const requestOptions: CreateEmailRequestOptions & { signal: AbortSignal } = {
    signal: controller.signal,
  };

  try {
    const { data, error } = await client.emails.send(
      {
        from: getFromEmail(),
        to,
        subject,
        text,
        ...(html ? { html } : {}),
        ...(options.headers && Object.keys(options.headers).length > 0
          ? { headers: options.headers }
          : {}),
      },
      requestOptions,
    );

    if (error) {
      // An aborted fetch surfaces here as a generic transport error, so the timeout flag —
      // not the provider's error name — is what tells the caller a deadline was hit.
      return {
        success: false,
        errorCode: timedOut ? 'SEND_TIMEOUT' : (error.name ?? 'RESEND_ERROR'),
      };
    }

    return { success: true, messageId: data?.id };
  } catch (err) {
    if (timedOut) {
      return { success: false, errorCode: 'SEND_TIMEOUT' };
    }
    return { success: false, errorCode: err instanceof Error ? err.message : 'SEND_FAILED' };
  } finally {
    clearTimeout(deadline);
  }
}
