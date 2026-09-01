import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_VOICE_MESSAGE_BYTES,
  getTranscriptionConfig,
  isVoiceInputConfigured,
  transcribeVoiceMessage,
} from '../../../backend/services/transcription';

// ---------------------------------------------------------------------------
// Env fixture — the three variables that gate the feature, saved and restored
// so these tests cannot leak configuration into the rest of the suite.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_PROXY_TOKEN',
  'VOICE_INPUT_CROSS_BORDER_OK',
  'OPENAI_TRANSCRIBE_MODEL',
  'OPENAI_TRANSCRIBE_LANGUAGE',
  'OPENAI_TRANSCRIBE_PROMPT',
  'OPENAI_TRANSCRIBE_TIMEOUT_MS',
] as const;

let savedEnv: Record<string, string | undefined>;

function configureEnv(overrides: Record<string, string | undefined> = {}): void {
  const base: Record<string, string | undefined> = {
    OPENAI_BASE_URL: 'https://proxy.example.workers.dev/v1',
    OPENAI_PROXY_TOKEN: 'proxy-token-for-tests',
    VOICE_INPUT_CROSS_BORDER_OK: 'true',
    ...overrides,
  };
  for (const key of ENV_KEYS) {
    const value = base[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUDIO = Buffer.from('RIFF-fake-aac-bytes');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchCall = { url: string; init: RequestInit };

function stubFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

// ---------------------------------------------------------------------------
// Configuration gating
// ---------------------------------------------------------------------------

describe('getTranscriptionConfig', () => {
  it('is null unless the URL, the token AND the cross-border flag are all set', () => {
    configureEnv();
    expect(getTranscriptionConfig()).not.toBeNull();

    configureEnv({ OPENAI_BASE_URL: undefined });
    expect(getTranscriptionConfig()).toBeNull();

    configureEnv({ OPENAI_PROXY_TOKEN: undefined });
    expect(getTranscriptionConfig()).toBeNull();

    configureEnv({ VOICE_INPUT_CROSS_BORDER_OK: undefined });
    expect(getTranscriptionConfig()).toBeNull();

    configureEnv({ VOICE_INPUT_CROSS_BORDER_OK: 'false' });
    expect(getTranscriptionConfig()).toBeNull();

    // The flag is an acknowledgement, not a truthiness check.
    configureEnv({ VOICE_INPUT_CROSS_BORDER_OK: '1' });
    expect(getTranscriptionConfig()).toBeNull();
  });

  it('mirrors into isVoiceInputConfigured for the status endpoint', () => {
    configureEnv();
    expect(isVoiceInputConfigured()).toBe(true);
    configureEnv({ VOICE_INPUT_CROSS_BORDER_OK: 'false' });
    expect(isVoiceInputConfigured()).toBe(false);
  });

  it('defaults the model, language and prompt, and strips a trailing slash', () => {
    configureEnv({ OPENAI_BASE_URL: 'https://proxy.example.workers.dev/v1/' });
    const config = getTranscriptionConfig();
    expect(config?.baseUrl).toBe('https://proxy.example.workers.dev/v1');
    // Must stay inside the proxy's ALLOWED_TRANSCRIBE_MODELS — a model the
    // worker does not allowlist fails every recording with a flat 400.
    expect(config?.model).toBe('gpt-4o-mini-transcribe');
    expect(config?.language).toBe('ru');
    // Off by default: a prompt turns silence into a confident echo (measured
    // against the live proxy 2026-09-01), and buys no accuracy we could show.
    expect(config?.prompt).toBe('');
    expect(config?.timeoutMs).toBe(60_000);
  });

  it('an explicitly empty language means autodetect, not ru', () => {
    configureEnv({ OPENAI_TRANSCRIBE_LANGUAGE: '' });
    expect(getTranscriptionConfig()?.language).toBe('');
  });

  it('a configured prompt is passed through when one is deliberately set', () => {
    configureEnv({ OPENAI_TRANSCRIBE_PROMPT: 'сделка, воронка, этап' });
    expect(getTranscriptionConfig()?.prompt).toBe('сделка, воронка, этап');
  });
});

// ---------------------------------------------------------------------------
// transcribeVoiceMessage
// ---------------------------------------------------------------------------

describe('transcribeVoiceMessage', () => {
  it('refuses to run unconfigured', async () => {
    configureEnv({ VOICE_INPUT_CROSS_BORDER_OK: 'false' });
    const calls = stubFetch(() => jsonResponse({ text: 'нет' }));
    const result = await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' });
    expect(result).toMatchObject({ ok: false, error: { code: 'SERVICE_NOT_CONFIGURED' } });
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty or oversized recording before any network call', async () => {
    configureEnv();
    const calls = stubFetch(() => jsonResponse({ text: 'нет' }));

    const empty = await transcribeVoiceMessage(Buffer.alloc(0), { mimeType: 'audio/mp4' });
    expect(empty).toMatchObject({ ok: false, error: { code: 'AI_REQUEST_FAILED' } });

    const oversized = await transcribeVoiceMessage(
      Buffer.alloc(MAX_VOICE_MESSAGE_BYTES + 1),
      { mimeType: 'audio/mp4' },
    );
    expect(oversized).toMatchObject({ ok: false, error: { code: 'AI_REQUEST_FAILED' } });

    expect(calls).toHaveLength(0);
  });

  it('sends the audio as multipart to the proxy and returns the trimmed transcript', async () => {
    configureEnv();
    const calls = stubFetch(() => jsonResponse({ text: '  Создай задачу на завтра  ' }));

    const result = await transcribeVoiceMessage(AUDIO, {
      mimeType: 'audio/mp4',
      filename: 'voice.m4a',
    });

    expect(result).toEqual({ ok: true, text: 'Создай задачу на завтра' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://proxy.example.workers.dev/v1/audio/transcriptions');

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer proxy-token-for-tests');

    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('language')).toBe('ru');
    expect(form.get('response_format')).toBe('json');
    expect(form.get('prompt')).toBeNull();
    const file = form.get('file') as File;
    expect(file.name).toBe('voice.m4a');
    expect(file.type).toBe('audio/mp4');
    expect(file.size).toBe(AUDIO.byteLength);
  });

  it('omits the language field when autodetect is configured', async () => {
    configureEnv({ OPENAI_TRANSCRIBE_LANGUAGE: '' });
    const calls = stubFetch(() => jsonResponse({ text: 'ok' }));
    await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' });
    expect((calls[0].init.body as FormData).get('language')).toBeNull();
  });

  it('omits the prompt field when no vocabulary hint is configured', async () => {
    configureEnv();
    const calls = stubFetch(() => jsonResponse({ text: 'ok' }));
    await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' });
    expect((calls[0].init.body as FormData).get('prompt')).toBeNull();
  });

  it("the caller's language overrides the deployment default", async () => {
    configureEnv();
    const calls = stubFetch(() => jsonResponse({ text: 'ok' }));
    await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4', language: 'en-US' });
    expect((calls[0].init.body as FormData).get('language')).toBe('en');
  });

  it('an unsupported or absent caller language falls back to the default', async () => {
    configureEnv();
    const calls = stubFetch(() => jsonResponse({ text: 'ok' }));
    await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4', language: 'klingon' });
    await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4', language: null });
    expect((calls[0].init.body as FormData).get('language')).toBe('ru');
    expect((calls[1].init.body as FormData).get('language')).toBe('ru');
  });

  it("reports Whisper's silence hallucination as nothing-was-said", async () => {
    configureEnv();
    // The exact string prod returned twice in a row on 2026-09-01 for a
    // recording the operator had spoken into.
    stubFetch(() => jsonResponse({ text: 'Редактор субтитров А.Синецкая Корректор А.Егорова' }));
    expect(await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' })).toEqual({
      ok: true,
      text: '',
      rejected: 'hallucination',
    });
  });

  it('catches the other known artifacts, in both languages', async () => {
    configureEnv();
    for (const artifact of [
      'Продолжение следует...',
      'Спасибо за просмотр!',
      'Субтитры сделал DimaTorzok',
      'Subtitles by the Amara.org community',
      'Thank you for watching!',
    ]) {
      stubFetch(() => jsonResponse({ text: artifact }));
      expect(await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' })).toMatchObject({
        ok: true,
        text: '',
        rejected: 'hallucination',
      });
    }
  });

  it('rejects a configured vocabulary prompt echoed back as a transcript', async () => {
    // Exactly what gpt-4o-mini-transcribe returned for silent audio once a
    // prompt was set — the reason the default is now no prompt at all.
    configureEnv({ OPENAI_TRANSCRIBE_PROMPT: 'Это голосовая команда для CRM. Термины: сделка, задача, контакт.' });
    const prompt = getTranscriptionConfig()?.prompt ?? '';
    expect(prompt).not.toBe('');
    stubFetch(() => jsonResponse({ text: prompt }));
    expect(await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' })).toMatchObject({
      ok: true,
      text: '',
      rejected: 'hallucination',
    });
  });

  it('lets real commands through, including ones that mention a caught phrase', async () => {
    configureEnv();
    for (const real of [
      'Поставь задачу внести правки в презентацию для риэлторов до 3 сентября',
      'Создай контакт Корректор Егорова и поставь ей задачу на завтра к десяти утра',
      'Спасибо за просмотр записи встречи, создай по ней задачу на понедельник и добавь заметку',
    ]) {
      stubFetch(() => jsonResponse({ text: real }));
      expect(await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' })).toEqual({
        ok: true,
        text: real,
      });
    }
  });

  it('maps upstream statuses onto the assistant error vocabulary', async () => {
    configureEnv();
    const byStatus: Array<[number, string]> = [
      [401, 'AI_UNAUTHORIZED'],
      [403, 'AI_UNAUTHORIZED'],
      [429, 'AI_RATE_LIMITED'],
      [500, 'AI_UNAVAILABLE'],
      [503, 'AI_UNAVAILABLE'],
      [400, 'AI_REQUEST_FAILED'],
      [413, 'AI_REQUEST_FAILED'],
    ];
    for (const [status, code] of byStatus) {
      stubFetch(() =>
        jsonResponse({ error: { message: 'upstream says no', code: 'x' } }, status),
      );
      const result = await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' });
      expect(result, `status ${status}`).toMatchObject({ ok: false, error: { code, status } });
    }
  });

  it('relays the proxy error message when there is one', async () => {
    configureEnv();
    stubFetch(() =>
      jsonResponse({ error: { message: 'Daily request ceiling of 500 reached.' } }, 429),
    );
    const result = await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'AI_RATE_LIMITED', message: 'Daily request ceiling of 500 reached.' },
    });
  });

  it('a timeout is AI_TIMEOUT and a network failure is AI_UNAVAILABLE', async () => {
    configureEnv();

    stubFetch(() => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    expect(await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' })).toMatchObject({
      ok: false,
      error: { code: 'AI_TIMEOUT' },
    });

    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' })).toMatchObject({
      ok: false,
      error: { code: 'AI_UNAVAILABLE' },
    });
  });

  it('a 200 without a text field is AI_BAD_RESPONSE', async () => {
    configureEnv();
    for (const body of [{}, { text: 42 }, { transcript: 'нет' }]) {
      stubFetch(() => jsonResponse(body));
      const result = await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' });
      expect(result).toMatchObject({ ok: false, error: { code: 'AI_BAD_RESPONSE' } });
    }

    stubFetch(() => new Response('not json', { status: 200 }));
    expect(await transcribeVoiceMessage(AUDIO, { mimeType: 'audio/mp4' })).toMatchObject({
      ok: false,
      error: { code: 'AI_BAD_RESPONSE' },
    });
  });
});

// ---------------------------------------------------------------------------
// Controller — request shape and error mapping
// ---------------------------------------------------------------------------

type FakeReply = {
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  statusCode?: number;
  payload?: unknown;
};

function makeReply(): FakeReply {
  const reply: FakeReply = {
    status: vi.fn((code: number) => {
      reply.statusCode = code;
      return reply;
    }),
    send: vi.fn((payload: unknown) => {
      reply.payload = payload;
      return reply;
    }),
  };
  return reply;
}

type FakeMultipartFile = {
  mimetype: string;
  filename: string;
  toBuffer: () => Promise<Buffer>;
  fields?: Record<string, { value?: unknown }>;
};

function makeTranscribeRequest(file: FakeMultipartFile | null, multipart = true): unknown {
  return {
    isMultipart: () => multipart,
    file: async () => file,
    // Fastify decorates every request with a pino child logger; the controller
    // records byte counts there so a silent microphone is diagnosable later.
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('AssistantController.transcribe', () => {
  // The controller is exercised with hand-built request/reply doubles: the
  // multipart plumbing itself belongs to @fastify/multipart, and what is ours
  // to test is the validation order and the error mapping.
  it('rejects non-multipart, missing files, alien MIME types and empty audio', async () => {
    configureEnv();
    const { AssistantController } = await import('../../../backend/api/controllers/assistant');

    const notMultipart = makeReply();
    await AssistantController.transcribe(
      makeTranscribeRequest(null, false) as never,
      notMultipart as never,
    );
    expect(notMultipart.statusCode).toBe(415);

    const noFile = makeReply();
    await AssistantController.transcribe(makeTranscribeRequest(null) as never, noFile as never);
    expect(noFile.statusCode).toBe(400);

    const alienMime = makeReply();
    await AssistantController.transcribe(
      makeTranscribeRequest({
        mimetype: 'application/pdf',
        filename: 'voice.pdf',
        toBuffer: async () => AUDIO,
      }) as never,
      alienMime as never,
    );
    expect(alienMime.statusCode).toBe(415);

    const empty = makeReply();
    await AssistantController.transcribe(
      makeTranscribeRequest({
        mimetype: 'audio/mp4',
        filename: 'voice.m4a',
        toBuffer: async () => Buffer.alloc(0),
      }) as never,
      empty as never,
    );
    expect(empty.statusCode).toBe(400);
  });

  it('maps a size-limit abort from the multipart stream onto 413', async () => {
    configureEnv();
    const { AssistantController } = await import('../../../backend/api/controllers/assistant');
    const reply = makeReply();
    await AssistantController.transcribe(
      makeTranscribeRequest({
        mimetype: 'audio/mp4',
        filename: 'voice.m4a',
        toBuffer: async () => {
          throw new Error('request file too large');
        },
      }) as never,
      reply as never,
    );
    expect(reply.statusCode).toBe(413);
  });

  it('returns the transcript envelope on success', async () => {
    configureEnv();
    stubFetch(() => jsonResponse({ text: 'Позвони Иванову' }));
    const { AssistantController } = await import('../../../backend/api/controllers/assistant');

    const reply = makeReply();
    await AssistantController.transcribe(
      makeTranscribeRequest({
        // A codec parameter must not defeat the allowlist.
        mimetype: 'audio/mp4; codecs=mp4a.40.2',
        filename: 'voice.m4a',
        toBuffer: async () => AUDIO,
      }) as never,
      reply as never,
    );

    expect(reply.statusCode).toBeUndefined();
    expect(reply.payload).toEqual({ data: { text: 'Позвони Иванову' }, meta: {} });
  });

  it('forwards the language field that arrived ahead of the file', async () => {
    configureEnv();
    const calls = stubFetch(() => jsonResponse({ text: 'Call Ivanov' }));
    const { AssistantController } = await import('../../../backend/api/controllers/assistant');

    const reply = makeReply();
    await AssistantController.transcribe(
      makeTranscribeRequest({
        mimetype: 'audio/mp4',
        filename: 'voice.m4a',
        toBuffer: async () => AUDIO,
        fields: { language: { value: 'en' } },
      }) as never,
      reply as never,
    );

    expect((calls[0].init.body as FormData).get('language')).toBe('en');
  });

  it('survives a request with no fields at all', async () => {
    configureEnv();
    const calls = stubFetch(() => jsonResponse({ text: 'Позвони' }));
    const { AssistantController } = await import('../../../backend/api/controllers/assistant');

    const reply = makeReply();
    await AssistantController.transcribe(
      makeTranscribeRequest({
        mimetype: 'audio/mp4',
        filename: 'voice.m4a',
        toBuffer: async () => AUDIO,
      }) as never,
      reply as never,
    );

    expect(reply.statusCode).toBeUndefined();
    expect((calls[0].init.body as FormData).get('language')).toBe('ru');
  });

  it('maps service failures through the shared status table', async () => {
    configureEnv({ VOICE_INPUT_CROSS_BORDER_OK: 'false' });
    const { AssistantController } = await import('../../../backend/api/controllers/assistant');

    const reply = makeReply();
    await AssistantController.transcribe(
      makeTranscribeRequest({
        mimetype: 'audio/mp4',
        filename: 'voice.m4a',
        toBuffer: async () => AUDIO,
      }) as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(503);
    expect(reply.payload).toMatchObject({ error: { code: 'SERVICE_NOT_CONFIGURED' } });
  });
});
