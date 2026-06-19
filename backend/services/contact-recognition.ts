import { WorkflowTrigger } from '@prisma/client';
import { db } from './db';
import { encryptField, decryptField } from './encryption';
import { evaluateWorkflows } from './workflows';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ContactImportRow = {
  first_name: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  source?: string;
  notes?: string;
  type?: 'lead' | 'customer' | 'partner' | 'other';
};

export type BusinessCardBody = {
  text?: string;
  image_base64?: string;
  create_contact?: boolean;
};

type BusinessCardFields = {
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
};

type VoiceFields = {
  name: string | null;
  phone: string | null;
  notes: string | null;
};

// ---------------------------------------------------------------------------
// Yandex API types
// ---------------------------------------------------------------------------

type YandexVisionWord = {
  text?: string;
};

type YandexVisionLine = {
  text?: string;
  words?: YandexVisionWord[];
};

type YandexVisionBlock = {
  text?: string;
  lines?: YandexVisionLine[];
};

type YandexVisionPage = {
  blocks?: YandexVisionBlock[];
};

type YandexVisionResponse = {
  results?: Array<{
    results?: Array<{
      textDetection?: {
        pages?: YandexVisionPage[];
      };
    }>;
  }>;
  error?: { message?: string };
};

type YandexSpeechResponse = {
  result?: string;
  error?: { message?: string };
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ServiceNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceNotConfiguredError';
  }
}

// ---------------------------------------------------------------------------
// Yandex helpers
// ---------------------------------------------------------------------------

function getYandexConfig(serviceName: 'Vision' | 'SpeechKit'): { apiKey: string; folderId: string } {
  const apiKey = process.env.YANDEX_API_KEY?.trim();
  const folderId = process.env.YANDEX_FOLDER_ID?.trim();
  if (!apiKey || !folderId) {
    throw new ServiceNotConfiguredError(`Yandex ${serviceName} API not configured`);
  }

  return { apiKey, folderId };
}

function collectYandexVisionText(body: YandexVisionResponse): string {
  const texts: string[] = [];
  for (const result of body.results ?? []) {
    for (const analysis of result.results ?? []) {
      for (const page of analysis.textDetection?.pages ?? []) {
        for (const block of page.blocks ?? []) {
          const blockTexts: string[] = [];
          for (const line of block.lines ?? []) {
            const words = (line.words ?? []).map((word) => word.text).filter((word): word is string => Boolean(word));
            if (words.length > 0) {
              blockTexts.push(words.join(' '));
            } else if (line.text) {
              blockTexts.push(line.text);
            }
          }

          if (blockTexts.length > 0) {
            texts.push(blockTexts.join('\n'));
          } else if (block.text) {
            texts.push(block.text);
          }
        }
      }
    }
  }

  return texts.join('\n').trim();
}

export async function extractTextWithYandexVision(imageBase64: string): Promise<string> {
  const { apiKey, folderId } = getYandexConfig('Vision');

  const response = await fetch('https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze', {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      folderId,
      analyzeSpecs: [
        {
          content: imageBase64,
          features: [
            {
              type: 'TEXT_DETECTION',
              textDetectionConfig: { languageCodes: ['ru', 'en'] },
            },
          ],
        },
      ],
    }),
  });

  const body = await response.json() as YandexVisionResponse;

  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? 'Yandex Vision OCR failed');
  }

  return collectYandexVisionText(body);
}

export function audioBodyToBuffer(body: unknown): Buffer | null {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }

  if (typeof body === 'string' && body.length > 0) {
    return Buffer.from(body, 'binary');
  }

  if (typeof body === 'object' && body !== null && 'audio_base64' in body) {
    const audioBase64 = (body as { audio_base64?: unknown }).audio_base64;
    if (typeof audioBase64 === 'string' && audioBase64.trim()) {
      return Buffer.from(audioBase64, 'base64');
    }
  }

  return null;
}

export async function transcribeWithYandexSpeechKit(audioBytes: Buffer): Promise<string> {
  const { apiKey, folderId } = getYandexConfig('SpeechKit');
  const query = new URLSearchParams({
    folderId,
    lang: 'ru-RU',
    format: 'lpcm',
    sampleRateHertz: '16000',
  });
  const response = await fetch(`https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?${query.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      'Content-Type': 'audio/x-pcm;bit=16;rate=16000',
    },
    body: new Uint8Array(audioBytes),
  });

  const body = await response.json() as YandexSpeechResponse;
  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? 'Yandex SpeechKit transcription failed');
  }

  return body.result ?? '';
}

// ---------------------------------------------------------------------------
// Text parsing helpers
// ---------------------------------------------------------------------------

function isAllCapsBusinessLine(line: string): boolean {
  const letters = line.match(/[A-ZА-ЯЁ]/g);
  if (!letters || letters.length < 2) {
    return false;
  }

  return line === line.toLocaleUpperCase('ru-RU') && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(line);
}

function isTitleCaseWord(word: string): boolean {
  const letters = word.replace(/[^A-Za-zА-Яа-яЁё-]/g, '');
  if (!letters) {
    return false;
  }

  const [firstLetter] = Array.from(letters);
  const rest = Array.from(letters).slice(1).join('');
  return firstLetter === firstLetter.toLocaleUpperCase('ru-RU') && rest === rest.toLocaleLowerCase('ru-RU');
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const [firstLetter] = Array.from(word);
      if (!firstLetter) {
        return word;
      }

      return firstLetter.toLocaleUpperCase('ru-RU') + Array.from(word).slice(1).join('').toLocaleLowerCase('ru-RU');
    })
    .join(' ');
}

function isLikelyNameLine(line: string, email: string | null, phone: string | null): boolean {
  if (line === email || line === phone || /https?:\/\/|www\.|@/i.test(line) || isAllCapsBusinessLine(line)) {
    return false;
  }

  const words = line.split(/\s+/).filter(Boolean);
  return line.length > 3 && words.length > 0 && words.length <= 4 && words.every(isTitleCaseWord);
}

function isLikelyCompanyLine(line: string, nameLine: string | null, email: string | null, phone: string | null): boolean {
  return (
    line !== nameLine &&
    line !== email &&
    line !== phone &&
    !/https?:\/\/|www\.|@/i.test(line) &&
    !/(?:\+?\d[\d\s().-]{7,}\d)/.test(line)
  );
}

export function parseBusinessCardFields(text: string): BusinessCardFields {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.join(' ');
  const email = joined.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  const phone = (
    joined.match(/(?:\+7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/)?.[0] ??
    joined.match(/(?:\+?\d[\d\s().-]{7,}\d)/)?.[0] ??
    null
  )?.trim() ?? null;
  const nameLine = lines.find((line) => isLikelyNameLine(line, email, phone)) ?? null;
  const company =
    lines.find((line) => isLikelyCompanyLine(line, nameLine, email, phone) && isAllCapsBusinessLine(line)) ??
    lines.find((line) => isLikelyCompanyLine(line, nameLine, email, phone)) ??
    null;

  return {
    name: nameLine ? toTitleCase(nameLine) : null,
    phone,
    email,
    company,
  };
}

export function parseBusinessCardText(text: string): ContactImportRow {
  const fields = parseBusinessCardFields(text);
  const fullName = fields.name ?? 'Unknown';
  const [firstName, ...restName] = fullName.split(/\s+/);

  return {
    first_name: firstName || 'Unknown',
    last_name: restName.length > 0 ? restName.join(' ') : undefined,
    company: fields.company ?? undefined,
    email: fields.email ?? undefined,
    phone: fields.phone ?? undefined,
    source: 'business_card',
    notes: text,
  };
}

function extractKeywordValue(text: string, keywords: string[]): string | null {
  const pattern = new RegExp(`(?:${keywords.join('|')})\\s*[:\\-]?\\s*([^,.\\n;]+)`, 'i');
  return text.match(pattern)?.[1]?.trim() ?? null;
}

export function extractSpeechFields(transcript: string): VoiceFields {
  const phone = transcript.match(/(?:\+7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/)?.[0]?.trim() ?? null;
  const name = extractKeywordValue(transcript, ['menya zovut', 'zovut', 'imya', 'menya', 'меня зовут', 'зовут', 'имя', 'меня']);

  return {
    name: name ? toTitleCase(name) : null,
    phone,
    notes: transcript || null,
  };
}

// ---------------------------------------------------------------------------
// Main service function
// ---------------------------------------------------------------------------

type ScannedContact = {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  [key: string]: unknown;
};

export type BusinessCardScanResult = {
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  raw_text: string;
  extracted: ContactImportRow;
  contact: ScannedContact | null;
};

function decryptScannedContact(c: ScannedContact): ScannedContact {
  return {
    ...c,
    email: decryptField(c.email ?? undefined) ?? null,
    phone: decryptField(c.phone ?? undefined) ?? null,
    mobile: decryptField(c.mobile ?? undefined) ?? null,
  };
}

export async function scanBusinessCard(
  orgId: string,
  userId: string,
  body: BusinessCardBody,
): Promise<BusinessCardScanResult> {
  const rawText = body.text?.trim() || (body.image_base64 ? await extractTextWithYandexVision(body.image_base64) : '');

  if (!rawText) {
    const err = new Error('Provide text or image_base64') as Error & { code: string; status: number };
    err.code = 'OCR_INPUT_REQUIRED';
    err.status = 400;
    throw err;
  }

  const fields = parseBusinessCardFields(rawText);
  const extracted = parseBusinessCardText(rawText);
  let contact: ScannedContact | null = null;

  if (body.create_contact === true) {
    const created = await db.contact.create({
      data: {
        organization_id: orgId,
        created_by: userId,
        first_name: extracted.first_name,
        last_name: extracted.last_name,
        company: extracted.company,
        email: extracted.email ? encryptField(extracted.email) : undefined,
        phone: extracted.phone ? encryptField(extracted.phone) : undefined,
        source: extracted.source,
        notes: extracted.notes,
      },
    });

    await evaluateWorkflows({
      organizationId: orgId,
      trigger: WorkflowTrigger.contact_created,
      record: created as unknown as Record<string, unknown>,
      userId,
      triggerRecordId: created.id,
    });

    contact = decryptScannedContact(created as unknown as ScannedContact);
  }

  return { ...fields, raw_text: rawText, extracted, contact };
}
