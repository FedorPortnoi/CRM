import { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../services/db';
import { tgSendCode, tgVerifyAndPull } from '../../services/importTelegram';
import { importFromBitrix24 } from '../../services/importBitrix24';

// ── Telegram ─────────────────────────────────────────────────────────────────

async function telegramSendCode(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { phone } = request.body as { phone: string };

  try {
    const result = await tgSendCode(phone);
    reply.send({ data: result, meta: {} });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка отправки кода';
    reply.status(502).send({ error: { code: 'TG_SEND_CODE_FAILED', message: msg } });
  }
}

async function telegramVerify(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { phone, code, phoneCodeHash } = request.body as { phone: string; code: string; phoneCodeHash: string };

  try {
    const { session, contacts } = await tgVerifyAndPull(phone, code, phoneCodeHash);

    // Save session in user preferences (encrypted storage already in DB)
    const user = await db.user.findUnique({ where: { id: request.user.sub }, select: { preferences: true } });
    const prefs = (user?.preferences as Record<string, unknown>) ?? {};
    await db.user.update({
      where: { id: request.user.sub },
      data: { preferences: { ...prefs, tg_session: session } },
    });

    // Import contacts into CRM
    const imported: string[] = [];
    const failed: string[] = [];

    for (const c of contacts) {
      if (!c.first_name && !c.phone) continue;
      try {
        await db.contact.create({
          data: {
            organization_id: request.user.org_id,
            created_by: request.user.sub,
            first_name: c.first_name || 'Telegram',
            last_name: c.last_name || undefined,
            phone: c.phone || undefined,
            source: 'telegram',
            notes: c.username ? `Telegram: @${c.username}` : undefined,
          },
        });
        imported.push(c.first_name);
      } catch {
        failed.push(c.first_name);
      }
    }

    reply.send({
      data: { imported: imported.length, failed: failed.length, total: contacts.length },
      meta: {},
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка верификации';
    const code = msg.includes('PHONE_CODE_INVALID') ? 'INVALID_CODE'
      : msg.includes('PHONE_CODE_EXPIRED') ? 'CODE_EXPIRED'
      : 'TG_VERIFY_FAILED';
    reply.status(400).send({ error: { code, message: msg } });
  }
}

// ── Bitrix24 ─────────────────────────────────────────────────────────────────

async function bitrix24Import(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { webhook_url, include_deals = true } = request.body as { webhook_url: string; include_deals?: boolean };

  try {
    const result = await importFromBitrix24(webhook_url, request.user.org_id, request.user.sub, include_deals);
    reply.send({ data: result, meta: {} });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка импорта из Bitrix24';
    reply.status(502).send({ error: { code: 'BITRIX24_IMPORT_FAILED', message: msg } });
  }
}

// ── vCard (parsed client-side, bulk create server-side) ──────────────────────

interface VCardContact {
  first_name: string;
  last_name?: string;
  phone?: string;
  email?: string;
  company?: string;
}

async function vcardImport(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { contacts } = request.body as { contacts: VCardContact[] };

  if (!Array.isArray(contacts) || contacts.length === 0) {
    reply.status(400).send({ error: { code: 'NO_CONTACTS', message: 'Нет контактов для импорта' } });
    return;
  }

  let imported = 0;
  let failed = 0;

  for (const c of contacts) {
    if (!c.first_name) { failed++; continue; }
    try {
      await db.contact.create({
        data: {
          organization_id: request.user.org_id,
          created_by: request.user.sub,
          first_name: c.first_name,
          last_name: c.last_name || undefined,
          phone: c.phone || undefined,
          email: c.email || undefined,
          company: c.company || undefined,
          source: 'vcard',
        },
      });
      imported++;
    } catch {
      failed++;
    }
  }

  reply.send({ data: { imported, failed, total: contacts.length }, meta: {} });
}

// ── WhatsApp (parsed client-side, contacts bulk create) ──────────────────────

async function whatsappImport(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { contacts } = request.body as { contacts: Array<{ name: string; phone?: string; message_count?: number }> };

  if (!Array.isArray(contacts) || contacts.length === 0) {
    reply.status(400).send({ error: { code: 'NO_CONTACTS', message: 'Нет контактов для импорта' } });
    return;
  }

  let imported = 0;
  let failed = 0;

  for (const c of contacts) {
    if (!c.name) { failed++; continue; }
    const parts = c.name.trim().split(' ');
    try {
      await db.contact.create({
        data: {
          organization_id: request.user.org_id,
          created_by: request.user.sub,
          first_name: parts[0] ?? c.name,
          last_name: parts.slice(1).join(' ') || undefined,
          phone: c.phone || undefined,
          source: 'whatsapp',
          notes: c.message_count ? `${c.message_count} сообщений в WhatsApp` : undefined,
        },
      });
      imported++;
    } catch {
      failed++;
    }
  }

  reply.send({ data: { imported, failed, total: contacts.length }, meta: {} });
}

export const ImportsController = {
  telegramSendCode,
  telegramVerify,
  bitrix24Import,
  vcardImport,
  whatsappImport,
};
