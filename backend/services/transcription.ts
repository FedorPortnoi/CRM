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

/**
 * gpt-4o-mini-transcribe, not whisper-1: markedly fewer word errors on Russian
 * and on proper nouns (client and company names are most of what gets dictated
 * here), same JSON response shape, same price bracket. It is already in the
 * proxy's ALLOWED_TRANSCRIBE_MODELS, so this default needs no worker redeploy.
 */
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 60_000;
const DEFAULT_TRANSCRIBE_LANGUAGE = 'ru';

/**
 * Languages the app itself speaks (see src/i18n). A caller may pick between
 * them per recording; anything else is ignored rather than forwarded, so a
 * malformed field can never turn into an unexpected transcription language.
 */
const SUPPORTED_TRANSCRIBE_LANGUAGES = new Set(['ru', 'en']);

/**
 * No vocabulary hint by default, and that is a measured decision rather than an
 * omission. `prompt` biases decoding toward its own spelling, which is the
 * documented lever for domain nouns — but measured against the live proxy on
 * 2026-09-01 it made the failure case worse: eight seconds of pure silence
 * transcribed as "" with no prompt, and as the prompt itself, echoed back
 * verbatim, with one. Trading a clean empty result for a confident-looking
 * sentence is the wrong trade for a feature that drives CRM tool calls, and the
 * benefit never showed up — whisper-1 already returned "4куб" and "Штирлиц"
 * correctly with no prompt at all.
 *
 * OPENAI_TRANSCRIBE_PROMPT still enables one if a real accuracy gap appears.
 * The echo guard below stays either way, so turning it on cannot regress this.
 */

// ---------------------------------------------------------------------------
// Hallucination guard
// ---------------------------------------------------------------------------
//
// Whisper-family models do not return "nothing" for audio with no intelligible
// speech. They return the likeliest text, and for a silent Russian clip that is
// memorised end-of-video subtitle credits from the training corpus. Prod hit
// this on 2026-09-01: two recordings in a row came back byte-identical as
// "Редактор субтитров А.Синецкая Корректор А.Егорова", which the operator then
// sent to the assistant as if it were a command.
//
// Two separate things get caught here:
//
//  1. The known artifacts below — a short, closed list of phrases that only
//     ever appear as hallucinations in this product. A real CRM voice command
//     is never "Спасибо за просмотр".
//  2. An echo of our own `prompt`. Feeding a vocabulary hint is the documented
//     way to fix domain nouns, and feeding it back verbatim is the documented
//     way that hint fails on silence. Adding the prompt without this check
//     would have swapped one hallucination for a worse-looking one.
//
// A caught transcript becomes the empty string, which the app already renders
// as "Речь не распознана — попробуйте сказать ещё раз." — so this fix reaches
// operators on a backend restart, with no app release.

// Two tiers, because the artifacts differ in how ambiguous they are.
//
// Tier A never appears in a CRM voice command: matching anywhere in a short
// transcript is enough. Note the prod string is caught by "редактор субтитров"
// alone — bare "корректор" is deliberately NOT here, because "Создай контакт
// Корректор Егорова" is a command a real operator can give.
const HALLUCINATION_ARTIFACTS_STRICT = [
  'редактор субтитров',
  'субтитры сделал',
  'субтитры создавал',
  'субтитры и перевод',
  'продолжение следует',
  'подписывайтесь на канал',
  'subtitles by',
  'subs by',
];

// Tier B is ordinary language that only reads as a hallucination when it is the
// WHOLE transcript. "Спасибо за просмотр записи встречи, создай задачу…" is
// dictation; "Спасибо за просмотр." on its own is Whisper filling silence.
const HALLUCINATION_ARTIFACTS_STANDALONE = [
  'спасибо за просмотр',
  'спасибо за внимание',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
];

/** Lowercased, punctuation-stripped, whitespace-collapsed — so spacing or a
 *  stray full stop cannot walk a known artifact past the check. */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isHallucinatedTranscript(text: string, prompt: string): boolean {
  const normalized = normalizeForMatch(text);
  if (normalized === '') return false;

  // Guard 1: our own vocabulary hint, read back to us. Only short transcripts
  // are tested — a long answer that happens to quote a domain noun is real
  // speech, not an echo.
  if (prompt) {
    const normalizedPrompt = normalizeForMatch(prompt);
    if (
      normalized.length <= normalizedPrompt.length + 16 &&
      (normalizedPrompt.includes(normalized) || normalized.includes(normalizedPrompt))
    ) {
      return true;
    }
  }

  // A long transcript is speech the model actually heard; artifacts are short.
  if (normalized.length > 120) return false;

  if (HALLUCINATION_ARTIFACTS_STRICT.some((artifact) => normalized.includes(artifact))) {
    return true;
  }

  return HALLUCINATION_ARTIFACTS_STANDALONE.some(
    (artifact) =>
      normalized.includes(artifact) && normalized.length <= artifact.length + 12,
  );
}

export function normalizeTranscribeLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const language = value.trim().toLowerCase().slice(0, 5).split(/[-_]/)[0];
  return SUPPORTED_TRANSCRIBE_LANGUAGES.has(language) ? language : null;
}

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
  /** Vocabulary hint. Empty string means "send no prompt". */
  prompt: string;
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
    // Off unless deliberately configured — see the note above.
    prompt: process.env.OPENAI_TRANSCRIBE_PROMPT?.trim() ?? '',
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
  | { ok: true; text: string; rejected?: 'hallucination' }
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
  options: { mimeType: string; filename?: string; language?: string | null },
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
  // Per-recording language wins over the deployment default. This is the whole
  // point of the field: the server default is Russian, and forcing Russian onto
  // an English utterance does not fail — it returns confident nonsense.
  const language = normalizeTranscribeLanguage(options.language) ?? config.language;
  if (language) {
    form.append('language', language);
  }
  if (config.prompt) {
    form.append('prompt', config.prompt);
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

  const transcript = text.trim();

  // Speechless audio comes back as confident nonsense, not as an error. Report
  // it as "nothing was said" so it can never be sent to the assistant, which
  // acts on real CRM data.
  if (isHallucinatedTranscript(transcript, config.prompt)) {
    return { ok: true, text: '', rejected: 'hallucination' };
  }

  return { ok: true, text: transcript };
}
