/**
 * lead-inbox.ts
 *
 * Inbound lead mailboxes: Яндекс Бизнес «Заявки» → воронка.
 *
 * The заявка form on a Maps organization profile has exactly three exits —
 * SMS, Telegram and email — and no API or webhook (verified against the
 * Яндекс Бизнес help, 2026-08). Email is the one a machine can stand behind,
 * so each participating org points the form's email notification at a
 * dedicated mailbox and this service drains it: connect over IMAP, read
 * UNSEEN, parse, create contact + deal through the same domain functions the
 * app uses (so workflows, activity log, amoCRM outbound and assignment pushes
 * all fire), mark \Seen.
 *
 * The mailbox is deliberately the queue. Prod is a laptop; while it sleeps,
 * заявки accumulate at Yandex and are drained on the next tick — nothing is
 * lost by being down, which a push webhook could not promise.
 *
 * Duplicate safety is a claim row (LeadInboxMessage, unique on inbox +
 * uidvalidity + uid) taken BEFORE anything is created, not the \Seen flag —
 * the flag is just what keeps the UNSEEN search small.
 */

import { randomBytes } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { LeadInbox } from '@prisma/client';
import { LeadInboxMode, LeadInboxStatus, Prisma } from '@prisma/client';
import { db } from './db';
import { blindIndex, decryptField, encryptField } from './encryption';
import { DEFAULT_CURRENCY } from '../config/market';
import { parseLeadEmail, type ParsedLeadEmail } from './lead-inbox-parse';
import { createContactForUser } from './contact-domain';
import { createDealForUser } from './deal-domain';
import { dealCtx, dispatchNotification } from './notificationEngine';

// ─── Errors ───────────────────────────────────────────────────────────────────

export class LeadInboxError extends Error {
  readonly httpStatus: number;
  readonly code: string;

  constructor(opts: { httpStatus: number; code: string; message: string }) {
    super(opts.message);
    this.name = 'LeadInboxError';
    this.httpStatus = opts.httpStatus;
    this.code = opts.code;
  }
}

// ─── IMAP seam ────────────────────────────────────────────────────────────────

/**
 * The slice of imapflow this service actually touches, injectable so the unit
 * tests drive the poller with a scripted mailbox instead of a socket.
 */
export type LeadImapClient = {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  mailbox: { uidValidity?: bigint } | boolean;
  search(query: { seen: boolean }, opts: { uid: boolean }): Promise<number[] | false>;
  fetchOne(
    seq: string,
    query: { source: boolean },
    opts: { uid: boolean },
  ): Promise<{ source?: Buffer } | false>;
  messageFlagsAdd(seq: string, flags: string[], opts: { uid: boolean }): Promise<boolean>;
  logout(): Promise<void>;
  close(): void;
};

export type LeadImapFactory = (opts: {
  host: string;
  port: number;
  user: string;
  password: string;
}) => LeadImapClient;

const defaultImapFactory: LeadImapFactory = ({ host, port, user, password }) =>
  new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass: password },
    logger: false,
    // A stuck mailbox must fail this tick loudly, not hold the scheduler's
    // in-flight guard until the socket's OS timeout does it hours later.
    socketTimeout: 60_000,
    greetingTimeout: 15_000,
  }) as unknown as LeadImapClient;

// ─── The collector mailbox ────────────────────────────────────────────────────
//
// ONE mailbox for the whole platform, owned by 4КУБ, credentialed in env. Each
// org gets a slice of it through plus-addressing: заявки for the org with
// intake_token a7f3c9e1d2 arrive at login+a7f3c9e1d2@yandex.ru (officially
// supported delivery — Yandex "почта с плюсом"), and the poller routes each
// letter by the address it was SENT TO. This is what makes onboarding one
// paste instead of "register a mailbox, enable IMAP, mint an app password".
// The pattern lives in env so upgrading to a branded domain catch-all
// ({token}@in.4kub.ru via Яндекс 360) is a config change, not a code change.

export type CollectorConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  /** e.g. "4kub.zayavki+{token}@yandex.ru" — must contain "{token}". */
  pattern: string;
};

export function collectorConfig(): CollectorConfig | null {
  const user = process.env.LEAD_COLLECTOR_IMAP_USER;
  const password = process.env.LEAD_COLLECTOR_IMAP_PASSWORD;
  const pattern = process.env.LEAD_COLLECTOR_ADDRESS_PATTERN;
  if (!user || !password || !pattern || !pattern.includes('{token}')) {
    return null;
  }
  return {
    host: process.env.LEAD_COLLECTOR_IMAP_HOST || 'imap.yandex.ru',
    port: Number(process.env.LEAD_COLLECTOR_IMAP_PORT) || 993,
    user,
    password,
    pattern,
  };
}

export function intakeAddressFor(token: string, config: CollectorConfig): string {
  return config.pattern.replace('{token}', token);
}

/** The pattern as a matcher: which token, if any, does this recipient carry? */
function tokenFromAddress(address: string, config: CollectorConfig): string | null {
  const escaped = config.pattern
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace('\\{token\\}', '([a-z0-9]+)');
  const match = new RegExp(`^${escaped}$`).exec(address.trim().toLowerCase());
  return match?.[1] ?? null;
}

function addressList(value: AddressObject | AddressObject[] | undefined): string[] {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects.flatMap((o) => o.value.map((v) => v.address ?? '').filter(Boolean));
}

/**
 * Every address this letter was delivered against. To/Cc cover the normal
 * case; Delivered-To / X-Original-To cover forwarding hops that rewrite the
 * visible headers.
 */
function recipientAddresses(mail: ParsedMail): string[] {
  const out = [...addressList(mail.to), ...addressList(mail.cc)];
  for (const header of ['delivered-to', 'x-original-to'] as const) {
    const raw = mail.headers.get(header);
    for (const entry of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      if (typeof entry === 'string') {
        out.push(entry);
      } else if (entry && typeof entry === 'object' && 'value' in entry) {
        out.push(...addressList(entry as AddressObject));
      }
    }
  }
  return out;
}

// ─── The tick ─────────────────────────────────────────────────────────────────

/** Per tick per inbox, so one flooded mailbox cannot occupy the whole minute. */
const MAX_MESSAGES_PER_TICK = 25;

export type LeadInboxPollSummary = {
  scanned: number;
  created: number;
  duplicates: number;
  failed: number;
};

/**
 * Poll every non-paused inbox: the shared collector once for all collector-mode
 * orgs, then each custom-mode mailbox on its own. Failures are contained per
 * mailbox and written to the affected inboxes' status/last_error — org A's
 * problem must not stop org B's заявки, and the error must be visible in the
 * settings screen, not only in a server log nobody reads.
 */
export async function runLeadInboxTick(imapFactory: LeadImapFactory = defaultImapFactory): Promise<void> {
  // tenant-scope: cross-tenant — the scheduler's minute tick drains EVERY
  // organization's mailbox; each row then scopes all downstream work to its own
  // organization_id. Read-only over config rows, same shape as the amoCRM
  // sync worker's job scan.
  const inboxes = await db.leadInbox.findMany({
    where: { status: { not: LeadInboxStatus.paused } },
  });

  const collectorInboxes = inboxes.filter((i) => i.mode === LeadInboxMode.collector);
  if (collectorInboxes.length > 0) {
    await pollCollectorForInboxes(collectorInboxes, imapFactory);
  }

  for (const inbox of inboxes.filter((i) => i.mode === LeadInboxMode.custom)) {
    try {
      const summary = await pollInbox(inbox, imapFactory);
      await markPolled(inbox.id, null);
      logSummary(inbox.organization_id, summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[lead-inbox] org=${inbox.organization_id} poll failed: ${message}`);
      await markPolled(inbox.id, message);
    }
  }
}

/** One status write per inbox; null error means a clean poll. */
async function markPolled(inboxId: string, error: string | null): Promise<void> {
  await db.leadInbox
    .update({
      where: { id: inboxId },
      data: {
        status: error ? LeadInboxStatus.error : LeadInboxStatus.active,
        last_error: error ? error.slice(0, 500) : null,
        last_polled_at: new Date(),
      },
    })
    .catch((updateError) => {
      console.error('[lead-inbox] could not record poll outcome', updateError);
    });
}

function logSummary(orgId: string, summary: LeadInboxPollSummary): void {
  if (summary.created > 0 || summary.failed > 0) {
    console.log(
      `[lead-inbox] org=${orgId} scanned=${summary.scanned} created=${summary.created} duplicates=${summary.duplicates} failed=${summary.failed}`,
    );
  }
}

/**
 * One pass over the shared collector mailbox, routing each letter to the org
 * whose intake address it was sent to. A letter with no recognizable token is
 * flagged \Seen and skipped — it is noise to the platform, and leaving it
 * UNSEEN would re-fetch it every minute forever.
 */
export async function pollCollectorForInboxes(
  collectorInboxes: LeadInbox[],
  imapFactory: LeadImapFactory = defaultImapFactory,
): Promise<LeadInboxPollSummary> {
  const summary: LeadInboxPollSummary = { scanned: 0, created: 0, duplicates: 0, failed: 0 };
  const config = collectorConfig();
  if (!config) {
    for (const inbox of collectorInboxes) {
      await markPolled(inbox.id, 'collector mailbox is not configured on this server (LEAD_COLLECTOR_*)');
    }
    return summary;
  }

  const byToken = new Map(
    collectorInboxes.filter((i) => i.intake_token).map((i) => [i.intake_token as string, i]),
  );

  const client = imapFactory({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
  });

  try {
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uidValidity =
          typeof client.mailbox === 'object' && client.mailbox.uidValidity !== undefined
            ? client.mailbox.uidValidity
            : 0n;

        const unseen = (await client.search({ seen: false }, { uid: true })) || [];
        for (const uid of unseen.slice(0, MAX_MESSAGES_PER_TICK)) {
          summary.scanned += 1;

          const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!fetched || !fetched.source) {
            summary.failed += 1;
            continue;
          }

          const mail = await simpleParser(fetched.source);
          const token = recipientAddresses(mail)
            .map((address) => tokenFromAddress(address, config))
            .find((t): t is string => t !== null);
          const inbox = token ? byToken.get(token) : undefined;

          if (!inbox) {
            console.warn(
              `[lead-inbox] collector letter uid=${uid} from=${mail.from?.value?.[0]?.address ?? '?'} matches no org — skipped`,
            );
          } else {
            await processMessage(inbox, uidValidity, uid, mail, summary);
          }

          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }

    for (const inbox of collectorInboxes) {
      await markPolled(inbox.id, null);
    }
    logSummary('collector', summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[lead-inbox] collector poll failed: ${message}`);
    for (const inbox of collectorInboxes) {
      await markPolled(inbox.id, message);
    }
  }

  return summary;
}

/** Connect, drain UNSEEN (capped), disconnect. Throws on connection problems. */
export async function pollInbox(
  inbox: LeadInbox,
  imapFactory: LeadImapFactory = defaultImapFactory,
): Promise<LeadInboxPollSummary> {
  const summary: LeadInboxPollSummary = { scanned: 0, created: 0, duplicates: 0, failed: 0 };

  if (!inbox.imap_user || !inbox.imap_password_enc) {
    throw new Error('this inbox has no mailbox credentials — it is served by the collector');
  }
  const password = decryptField(inbox.imap_password_enc);
  if (!password) {
    throw new Error('stored IMAP password cannot be decrypted — reconfigure the inbox');
  }

  const client = imapFactory({
    host: inbox.imap_host,
    port: inbox.imap_port,
    user: inbox.imap_user,
    password,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidValidity =
        typeof client.mailbox === 'object' && client.mailbox.uidValidity !== undefined
          ? client.mailbox.uidValidity
          : 0n;

      const unseen = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of unseen.slice(0, MAX_MESSAGES_PER_TICK)) {
        summary.scanned += 1;

        const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!fetched || !fetched.source) {
          summary.failed += 1;
          continue;
        }

        await processMessage(inbox, uidValidity, uid, await simpleParser(fetched.source), summary);

        // \Seen is set for processed, duplicate AND failed alike: the claim row
        // already records what happened, and a poison message left UNSEEN would
        // be re-fetched every minute forever.
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }

  return summary;
}

// ─── One message → one lead ───────────────────────────────────────────────────

async function processMessage(
  inbox: LeadInbox,
  uidValidity: bigint,
  uid: number,
  mail: ParsedMail,
  summary: LeadInboxPollSummary,
): Promise<void> {
  const messageId = mail.messageId ?? null;
  const fromAddr = mail.from?.value?.[0]?.address ?? null;
  const subject = mail.subject ?? null;
  const receivedAt = mail.date ?? null;

  const claimKey = {
    inbox_id: inbox.id,
    uid_validity: uidValidity,
    message_uid: uid,
  };

  // The claim. `skipDuplicates` makes it INSERT … ON CONFLICT DO NOTHING:
  // count 0 means an earlier run (or a concurrent one) already owns this UID.
  const claim = await db.leadInboxMessage.createMany({
    data: [
      {
        ...claimKey,
        organization_id: inbox.organization_id,
        message_id: messageId,
        from_addr: fromAddr,
        subject,
        received_at: receivedAt,
      },
    ],
    skipDuplicates: true,
  });
  if (claim.count === 0) {
    summary.duplicates += 1;
    return;
  }

  const finishClaim = (data: Prisma.LeadInboxMessageUncheckedUpdateManyInput) =>
    db.leadInboxMessage.updateMany({ where: claimKey, data });

  // The same email surviving a UIDVALIDITY reset arrives under a fresh UID;
  // its Message-ID is the constant that catches it.
  if (messageId) {
    const echo = await db.leadInboxMessage.findFirst({
      where: {
        inbox_id: inbox.id,
        message_id: messageId,
        NOT: { AND: [{ uid_validity: uidValidity }, { message_uid: uid }] },
      },
      select: { id: true },
    });
    if (echo) {
      await finishClaim({ status: 'duplicate' });
      summary.duplicates += 1;
      return;
    }
  }

  try {
    const lead = parseLeadEmail({
      subject: subject ?? undefined,
      text: mail.text ?? undefined,
      html: typeof mail.html === 'string' ? mail.html : undefined,
    });

    const created = await createLead(inbox, lead, {
      messageId,
      fromAddr,
      receivedAt,
    });

    await finishClaim({
      status: 'processed',
      contact_id: created.contactId,
      deal_id: created.dealId,
    });
    summary.created += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[lead-inbox] org=${inbox.organization_id} uid=${uid} failed to create lead: ${message}`,
    );
    await finishClaim({ status: 'failed', error: message.slice(0, 500) });
    summary.failed += 1;
  }
}

async function createLead(
  inbox: LeadInbox,
  lead: ParsedLeadEmail,
  meta: { messageId: string | null; fromAddr: string | null; receivedAt: Date | null },
): Promise<{ contactId: string; dealId: string }> {
  const actorId = await resolveActor(inbox);
  if (!actorId) {
    throw new Error('no active owner or admin left to attribute the lead to');
  }

  const assigneeId = await resolveAssignee(inbox);
  const { pipelineId, stageId } = await resolveTargets(inbox);

  const [firstName, ...restName] = (lead.name ?? '').trim().split(/\s+/).filter(Boolean);

  let contactId: string;
  const existing = await findExistingContact(inbox.organization_id, lead);
  if (existing) {
    contactId = existing;
  } else {
    const contact = (await createContactForUser(inbox.organization_id, actorId, {
      first_name: firstName ?? 'Клиент',
      last_name: restName.length > 0 ? restName.join(' ') : undefined,
      phone: lead.phone,
      email: lead.email,
      source: inbox.source_label,
      notes: lead.comment ?? (lead.name || lead.phone || lead.email ? undefined : lead.raw.slice(0, 2_000)),
      type: 'lead',
      assigned_to: assigneeId,
    })) as { id: string };
    contactId = contact.id;
  }

  const deal = await createDealForUser(
    inbox.organization_id,
    actorId,
    {
      title: lead.name ? `Заявка: ${lead.name}` : `Заявка (${inbox.source_label})`,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      currency: DEFAULT_CURRENCY,
      source: inbox.source_label,
      assigned_to: assigneeId,
      custom_fields: {
        lead_inbox: {
          message_id: meta.messageId,
          from: meta.fromAddr,
          received_at: meta.receivedAt?.toISOString() ?? null,
          comment: lead.comment ?? null,
          text: lead.raw.slice(0, 4_000),
        },
      },
    },
    // lead.new below is the notification for this event; the generic
    // "X назначил вам" copy would be a second buzz with the wrong words.
    { silentAssignment: true },
  );

  const who = [lead.name, lead.phone].filter(Boolean).join(', ');
  const details =
    [who || null, lead.comment ? lead.comment.slice(0, 140) : null].filter(Boolean).join(' — ') ||
    undefined;
  const ctx = await dealCtx({ orgId: inbox.organization_id, dealId: deal.id, actorId });
  if (ctx) {
    await dispatchNotification({
      eventType: 'lead.new',
      orgId: inbox.organization_id,
      deal: ctx,
      source: inbox.source_label,
      details,
    });
  }

  return { contactId, dealId: deal.id };
}

/** Same preference order as the public API's actor: creator, then owner/admin. */
async function resolveActor(inbox: LeadInbox): Promise<string | null> {
  if (inbox.created_by) {
    const creator = await db.user.findFirst({
      where: { id: inbox.created_by, organization_id: inbox.organization_id, is_active: true },
      select: { id: true },
    });
    if (creator) {
      return creator.id;
    }
  }

  const fallback = await db.user.findFirst({
    where: {
      organization_id: inbox.organization_id,
      is_active: true,
      role: { in: ['owner', 'admin'] },
    },
    orderBy: [{ role: 'asc' }, { created_at: 'asc' }],
    select: { id: true },
  });

  return fallback?.id ?? null;
}

/**
 * Every заявка must be SOMEBODY'S: an unassigned lead notifies nobody and
 * belongs to nobody's list. The configured assignee wins; unset — or
 * deactivated since — falls back to the org's владелец (then admin), which in
 * a one-person organization is the владелец herself.
 */
async function resolveAssignee(inbox: LeadInbox): Promise<string | undefined> {
  if (inbox.assigned_to) {
    const user = await db.user.findFirst({
      where: { id: inbox.assigned_to, organization_id: inbox.organization_id, is_active: true },
      select: { id: true },
    });
    if (user) {
      return user.id;
    }
  }

  const fallback = await db.user.findFirst({
    where: {
      organization_id: inbox.organization_id,
      is_active: true,
      role: { in: ['owner', 'admin'] },
    },
    orderBy: [{ role: 'asc' }, { created_at: 'asc' }],
    select: { id: true },
  });
  return fallback?.id;
}

/**
 * The configured funnel/stage when they still exist, else the org's default
 * pipeline and its first open stage. Fallback is per message, not per config
 * write, so archiving a stage mid-flight reroutes rather than errors.
 */
async function resolveTargets(inbox: LeadInbox): Promise<{ pipelineId: string; stageId: string }> {
  let pipeline = inbox.pipeline_id
    ? await db.pipeline.findFirst({
        where: { id: inbox.pipeline_id, organization_id: inbox.organization_id },
        select: { id: true },
      })
    : null;

  pipeline ??= await db.pipeline.findFirst({
    where: { organization_id: inbox.organization_id, is_default: true },
    select: { id: true },
  });
  pipeline ??= await db.pipeline.findFirst({
    where: { organization_id: inbox.organization_id },
    select: { id: true },
  });
  if (!pipeline) {
    throw new Error('the organization has no pipeline to place the lead in');
  }

  let stage = inbox.stage_id
    ? await db.pipelineStage.findFirst({
        where: { id: inbox.stage_id, pipeline_id: pipeline.id, is_archived: false },
        select: { id: true },
      })
    : null;

  stage ??= await db.pipelineStage.findFirst({
    where: {
      pipeline_id: pipeline.id,
      is_archived: false,
      is_won_stage: false,
      is_lost_stage: false,
    },
    orderBy: { position: 'asc' },
    select: { id: true },
  });
  stage ??= await db.pipelineStage.findFirst({
    where: { pipeline_id: pipeline.id, is_archived: false },
    orderBy: { position: 'asc' },
    select: { id: true },
  });
  if (!stage) {
    throw new Error('the pipeline has no stage to place the lead in');
  }

  return { pipelineId: pipeline.id, stageId: stage.id };
}

/**
 * A returning client is matched by phone/email blind index instead of gaining
 * a twin. blindIndex normalizes phones itself (digits, 7-prefix), so «8 912…»
 * in the заявка meets «+7912…» in the base.
 */
async function findExistingContact(orgId: string, lead: ParsedLeadEmail): Promise<string | null> {
  const clauses: Prisma.ContactWhereInput[] = [];

  if (lead.phone) {
    const idx = blindIndex(lead.phone, 'phone');
    const idxMobile = blindIndex(lead.phone, 'mobile');
    if (idx) {
      clauses.push({ phone_bidx: idx });
    }
    if (idxMobile) {
      clauses.push({ mobile_bidx: idxMobile });
    }
  }
  if (lead.email) {
    const idx = blindIndex(lead.email, 'email');
    if (idx) {
      clauses.push({ email_bidx: idx });
    }
  }

  if (clauses.length === 0) {
    return null;
  }

  const contact = await db.contact.findFirst({
    where: { organization_id: orgId, OR: clauses },
    select: { id: true },
  });
  return contact?.id ?? null;
}

// ─── Configuration (the controller's half) ────────────────────────────────────

export type LeadInboxUpsertInput = {
  /**
   * Defaults to 'collector' — enable-and-paste, no credentials from the org.
   * Sending imap_user without an explicit mode selects 'custom' for backward
   * compatibility with the bring-your-own-mailbox call shape.
   */
  mode?: 'collector' | 'custom';
  imap_host?: string;
  imap_port?: number;
  imap_user?: string;
  /** custom mode: required on first configure; omitted on update = keep stored. */
  imap_password?: string;
  pipeline_id?: string | null;
  stage_id?: string | null;
  assigned_to?: string | null;
  source_label?: string;
  paused?: boolean;
};

const inboxView = {
  id: true,
  mode: true,
  intake_token: true,
  imap_host: true,
  imap_port: true,
  imap_user: true,
  pipeline_id: true,
  stage_id: true,
  assigned_to: true,
  source_label: true,
  status: true,
  last_polled_at: true,
  last_error: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.LeadInboxSelect;

/**
 * What the app shows. `intake_address` is the one string a collector-mode user
 * ever touches: they paste it into Яндекс Бизнес and are done.
 */
function withIntakeAddress<T extends { mode: LeadInboxMode; intake_token: string | null }>(
  inbox: T,
): T & { intake_address: string | null } {
  const config = collectorConfig();
  return {
    ...inbox,
    intake_address:
      inbox.mode === LeadInboxMode.collector && inbox.intake_token && config
        ? intakeAddressFor(inbox.intake_token, config)
        : null,
  };
}

export async function getLeadInboxStatus(orgId: string): Promise<unknown> {
  const inbox = await db.leadInbox.findUnique({
    where: { organization_id: orgId },
    select: inboxView,
  });

  if (!inbox) {
    return { configured: false };
  }

  const [total, recent] = await Promise.all([
    db.leadInboxMessage.count({ where: { inbox_id: inbox.id } }),
    db.leadInboxMessage.findMany({
      where: { inbox_id: inbox.id },
      orderBy: { created_at: 'desc' },
      take: 10,
      select: {
        id: true,
        subject: true,
        from_addr: true,
        status: true,
        error: true,
        contact_id: true,
        deal_id: true,
        received_at: true,
        created_at: true,
      },
    }),
  ]);

  return { configured: true, ...withIntakeAddress(inbox), messages_total: total, recent_messages: recent };
}

export async function upsertLeadInbox(
  orgId: string,
  userId: string,
  input: LeadInboxUpsertInput,
): Promise<unknown> {
  const existing = await db.leadInbox.findUnique({ where: { organization_id: orgId } });

  const mode: LeadInboxMode =
    input.mode ?? existing?.mode ?? (input.imap_user ? LeadInboxMode.custom : LeadInboxMode.collector);

  if (mode === LeadInboxMode.collector && !collectorConfig()) {
    throw new LeadInboxError({
      httpStatus: 501,
      code: 'COLLECTOR_NOT_CONFIGURED',
      message: 'The shared intake mailbox is not configured on this server (LEAD_COLLECTOR_*)',
    });
  }

  if (mode === LeadInboxMode.custom && !input.imap_user && !existing?.imap_user) {
    throw new LeadInboxError({
      httpStatus: 400,
      code: 'IMAP_USER_REQUIRED',
      message: 'An IMAP login is required for a custom inbox',
    });
  }

  if (mode === LeadInboxMode.custom && !input.imap_password && !existing?.imap_password_enc) {
    throw new LeadInboxError({
      httpStatus: 400,
      code: 'PASSWORD_REQUIRED',
      message: 'An IMAP password is required to connect a new inbox',
    });
  }

  const pipelineId = input.pipeline_id === undefined ? existing?.pipeline_id ?? null : input.pipeline_id;
  const stageId = input.stage_id === undefined ? existing?.stage_id ?? null : input.stage_id;

  if (pipelineId) {
    const pipeline = await db.pipeline.findFirst({
      where: { id: pipelineId, organization_id: orgId },
      select: { id: true },
    });
    if (!pipeline) {
      throw new LeadInboxError({
        httpStatus: 404,
        code: 'PIPELINE_NOT_FOUND',
        message: 'Pipeline not found',
      });
    }
  }

  if (stageId) {
    if (!pipelineId) {
      throw new LeadInboxError({
        httpStatus: 400,
        code: 'STAGE_WITHOUT_PIPELINE',
        message: 'A stage can only be set together with its pipeline',
      });
    }
    const stage = await db.pipelineStage.findFirst({
      where: { id: stageId, pipeline_id: pipelineId, is_archived: false },
      select: { id: true },
    });
    if (!stage) {
      throw new LeadInboxError({
        httpStatus: 400,
        code: 'STAGE_PIPELINE_MISMATCH',
        message: 'Stage does not belong to the specified pipeline',
      });
    }
  }

  const assignedTo = input.assigned_to === undefined ? existing?.assigned_to ?? null : input.assigned_to;
  if (assignedTo) {
    const assignee = await db.user.findFirst({
      where: { id: assignedTo, organization_id: orgId, is_active: true },
      select: { id: true },
    });
    if (!assignee) {
      throw new LeadInboxError({
        httpStatus: 403,
        code: 'FORBIDDEN',
        message: 'Assigned user does not belong to your organization',
      });
    }
  }

  const status =
    input.paused === undefined
      ? existing
        ? undefined
        : LeadInboxStatus.active
      : input.paused
        ? LeadInboxStatus.paused
        : LeadInboxStatus.active;

  // The address is pasted into external cabinets, so its token is minted
  // exactly once per org and never rotates on config edits.
  const intakeToken =
    existing?.intake_token ??
    (mode === LeadInboxMode.collector ? randomBytes(5).toString('hex') : null);

  const shared = {
    mode,
    intake_token: intakeToken,
    imap_host: input.imap_host ?? existing?.imap_host ?? 'imap.yandex.ru',
    imap_port: input.imap_port ?? existing?.imap_port ?? 993,
    imap_user:
      mode === LeadInboxMode.custom ? (input.imap_user ?? existing?.imap_user ?? null) : null,
    pipeline_id: pipelineId,
    stage_id: stageId,
    assigned_to: assignedTo,
    source_label: input.source_label ?? existing?.source_label ?? 'Яндекс Карты',
    // Any config write wipes the sticky error: the point of saving is to retry.
    last_error: null,
  };

  // `undefined` = keep the stored secret (custom update without a new password);
  // `null` = wipe it (collector mode holds no credentials at all).
  const passwordEnc =
    mode === LeadInboxMode.custom
      ? input.imap_password
        ? encryptField(input.imap_password)
        : undefined
      : null;

  const inbox = await db.leadInbox.upsert({
    where: { organization_id: orgId },
    create: {
      ...shared,
      organization_id: orgId,
      imap_password_enc: passwordEnc ?? null,
      status: status ?? LeadInboxStatus.active,
      created_by: userId,
    },
    update: {
      ...shared,
      ...(passwordEnc !== undefined ? { imap_password_enc: passwordEnc } : {}),
      ...(status ? { status } : {}),
    },
    select: inboxView,
  });

  return { configured: true, ...withIntakeAddress(inbox) };
}

export async function deleteLeadInbox(orgId: string): Promise<void> {
  const existing = await db.leadInbox.findUnique({
    where: { organization_id: orgId },
    select: { id: true },
  });
  if (!existing) {
    throw new LeadInboxError({
      httpStatus: 404,
      code: 'NOT_FOUND',
      message: 'No lead inbox is configured',
    });
  }
  await db.leadInbox.delete({ where: { id: existing.id } });
}

/**
 * One immediate poll, bypassing pause — the "Проверить подключение" button.
 * Persists the outcome exactly like the scheduled tick so the settings screen
 * reflects what just happened.
 */
export async function testLeadInbox(
  orgId: string,
  imapFactory: LeadImapFactory = defaultImapFactory,
): Promise<{ ok: boolean; error?: string } & Partial<LeadInboxPollSummary>> {
  const inbox = await db.leadInbox.findUnique({ where: { organization_id: orgId } });
  if (!inbox) {
    throw new LeadInboxError({
      httpStatus: 404,
      code: 'NOT_FOUND',
      message: 'No lead inbox is configured',
    });
  }

  if (inbox.mode === LeadInboxMode.collector) {
    // The collector pass contains its own errors and records them on the row;
    // read the row back to answer ok/not-ok, and don't let a manual test
    // un-pause an inbox the owner paused on purpose.
    const summary = await pollCollectorForInboxes([inbox], imapFactory);
    const after = await db.leadInbox.findUnique({
      where: { id: inbox.id },
      select: { last_error: true },
    });
    if (inbox.status === LeadInboxStatus.paused) {
      await db.leadInbox
        .update({ where: { id: inbox.id }, data: { status: LeadInboxStatus.paused } })
        .catch(() => undefined);
    }
    return after?.last_error ? { ok: false, error: after.last_error } : { ok: true, ...summary };
  }

  try {
    const summary = await pollInbox(inbox, imapFactory);
    await db.leadInbox.update({
      where: { id: inbox.id },
      data: {
        status: inbox.status === LeadInboxStatus.paused ? undefined : LeadInboxStatus.active,
        last_error: null,
        last_polled_at: new Date(),
      },
    });
    return { ok: true, ...summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.leadInbox
      .update({
        where: { id: inbox.id },
        data: {
          status: inbox.status === LeadInboxStatus.paused ? undefined : LeadInboxStatus.error,
          last_error: message.slice(0, 500),
          last_polled_at: new Date(),
        },
      })
      .catch(() => undefined);
    return { ok: false, error: message };
  }
}
