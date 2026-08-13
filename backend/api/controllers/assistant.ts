import { FastifyRequest, FastifyReply } from 'fastify';
import {
  MAX_USER_MESSAGE_CHARS,
  getAssistantConversation,
  listAssistantConversations,
  sendAssistantMessage,
  type AssistantCaller,
  type AssistantError,
} from '../../services/assistant';
import { isModelProviderConfigured } from '../../services/model-provider';
import { currentModelProvider } from '../../services/model-jurisdiction';
import {
  isVoiceInputConfigured,
  transcribeVoiceMessage,
} from '../../services/transcription';

// --- Local request types ---

type SendBody = {
  message: string;
  conversation_id?: string;
};

type ListQuery = {
  page?: number;
  per_page?: number;
};

type IdParams = { id: string };

// --- Helpers ---

function callerFrom(request: FastifyRequest): AssistantCaller {
  return {
    sub: request.user.sub,
    org_id: request.user.org_id,
    role: request.user.role,
    sid: request.user.sid,
  };
}

// The assistant service never throws for provider problems — it returns a
// structured code. Map each one onto the status that describes whose problem
// it is, so the client can distinguish "not set up" from "try again".
function statusForError(code: AssistantError['code']): number {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'CONVERSATION_NOT_FOUND':
      return 404;
    case 'AI_RATE_LIMITED':
      return 429;
    case 'AI_TIMEOUT':
      return 504;
    case 'SERVICE_NOT_CONFIGURED':
    case 'AI_UNAUTHORIZED':
      return 503;
    default:
      return 502;
  }
}

// --- Handlers ---

async function status(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  void request;
  reply.send({
    data: {
      configured: isModelProviderConfigured(),
      provider: currentModelProvider(),
      max_message_length: MAX_USER_MESSAGE_CHARS,
      // Drives the microphone button in the app: false hides it entirely, so
      // an unconfigured install never records anything it cannot transcribe.
      voice_input: isVoiceInputConfigured(),
    },
    meta: {},
  });
}

// Container MIME types the mobile recorder can actually produce (AAC in an
// mp4/m4a container on both platforms), plus the common encodings a future
// web client would send. Everything else is refused before any bytes travel.
const VOICE_MIME_ALLOWLIST = new Set([
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg',
  'audio/3gpp',
]);

async function transcribe(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.isMultipart()) {
    reply.status(415).send({
      error: { code: 'VALIDATION_ERROR', message: 'Ожидается multipart/form-data с аудиофайлом' },
    });
    return;
  }

  const file = await request.file();
  if (!file) {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'Аудиофайл не найден в запросе' },
    });
    return;
  }

  const mimeType = file.mimetype.split(';')[0].trim().toLowerCase();
  if (!VOICE_MIME_ALLOWLIST.has(mimeType)) {
    reply.status(415).send({
      error: { code: 'VALIDATION_ERROR', message: 'Неподдерживаемый формат аудио' },
    });
    return;
  }

  let audio: Buffer;
  try {
    audio = await file.toBuffer();
  } catch {
    // @fastify/multipart throws when the stream exceeds the fileSize limit.
    reply.status(413).send({
      error: { code: 'VALIDATION_ERROR', message: 'Аудиофайл слишком большой' },
    });
    return;
  }

  if (audio.byteLength === 0) {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'Получен пустой аудиофайл' },
    });
    return;
  }

  const result = await transcribeVoiceMessage(audio, {
    mimeType,
    filename: file.filename,
  });

  if (!result.ok) {
    reply.status(statusForError(result.error.code)).send({
      error: { code: result.error.code, message: result.error.message },
    });
    return;
  }

  reply.send({ data: { text: result.text }, meta: {} });
}

async function send(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { message, conversation_id } = request.body as SendBody;

  const result = await sendAssistantMessage(callerFrom(request), {
    message,
    ...(conversation_id ? { conversation_id } : {}),
  });

  if (!result.ok) {
    reply.status(statusForError(result.error.code)).send({
      error: { code: result.error.code, message: result.error.message },
    });
    return;
  }

  const { turn } = result;

  reply.send({
    data: {
      conversation_id: turn.conversation_id,
      conversation_title: turn.conversation_title,
      message: turn.message,
      tool_calls: turn.tool_calls,
    },
    meta: {
      rounds: turn.rounds,
      usage: turn.usage,
      model_version: turn.model_version,
    },
  });
}

async function listConversations(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = request.query as ListQuery;
  const page = query.page && query.page > 0 ? Math.floor(query.page) : 1;
  const per_page = query.per_page && query.per_page > 0 ? Math.min(100, Math.floor(query.per_page)) : 20;

  const { data, total } = await listAssistantConversations(callerFrom(request), { page, per_page });

  reply.send({ data, meta: { total, page, per_page } });
}

async function getConversation(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;

  const conversation = await getAssistantConversation(callerFrom(request), id);

  if (!conversation) {
    reply.status(404).send({
      error: { code: 'CONVERSATION_NOT_FOUND', message: 'Диалог не найден' },
    });
    return;
  }

  reply.send({
    data: conversation,
    meta: { total: conversation.messages.length },
  });
}

// --- Export ---

export const AssistantController = {
  status,
  send,
  transcribe,
  listConversations,
  getConversation,
};
