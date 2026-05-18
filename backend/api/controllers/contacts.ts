import { FastifyRequest, FastifyReply } from 'fastify';
import { CalendarEventStatus, ContactStatus, Prisma, TaskStatus, WorkflowTrigger } from '@prisma/client';
import { db } from '../../services/db';
import { evaluateWorkflows } from '../../services/workflows';

type ContactBody = {
  first_name: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  tags?: string[];
  source?: string;
  notes?: string;
  assigned_to?: string;
  type?: 'lead' | 'customer' | 'partner' | 'other';
  custom_fields?: Prisma.InputJsonValue;
};

type BulkArchiveBody = {
  contact_ids: string[];
};

type BulkAssignBody = BulkArchiveBody & {
  assigned_to: string;
};

type BulkTagBody = BulkArchiveBody & {
  tags: string[];
  mode?: 'append' | 'replace';
};

type ContactImportRow = {
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

type BusinessCardBody = {
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

class ServiceNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceNotConfiguredError';
  }
}

function optionalTrimmedString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function phoneMatchKeys(value: string | null | undefined): Set<string> {
  const digits = value?.replace(/\D/g, '') ?? '';
  const keys = new Set<string>();

  if (!digits) {
    return keys;
  }

  keys.add(digits);

  if (digits.length === 10) {
    keys.add(`7${digits}`);
    keys.add(`8${digits}`);
  }

  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    const nationalNumber = digits.slice(1);
    keys.add(nationalNumber);
    keys.add(`7${nationalNumber}`);
    keys.add(`8${nationalNumber}`);
  }

  return keys;
}

function hasMatchingPhone(contact: { phone: string | null; mobile: string | null }, searchKeys: Set<string>): boolean {
  const contactKeys = new Set<string>([...phoneMatchKeys(contact.phone), ...phoneMatchKeys(contact.mobile)]);
  return [...contactKeys].some((key) => searchKeys.has(key));
}

function getYandexConfig(serviceName: 'Vision' | 'SpeechKit'): { apiKey: string; folderId: string } {
  const apiKey = process.env.YANDEX_API_KEY?.trim();
  const folderId = process.env.YANDEX_FOLDER_ID?.trim();
  if (!apiKey || !folderId) {
    throw new ServiceNotConfiguredError(`Yandex ${serviceName} API not configured`);
  }

  return { apiKey, folderId };
}

function sendServiceNotConfigured(reply: FastifyReply, error: ServiceNotConfiguredError): void {
  reply.code(503).send({
    error: {
      code: 'SERVICE_NOT_CONFIGURED',
      message: error.message,
    },
  });
}

async function userBelongsToOrg(userId: string, orgId: string): Promise<boolean> {
  const user = await db.user.findFirst({
    where: { id: userId, organization_id: orgId },
    select: { id: true },
  });
  return user !== null;
}

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

function parseBusinessCardFields(text: string): BusinessCardFields {
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

function parseBusinessCardText(text: string): ContactImportRow {
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

async function extractTextWithYandexVision(imageBase64: string): Promise<string> {
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

function audioBodyToBuffer(body: unknown): Buffer | null {
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

async function transcribeWithYandexSpeechKit(audioBytes: Buffer): Promise<string> {
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

function extractKeywordValue(text: string, keywords: string[]): string | null {
  const pattern = new RegExp(`(?:${keywords.join('|')})\\s*[:\\-]?\\s*([^,.\\n;]+)`, 'i');
  return text.match(pattern)?.[1]?.trim() ?? null;
}

function extractVoiceFields(transcript: string): VoiceFields {
  const phone = transcript.match(/(?:\+7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/)?.[0]?.trim() ?? null;
  const name = extractKeywordValue(transcript, ['имя', 'зовут', 'меня зовут']);
  const company = extractKeywordValue(transcript, ['компания']);

  return {
    name: name ? toTitleCase(name) : null,
    phone,
    notes: company ? `Компания: ${company}. ${transcript}` : transcript || null,
  };
}

function extractSpeechFields(transcript: string): VoiceFields {
  const phone = transcript.match(/(?:\+7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/)?.[0]?.trim() ?? null;
  const name = extractKeywordValue(transcript, ['menya zovut', 'zovut', 'imya', 'menya', 'меня зовут', 'зовут', 'имя', 'меня']);

  return {
    name: name ? toTitleCase(name) : null,
    phone,
    notes: transcript || null,
  };
}

export const ContactsController = {
  list: async (request: FastifyRequest, reply: FastifyReply) => {
    const { q, status, type, assigned_to, tag, phone, page, per_page, sort, order } = request.query as {
      q?: string;
      status?: 'active' | 'inactive' | 'archived';
      type?: 'lead' | 'customer' | 'partner' | 'other';
      assigned_to?: string;
      tag?: string;
      phone?: string;
      source?: string;
      page: number;
      per_page: number;
      sort: 'created_at' | 'updated_at' | 'first_name' | 'company';
      order: 'asc' | 'desc';
    };

    const where: Prisma.ContactWhereInput = {
      organization_id: request.user.org_id,
      status: status ?? { not: ContactStatus.archived },
      ...(type && { type }),
      ...(assigned_to && { assigned_to }),
      ...(tag && { tags: { array_contains: tag } }),
      ...(q && {
        OR: [
          { first_name: { contains: q, mode: 'insensitive' } },
          { last_name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { company: { contains: q, mode: 'insensitive' } },
        ],
      }),
    };

    if (phone !== undefined) {
      const searchKeys = phoneMatchKeys(phone);

      if (searchKeys.size === 0) {
        return reply.send({ data: [], meta: { total: 0, page, per_page } });
      }

      const contacts = await db.contact.findMany({
        where,
        orderBy: { [sort]: order },
      });
      const matchedContacts = contacts.filter((contact) => hasMatchingPhone(contact, searchKeys));
      const start = (page - 1) * per_page;
      const paginatedContacts = matchedContacts.slice(start, start + per_page);

      return reply.send({ data: paginatedContacts, meta: { total: matchedContacts.length, page, per_page } });
    }

    const [contacts, total] = await Promise.all([
      db.contact.findMany({
        where,
        skip: (page - 1) * per_page,
        take: per_page,
        orderBy: { [sort]: order },
      }),
      db.contact.count({ where }),
    ]);

    return reply.send({ data: contacts, meta: { total, page, per_page } });
  },

  create: async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ContactBody;

    if (body.assigned_to !== undefined && body.assigned_to !== request.user.sub) {
      const ownsAssignee = await userBelongsToOrg(body.assigned_to, request.user.org_id);
      if (!ownsAssignee) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Assigned user does not belong to your organization' },
        });
      }
    }

    const data: Prisma.ContactUncheckedCreateInput = {
      first_name: body.first_name,
      last_name: body.last_name,
      company: body.company,
      email: body.email,
      phone: body.phone,
      mobile: body.mobile,
      tags: body.tags,
      source: body.source,
      notes: body.notes,
      assigned_to: body.assigned_to,
      type: body.type,
      custom_fields: body.custom_fields,
      organization_id: request.user.org_id,
      created_by: request.user.sub,
    };

    const contact = await db.contact.create({ data });

    await evaluateWorkflows({
      organizationId: request.user.org_id,
      trigger: WorkflowTrigger.contact_created,
      record: contact as unknown as Record<string, unknown>,
      userId: request.user.sub,
      triggerRecordId: contact.id,
    });

    return reply.code(201).send({ data: contact, meta: {} });
  },

  getById: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
      include: { assignee: { select: { id: true, name: true } } },
    });

    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    return reply.send({ data: contact });
  },

  update: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const existing = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });

    if (!existing || existing.status === ContactStatus.archived) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const body = request.body as Partial<ContactBody>;

    if (body.assigned_to !== undefined && body.assigned_to !== request.user.sub) {
      const ownsAssignee = await userBelongsToOrg(body.assigned_to, request.user.org_id);
      if (!ownsAssignee) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Assigned user does not belong to your organization' },
        });
      }
    }

    const updateData: Prisma.ContactUncheckedUpdateInput = {};
    if (body.first_name !== undefined) updateData.first_name = body.first_name;
    if (body.last_name !== undefined) updateData.last_name = body.last_name;
    if (body.company !== undefined) updateData.company = body.company;
    if (body.email !== undefined) updateData.email = body.email;
    if (body.phone !== undefined) updateData.phone = body.phone;
    if (body.mobile !== undefined) updateData.mobile = body.mobile;
    if (body.tags !== undefined) updateData.tags = body.tags;
    if (body.source !== undefined) updateData.source = body.source;
    if (body.notes !== undefined) updateData.notes = body.notes;
    if (body.assigned_to !== undefined) updateData.assigned_to = body.assigned_to;
    if (body.type !== undefined) updateData.type = body.type;
    if (body.custom_fields !== undefined) updateData.custom_fields = body.custom_fields;

    const contact = await db.contact.update({ where: { id }, data: updateData });

    return reply.send({ data: contact });
  },

  archive: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const existing = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });

    if (!existing) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const contact = await db.contact.update({ where: { id }, data: { status: 'archived' } });

    return reply.send({ data: contact });
  },

  getActivity: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });
    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const [messages, tasks, events] = await Promise.all([
      db.message.findMany({
        where: { contact_id: id, organization_id: request.user.org_id },
        select: { id: true, body: true, channel: true, created_at: true },
      }),
      db.task.findMany({
        where: { contact_id: id, organization_id: request.user.org_id },
        select: { id: true, title: true, created_at: true },
      }),
      db.calendarEvent.findMany({
        where: { contact_id: id, organization_id: request.user.org_id },
        select: { id: true, title: true, created_at: true },
      }),
    ]);

    const items = [
      ...messages.map(m => ({ type: 'message' as const, id: m.id, summary: m.body, created_at: m.created_at })),
      ...tasks.map(t => ({ type: 'task' as const, id: t.id, summary: t.title, created_at: t.created_at })),
      ...events.map(e => ({ type: 'meeting' as const, id: e.id, summary: e.title, created_at: e.created_at })),
    ].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

    return reply.send({ data: { contact_id: id, items } });
  },

  getDeals: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });
    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const deals = await db.deal.findMany({
      where: { contact_id: id, organization_id: request.user.org_id },
      include: {
        pipeline: { select: { id: true, name: true } },
        stage: { select: { id: true, name: true, position: true } },
      },
    });

    return reply.send({ data: deals });
  },

  getTasks: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });
    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const tasks = await db.task.findMany({
      where: {
        contact_id: id,
        organization_id: request.user.org_id,
        status: { not: TaskStatus.cancelled },
      },
      orderBy: { due_date: 'asc' },
    });

    return reply.send({ data: tasks });
  },

  getMessages: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });
    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const messages = await db.message.findMany({
      where: { contact_id: id, organization_id: request.user.org_id },
      orderBy: { created_at: 'desc' },
    });

    return reply.send({ data: messages });
  },
  merge: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { source_id } = request.body as { source_id: string };
    const org_id = request.user.org_id;

    if (source_id === id) {
      return reply.code(422).send({
        error: { code: 'INVALID_MERGE', message: 'Source and target must be different contacts' },
      });
    }

    const source = await db.contact.findFirst({
      where: { id: source_id, organization_id: org_id },
    });
    if (!source) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Source contact not found' } });
    }

    const target = await db.contact.findFirst({
      where: { id, organization_id: org_id },
    });
    if (!target) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    await db.$transaction(async (tx) => {
      await tx.deal.updateMany({
        where: { contact_id: source.id, organization_id: org_id },
        data: { contact_id: target.id },
      });
      await tx.task.updateMany({
        where: { contact_id: source.id, organization_id: org_id },
        data: { contact_id: target.id },
      });
      await tx.message.updateMany({
        where: { contact_id: source.id, organization_id: org_id },
        data: { contact_id: target.id },
      });
      await tx.calendarEvent.updateMany({
        where: { contact_id: source.id, organization_id: org_id },
        data: { contact_id: target.id },
      });
      await tx.contact.update({
        where: { id: source.id },
        data: { status: 'archived' },
      });
    });

    const updated = await db.contact.findFirst({
      where: { id: target.id, organization_id: org_id },
      include: { assignee: { select: { id: true, name: true } } },
    });

    return reply.send({ data: updated ?? target });
  },
  getCalendarEvents: async (_request: FastifyRequest, reply: FastifyReply) => {
    const request = _request;
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
      select: { id: true },
    });

    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const events = await db.calendarEvent.findMany({
      where: {
        contact_id: id,
        organization_id: request.user.org_id,
        status: { not: CalendarEventStatus.cancelled },
      },
      orderBy: { start_time: 'asc' },
    });

    return reply.send({ data: events, meta: { total: events.length } });
  },
  importCsv: async (request: FastifyRequest, reply: FastifyReply) => {
    const rows = request.body as ContactImportRow[];

    const data: Prisma.ContactCreateManyInput[] = rows.map(row => ({
      organization_id: request.user.org_id,
      created_by: request.user.sub,
      first_name: row.first_name.trim(),
      last_name: optionalTrimmedString(row.last_name),
      company: optionalTrimmedString(row.company),
      email: optionalTrimmedString(row.email),
      phone: optionalTrimmedString(row.phone),
      mobile: optionalTrimmedString(row.mobile),
      source: optionalTrimmedString(row.source),
      notes: optionalTrimmedString(row.notes),
      type: row.type,
    }));

    const result = await db.$transaction(async (tx) => tx.contact.createMany({ data }));

    return reply.code(201).send({ data: { imported_count: result.count }, meta: {} });
  },
  importFromPhone: async (request: FastifyRequest, reply: FastifyReply) => {
    const rows = request.body as ContactImportRow[];

    const data: Prisma.ContactCreateManyInput[] = rows.map(row => ({
      organization_id: request.user.org_id,
      created_by: request.user.sub,
      first_name: row.first_name.trim(),
      last_name: optionalTrimmedString(row.last_name),
      company: optionalTrimmedString(row.company),
      email: optionalTrimmedString(row.email),
      phone: optionalTrimmedString(row.phone),
      mobile: optionalTrimmedString(row.mobile),
      source: optionalTrimmedString(row.source) ?? 'phone_contacts',
      notes: optionalTrimmedString(row.notes),
      type: row.type,
    }));

    const result = await db.$transaction(async (tx) => tx.contact.createMany({ data }));

    return reply.code(201).send({ data: { imported_count: result.count }, meta: {} });
  },
  bulkAssign: async (request: FastifyRequest, reply: FastifyReply) => {
    const { contact_ids, assigned_to } = request.body as BulkAssignBody;
    const orgId = request.user.org_id;
    const uniqueContactIds = Array.from(new Set(contact_ids));

    if (assigned_to !== request.user.sub) {
      const ownsAssignee = await userBelongsToOrg(assigned_to, orgId);
      if (!ownsAssignee) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Assigned user does not belong to your organization' },
        });
      }
    }

    const contacts = await db.contact.findMany({
      where: {
        id: { in: uniqueContactIds },
        organization_id: orgId,
        status: { not: ContactStatus.archived },
      },
      select: { id: true },
    });

    if (contacts.length !== uniqueContactIds.length) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'One or more contacts not found' } });
    }

    const result = await db.contact.updateMany({
      where: {
        id: { in: uniqueContactIds },
        organization_id: orgId,
        status: { not: ContactStatus.archived },
      },
      data: { assigned_to },
    });

    return reply.send({
      data: { assigned_count: result.count, assigned_to, contact_ids: uniqueContactIds },
      meta: {},
    });
  },
  bulkTag: async (request: FastifyRequest, reply: FastifyReply) => {
    const { contact_ids, tags, mode } = request.body as BulkTagBody;
    const orgId = request.user.org_id;
    const uniqueContactIds = Array.from(new Set(contact_ids));

    const contacts = await db.contact.findMany({
      where: {
        id: { in: uniqueContactIds },
        organization_id: orgId,
        status: { not: ContactStatus.archived },
      },
      select: { id: true, tags: true },
    });

    if (contacts.length !== uniqueContactIds.length) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'One or more contacts not found' } });
    }

    await db.$transaction(
      contacts.map((contact) => {
        const existingTags = Array.isArray(contact.tags) ? contact.tags.filter((tag): tag is string => typeof tag === 'string') : [];
        const nextTags = mode === 'replace' ? tags : Array.from(new Set([...existingTags, ...tags]));
        return db.contact.update({
          where: { id: contact.id },
          data: { tags: nextTags },
        });
      }),
    );

    return reply.send({
      data: { tagged_count: contacts.length, contact_ids: uniqueContactIds, tags, mode: mode ?? 'append' },
      meta: {},
    });
  },
  bulkArchive: async (request: FastifyRequest, reply: FastifyReply) => {
    const { contact_ids } = request.body as BulkArchiveBody;
    const orgId = request.user.org_id;
    const uniqueContactIds = Array.from(new Set(contact_ids));

    const contacts = await db.contact.findMany({
      where: {
        id: { in: uniqueContactIds },
        organization_id: orgId,
        status: { not: ContactStatus.archived },
      },
      select: { id: true },
    });

    if (contacts.length !== uniqueContactIds.length) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'One or more contacts not found' } });
    }

    const result = await db.contact.updateMany({
      where: {
        id: { in: uniqueContactIds },
        organization_id: orgId,
        status: { not: ContactStatus.archived },
      },
      data: { status: ContactStatus.archived },
    });

    return reply.send({
      data: { archived_count: result.count, contact_ids: uniqueContactIds },
      meta: {},
    });
  },
  transcribeVoice: async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      getYandexConfig('SpeechKit');

      const audioBytes = audioBodyToBuffer(request.body);
      if (!audioBytes || audioBytes.byteLength === 0) {
        return reply.code(400).send({
          error: { code: 'AUDIO_INPUT_REQUIRED', message: 'Provide raw audio bytes' },
        });
      }

      const transcript = await transcribeWithYandexSpeechKit(audioBytes);
      return reply.send({
        data: {
          transcript,
          fields: extractSpeechFields(transcript),
        },
        meta: {},
      });
    } catch (error) {
      if (error instanceof ServiceNotConfiguredError) {
        return sendServiceNotConfigured(reply, error);
      }

      return reply.code(502).send({
        error: {
          code: 'SPEECH_API_ERROR',
          message: error instanceof Error ? error.message : 'Voice transcription failed',
        },
      });
    }
  },
  scanBusinessCard: async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as BusinessCardBody;

    try {
      const rawText = body.text?.trim() || (body.image_base64 ? await extractTextWithYandexVision(body.image_base64) : '');
      if (!rawText) {
        return reply.code(400).send({
          error: { code: 'OCR_INPUT_REQUIRED', message: 'Provide text or image_base64' },
        });
      }

      const fields = parseBusinessCardFields(rawText);
      const extracted = parseBusinessCardText(rawText);
      let contact = null;

      if (body.create_contact === true) {
        contact = await db.contact.create({
          data: {
            organization_id: request.user.org_id,
            created_by: request.user.sub,
            first_name: extracted.first_name,
            last_name: extracted.last_name,
            company: extracted.company,
            email: extracted.email,
            phone: extracted.phone,
            source: extracted.source,
            notes: extracted.notes,
          },
        });

        await evaluateWorkflows({
          organizationId: request.user.org_id,
          trigger: WorkflowTrigger.contact_created,
          record: contact as unknown as Record<string, unknown>,
          userId: request.user.sub,
          triggerRecordId: contact.id,
        });
      }

      return reply.send({ data: { ...fields, raw_text: rawText, extracted, contact }, meta: {} });
    } catch (error) {
      if (error instanceof ServiceNotConfiguredError) {
        return sendServiceNotConfigured(reply, error);
      }

      return reply.code(502).send({
        error: {
          code: 'VISION_API_ERROR',
          message: error instanceof Error ? error.message : 'Business card OCR failed',
        },
      });
    }
  },
};
