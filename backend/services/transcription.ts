/**
 * Voice-message transcription for the AI assistant.
 *
 * The audio goes to OpenAI (Whisper) through workers/openai-proxy — the same
 * Cloudflare Worker that fronts the assistant's chat completions. The backend
 * holds only OPENAI_PROXY_TOKEN; the real OpenAI key never leaves Cloudflare.
 *
 * -----------------------------------------------------------------------------
 * CROSS-BORDER: WHY THERE IS AN EXTRA FLAG
 * -----------------------------------------------------------------------------
 * A voice recording is personal data of the person speaking, and unlike a chat
 * prompt it cannot be aliased before it leaves — there is no
 * contact-alias.ts for a waveform. Sending it to OpenAI is therefore a
 * cross-border transfer in exactly the sense model-jurisdiction.ts exists to
 * prevent happening silently. The owner accepted this trade-off for voice
 * input on 2026-08-11, and this module follows the same philosophy as the
 * jurisdiction gate: the transfer must be a deliberate configuration act, not
 * a side effect of two unrelated env vars being present. Hence
 * VOICE_INPUT_CROSS_BORDER_OK — without it set to "true", voice input reports
 * itself unavailable and the app never shows a microphone.
 *
 * Like yandex-gpt.ts, this module never throws for provider problems — it
 * returns a structured AiError so the controller can map codes to statuses on
 * the one existing path.
 */

import type { AiError } from './yandex-gpt';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Hard cap on an uploaded voice message. Recordings from the app are capped at
 * two minutes of AAC (~2 MB); 15 MiB leaves generous headroom while staying
 * under the proxy's own 25 MiB ceiling, so the proxy limit is never what a
 * legitimate caller hits.
 */
export const MAX_VOICE_MESSAGE_BYTES = 15 * 1024 * 1024;

const DEFAULT_TRANSCRIBE_MODEL = 'whisper-1';
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 60_000;
const DEFAULT_TRANSCRIBE_LANGUAGE = 'ru';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type TranscriptionConfig = {
  /** e.g. https://<worker>.workers.dev/v1 — the proxy, never api.openai.com. */
  baseUrl: string;
  proxyToken: string;
  model: string;
  /** ISO-639-1 hint passed to Whisper. Empty string means "let it detect". */
  language: string;
  timeoutMs: number;
};

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getTranscriptionConfig(): TranscriptionConfig | null {
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  const proxyToken = process.env.OPENAI_PROXY_TOKEN?.trim();
  const crossBorderOk =
    (process.env.VOICE_INPUT_CROSS_BORDER_OK ?? '').trim().toLowerCase() === 'true';
  if (!baseUrl || !proxyToken || !crossBorderOk) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    proxyToken,
    model: process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL,
    // Unset → Russian. Set-but-empty → no hint, let Whisper detect.
    language:
      process.env.OPENAI_TRANSCRIBE_LANGUAGE === undefined
        ? DEFAULT_TRANSCRIBE_LANGUAGE
        : process.env.OPENAI_TRANSCRIBE_LANGUAGE.trim(),
    timeoutMs: positiveIntFromEnv('OPENAI_TRANSCRIBE_TIMEOUT_MS', DEFAULT_TRANSCRIBE_TIMEOUT_MS),
  };
}

export function isVoiceInputConfigured(): boolean {
  return getTranscriptionConfig() !== null;
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

export type TranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; error: AiError };

function failure(code: AiError['code'], message: string, status?: number): TranscriptionResult {
  return { ok: false, error: { code, message, ...(status !== undefined ? { status } : {}) } };
}

/**
 * Send one voice recording to Whisper and return its transcript.
 *
 * `audio` is the raw file as recorded by the app (AAC in an mp4/m4a container
 * on both platforms). It is forwarded as-is: no transcoding, no persistence —
 * the recording exists in this process only for the lifetime of the request,
 * and nothing from it is ever logged.
 */
export async function transcribeVoiceMessage(
  audio: Buffer,
  options: { mimeType: string; filename?: string },
): Promise<TranscriptionResult> {
  const config = getTranscriptionConfig();
  if (!config) {
    return failure(
      'SERVICE_NOT_CONFIGURED',
      'Voice input is not configured: OPENAI_BASE_URL, OPENAI_PROXY_TOKEN and VOICE_INPUT_CROSS_BORDER_OK must all be set',
    );
  }

  if (audio.byteLength === 0) {
    return failure('AI_REQUEST_FAILED', 'Получен пустой аудиофайл');
  }
  if (audio.byteLength > MAX_VOICE_MESSAGE_BYTES) {
    return failure('AI_REQUEST_FAILED', 'Аудиофайл слишком большой');
  }

  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(audio)], { type: options.mimeType }),
    options.filename?.trim() || 'voice-message.m4a',
  );
  form.append('model', config.model);
  form.append('response_format', 'json');
  if (config.language) {
    form.append('language', config.language);
  }

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.proxyToken}` },
      body: form,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return failure('AI_TIMEOUT', `Распознавание не ответило за ${config.timeoutMs} мс`);
    }
    return failure('AI_UNAVAILABLE', 'Сервис распознавания речи недоступен');
  }

  if (!response.ok) {
    // Proxy and OpenAI share one error envelope: { error: { message, code } }.
    // The message is safe to relay — the proxy's are static strings and
    // OpenAI's describe the request, not the audio.
    let upstreamMessage = '';
    try {
      const parsed = (await response.json()) as { error?: { message?: string } };
      if (typeof parsed?.error?.message === 'string') {
        upstreamMessage = parsed.error.message;
      }
    } catch {
      // A non-JSON error body is fine — the status code is enough.
    }

    if (response.status === 401 || response.status === 403) {
      return failure('AI_UNAUTHORIZED', 'Прокси отклонил учётные данные', response.status);
    }
    if (response.status === 429) {
      return failure(
        'AI_RATE_LIMITED',
        upstreamMessage || 'Превышен лимит запросов к распознаванию речи',
        response.status,
      );
    }
    if (response.status >= 500) {
      return failure(
        'AI_UNAVAILABLE',
        upstreamMessage || 'Сервис распознавания речи недоступен',
        response.status,
      );
    }
    return failure(
      'AI_REQUEST_FAILED',
      upstreamMessage || 'Запрос на распознавание речи отклонён',
      response.status,
    );
  }

  let text: unknown;
  try {
    const parsed = (await response.json()) as { text?: unknown };
    text = parsed?.text;
  } catch {
    return failure('AI_BAD_RESPONSE', 'Распознавание вернуло некорректный ответ');
  }

  if (typeof text !== 'string') {
    return failure('AI_BAD_RESPONSE', 'Распознавание вернуло ответ без текста');
  }

  return { ok: true, text: text.trim() };
}
