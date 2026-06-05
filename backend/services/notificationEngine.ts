import { db } from './db';
import { sendPush } from './push';

// ─── Event types ──────────────────────────────────────────────────────────────

export type NotificationEventType =
  | 'task.assigned'
  | 'task.reassigned'
  | 'task.completed'
  | 'task.deadline_24h'
  | 'task.deadline_2h'
  | 'task.overdue'
  | 'deal.assigned'
  | 'deal.stage_changed'
  | 'deal.won'
  | 'deal.lost'
  | 'deal.close_7d'
  | 'deal.close_1d'
  | 'contact.assigned';

// Whether this event type needs deduplication (scheduled, fires repeatedly)
const SCHEDULED_EVENTS = new Set<NotificationEventType>([
  'task.deadline_24h',
  'task.deadline_2h',
  'task.overdue',
  'deal.close_7d',
  'deal.close_1d',
]);

// ─── Context types ────────────────────────────────────────────────────────────

interface UserSnap { id: string; name: string; push_token: string | null }

interface TaskCtx {
  id: string;
  title: string;
  due_date?: Date | null;
  assignee: UserSnap;
  assigner: UserSnap | null;
}

interface DealCtx {
  id: string;
  title: string;
  expected_close?: Date | null;
  stage_name?: string;
  owner: UserSnap | null;
  creator: UserSnap | null;
}

interface ContactCtx {
  id: string;
  name: string;
  assignee: UserSnap;
  assigner: UserSnap | null;
}

type EventContext =
  | { eventType: 'task.assigned' | 'task.reassigned' | 'task.completed' | 'task.deadline_24h' | 'task.deadline_2h' | 'task.overdue'; orgId: string; task: TaskCtx }
  | { eventType: 'deal.assigned' | 'deal.stage_changed' | 'deal.won' | 'deal.lost' | 'deal.close_7d' | 'deal.close_1d'; orgId: string; deal: DealCtx }
  | { eventType: 'contact.assigned'; orgId: string; contact: ContactCtx };

// ─── Message templates ────────────────────────────────────────────────────────

interface NotificationPayload { title: string; body: string }

function formatDate(d: Date | null | undefined): string {
  if (!d) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function formatTime(d: Date | null | undefined): string {
  if (!d) return '';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function buildMessages(ctx: EventContext): Array<{ recipientId: string; role: string; msg: NotificationPayload }> {
  const results: Array<{ recipientId: string; role: string; msg: NotificationPayload }> = [];

  function add(recipientId: string | null | undefined, role: string, msg: NotificationPayload) {
    if (recipientId) results.push({ recipientId, role, msg });
  }

  switch (ctx.eventType) {
    // ── Tasks ──────────────────────────────────────────────────────────────────
    case 'task.assigned':
      add(ctx.task.assignee.id, 'assignee', {
        title: 'Новая задача',
        body: `${ctx.task.assigner?.name ?? 'Менеджер'} назначил вам: «${ctx.task.title}»`,
      });
      if (ctx.task.assigner && ctx.task.assigner.id !== ctx.task.assignee.id) {
        add(ctx.task.assigner.id, 'assigner', {
          title: 'Задача назначена',
          body: `«${ctx.task.title}» → ${ctx.task.assignee.name}`,
        });
      }
      break;

    case 'task.reassigned':
      add(ctx.task.assignee.id, 'assignee', {
        title: 'Задача переназначена вам',
        body: `«${ctx.task.title}» теперь ваша`,
      });
      break;

    case 'task.completed':
      if (ctx.task.assigner && ctx.task.assigner.id !== ctx.task.assignee.id) {
        add(ctx.task.assigner.id, 'assigner', {
          title: 'Задача выполнена ✓',
          body: `${ctx.task.assignee.name} завершил «${ctx.task.title}»`,
        });
      }
      break;

    case 'task.deadline_24h':
      add(ctx.task.assignee.id, 'assignee', {
        title: 'Дедлайн завтра',
        body: `«${ctx.task.title}» — истекает ${formatDate(ctx.task.due_date)}`,
      });
      if (ctx.task.assigner && ctx.task.assigner.id !== ctx.task.assignee.id) {
        add(ctx.task.assigner.id, 'assigner', {
          title: 'Сотрудник не успевает?',
          body: `${ctx.task.assignee.name}: «${ctx.task.title}» — дедлайн завтра`,
        });
      }
      break;

    case 'task.deadline_2h':
      add(ctx.task.assignee.id, 'assignee', {
        title: '⚠️ Срочно — через 2 часа',
        body: `«${ctx.task.title}» нужно сдать до ${formatTime(ctx.task.due_date)}`,
      });
      if (ctx.task.assigner && ctx.task.assigner.id !== ctx.task.assignee.id) {
        add(ctx.task.assigner.id, 'assigner', {
          title: '⚠️ Дедлайн через 2 часа',
          body: `${ctx.task.assignee.name} может не успеть: «${ctx.task.title}»`,
        });
      }
      break;

    case 'task.overdue':
      add(ctx.task.assignee.id, 'assignee', {
        title: 'Просрочено',
        body: `«${ctx.task.title}» — дедлайн прошёл`,
      });
      if (ctx.task.assigner && ctx.task.assigner.id !== ctx.task.assignee.id) {
        add(ctx.task.assigner.id, 'assigner', {
          title: 'Задача просрочена',
          body: `${ctx.task.assignee.name} просрочил «${ctx.task.title}»`,
        });
      }
      break;

    // ── Deals ──────────────────────────────────────────────────────────────────
    case 'deal.assigned':
      add(ctx.deal.owner?.id, 'assignee', {
        title: 'Новая сделка',
        body: `${ctx.deal.creator?.name ?? 'Менеджер'} назначил вам: «${ctx.deal.title}»`,
      });
      if (ctx.deal.creator && ctx.deal.owner && ctx.deal.creator.id !== ctx.deal.owner.id) {
        add(ctx.deal.creator.id, 'assigner', {
          title: 'Сделка назначена',
          body: `«${ctx.deal.title}» → ${ctx.deal.owner.name}`,
        });
      }
      break;

    case 'deal.stage_changed':
      add(ctx.deal.owner?.id, 'owner', {
        title: 'Сделка продвинулась',
        body: `«${ctx.deal.title}» → ${ctx.deal.stage_name ?? 'новая стадия'}`,
      });
      if (ctx.deal.creator && ctx.deal.owner && ctx.deal.creator.id !== ctx.deal.owner.id) {
        add(ctx.deal.creator.id, 'watcher', {
          title: 'Движение по сделке',
          body: `«${ctx.deal.title}» перешла в ${ctx.deal.stage_name ?? 'новую стадию'}`,
        });
      }
      break;

    case 'deal.won':
      add(ctx.deal.owner?.id, 'owner', {
        title: '🎉 Сделка закрыта!',
        body: `«${ctx.deal.title}» — победа!`,
      });
      if (ctx.deal.creator && ctx.deal.owner && ctx.deal.creator.id !== ctx.deal.owner.id) {
        add(ctx.deal.creator.id, 'watcher', {
          title: '🎉 Победа!',
          body: `${ctx.deal.owner.name} закрыл «${ctx.deal.title}»`,
        });
      }
      break;

    case 'deal.lost':
      add(ctx.deal.owner?.id, 'owner', {
        title: 'Сделка потеряна',
        body: `«${ctx.deal.title}» отмечена как проигранная`,
      });
      if (ctx.deal.creator && ctx.deal.owner && ctx.deal.creator.id !== ctx.deal.owner.id) {
        add(ctx.deal.creator.id, 'watcher', {
          title: 'Сделка потеряна',
          body: `${ctx.deal.owner.name} потерял «${ctx.deal.title}»`,
        });
      }
      break;

    case 'deal.close_7d':
      add(ctx.deal.owner?.id, 'owner', {
        title: 'Закрытие через 7 дней',
        body: `«${ctx.deal.title}» закрывается ${formatDate(ctx.deal.expected_close)}`,
      });
      if (ctx.deal.creator && ctx.deal.owner && ctx.deal.creator.id !== ctx.deal.owner.id) {
        add(ctx.deal.creator.id, 'watcher', {
          title: 'Сделка закрывается',
          body: `У ${ctx.deal.owner.name} — «${ctx.deal.title}» ${formatDate(ctx.deal.expected_close)}`,
        });
      }
      break;

    case 'deal.close_1d':
      add(ctx.deal.owner?.id, 'owner', {
        title: 'Завтра дедлайн по сделке',
        body: `«${ctx.deal.title}» должна закрыться завтра`,
      });
      if (ctx.deal.creator && ctx.deal.owner && ctx.deal.creator.id !== ctx.deal.owner.id) {
        add(ctx.deal.creator.id, 'watcher', {
          title: 'Дедлайн по сделке завтра',
          body: `«${ctx.deal.title}» (${ctx.deal.owner.name}) — завтра`,
        });
      }
      break;

    // ── Contacts ───────────────────────────────────────────────────────────────
    case 'contact.assigned':
      add(ctx.contact.assignee.id, 'assignee', {
        title: 'Новый контакт',
        body: `${ctx.contact.assigner?.name ?? 'Менеджер'} назначил вам: ${ctx.contact.name}`,
      });
      break;
  }

  return results;
}

// ─── Entity type helper ───────────────────────────────────────────────────────

function entityTypeFor(eventType: NotificationEventType): string {
  if (eventType.startsWith('task.')) return 'task';
  if (eventType.startsWith('deal.')) return 'deal';
  return 'contact';
}

function entityIdFor(ctx: EventContext): string {
  if ('task' in ctx) return ctx.task.id;
  if ('deal' in ctx) return ctx.deal.id;
  return ctx.contact.id;
}

// ─── Push delivery ────────────────────────────────────────────────────────────

async function deliverPush(
  recipientId: string,
  title: string,
  body: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: recipientId },
    select: { push_token: true },
  });
  if (!user?.push_token) return;

  const result = await sendPush(user.push_token, title, body, { entityType, entityId });
  if (!result.ok && result.code === 'DEVICE_NOT_REGISTERED') {
    await db.user.update({ where: { id: recipientId }, data: { push_token: null } });
  }
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

export async function dispatchNotification(ctx: EventContext): Promise<void> {
  const entityType = entityTypeFor(ctx.eventType);
  const entityId = entityIdFor(ctx);
  const messages = buildMessages(ctx);

  for (const { recipientId, role, msg } of messages) {
    // Deduplicate scheduled events — skip if already sent
    if (SCHEDULED_EVENTS.has(ctx.eventType)) {
      const exists = await db.notificationSent.findUnique({
        where: { event_type_entity_id_recipient_id: { event_type: ctx.eventType, entity_id: entityId, recipient_id: recipientId } },
      });
      if (exists) continue;

      await db.notificationSent.create({
        data: { event_type: ctx.eventType, entity_id: entityId, recipient_id: recipientId },
      });
    }

    await db.notification.create({
      data: {
        organization_id: ctx.orgId,
        recipient_id: recipientId,
        event_type: ctx.eventType,
        role,
        title: msg.title,
        body: msg.body,
        entity_type: entityType,
        entity_id: entityId,
        data: { entityType, entityId },
      },
    });

    void deliverPush(recipientId, msg.title, msg.body, entityType, entityId);
  }
}

// ─── Context builders (fetch from DB) ────────────────────────────────────────

async function userSnap(id: string | null | undefined): Promise<UserSnap | null> {
  if (!id) return null;
  const u = await db.user.findUnique({ where: { id }, select: { id: true, name: true, push_token: true } });
  return u ?? null;
}

export async function taskCtx(taskId: string): Promise<TaskCtx | null> {
  const t = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, due_date: true, assigned_to: true, created_by: true },
  });
  if (!t) return null;
  const [assignee, assigner] = await Promise.all([userSnap(t.assigned_to), userSnap(t.created_by)]);
  if (!assignee) return null;
  return { id: t.id, title: t.title, due_date: t.due_date, assignee, assigner };
}

export async function dealCtx(dealId: string, stageName?: string): Promise<DealCtx | null> {
  const d = await db.deal.findUnique({
    where: { id: dealId },
    select: { id: true, title: true, expected_close: true, assigned_to: true, created_by: true, stage: { select: { name: true } } },
  });
  if (!d) return null;
  const [owner, creator] = await Promise.all([userSnap(d.assigned_to), userSnap(d.created_by)]);
  return { id: d.id, title: d.title, expected_close: d.expected_close, stage_name: stageName ?? d.stage?.name, owner, creator };
}

export async function contactCtx(contactId: string, assignerId?: string): Promise<ContactCtx | null> {
  const c = await db.contact.findUnique({
    where: { id: contactId },
    select: { id: true, first_name: true, last_name: true, assigned_to: true, created_by: true },
  });
  if (!c || !c.assigned_to) return null;
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
  const [assignee, assigner] = await Promise.all([
    userSnap(c.assigned_to),
    userSnap(assignerId ?? c.created_by),
  ]);
  if (!assignee) return null;
  return { id: c.id, name, assignee, assigner };
}
