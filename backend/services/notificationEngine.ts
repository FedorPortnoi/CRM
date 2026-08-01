import { db } from './db';
import { DEFAULT_TIME_ZONE } from '../config/market';
import { sendPushToUser } from './push';

// ─── Event types ──────────────────────────────────────────────────────────────

export type NotificationEventType =
  | 'task.assigned'
  | 'task.reassigned'
  | 'task.completed'
  | 'task.deadline_24h'
  | 'task.deadline_2h'
  | 'task.overdue'
  | 'task.expired'
  | 'deal.assigned'
  | 'deal.reassigned'
  | 'deal.stage_changed'
  | 'deal.won'
  | 'deal.lost'
  | 'deal.close_7d'
  | 'deal.close_1d'
  | 'contact.assigned'
  | 'contact.reassigned';

// Whether this event type needs deduplication (scheduled, fires repeatedly)
const SCHEDULED_EVENTS = new Set<NotificationEventType>([
  'task.deadline_24h',
  'task.deadline_2h',
  'task.overdue',
  'task.expired',
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
  | { eventType: 'task.assigned' | 'task.reassigned' | 'task.completed' | 'task.deadline_24h' | 'task.deadline_2h' | 'task.overdue' | 'task.expired'; orgId: string; task: TaskCtx }
  | { eventType: 'deal.assigned' | 'deal.reassigned' | 'deal.stage_changed' | 'deal.won' | 'deal.lost' | 'deal.close_7d' | 'deal.close_1d'; orgId: string; deal: DealCtx }
  | { eventType: 'contact.assigned' | 'contact.reassigned'; orgId: string; contact: ContactCtx };

// ─── Message templates ────────────────────────────────────────────────────────

interface NotificationPayload { title: string; body: string }

/**
 * The zone every deadline in a push notification is rendered in.
 *
 * `toLocaleDateString('ru-RU')` pins the LANGUAGE and nothing else: with no `timeZone` the
 * formatter falls back to the host's zone. Production runs on a box set to Etc/UTC, so
 * "нужно сдать до 09:00" was printed for a task due at 12:00 Moscow time — every deadline
 * shown three hours early, to every user, on every scheduled reminder. It is invisible in
 * development because a developer's laptop is already on Moscow time and therefore renders
 * the correct string by accident; the defect only exists on the deployed box.
 *
 * Storage is unaffected and stays UTC — every timestamp column is TIMESTAMPTZ and every
 * comparison in the scheduler is done on Date instants. This constant is a presentation
 * decision only: it says which wall clock a Russian user reads these strings against.
 *
 * Per-reminder scheduling now carries its own user-zone snapshot. These legacy notification
 * templates still render in the market default until their event contexts carry a recipient
 * zone, but the default itself has one source of truth shared with the scheduler.
 */
export const DISPLAY_TIME_ZONE = DEFAULT_TIME_ZONE;

function formatDate(d: Date | null | undefined): string {
  if (!d) return '';
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    timeZone: DISPLAY_TIME_ZONE,
  });
}

function formatTime(d: Date | null | undefined): string {
  if (!d) return '';
  return d.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  });
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
      if (ctx.task.assigner && ctx.task.assigner.id !== ctx.task.assignee.id) {
        add(ctx.task.assigner.id, 'assigner', {
          title: 'Задача переназначена',
          body: `«${ctx.task.title}» → ${ctx.task.assignee.name}`,
        });
      }
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

    case 'task.expired':
      add(ctx.task.assigner?.id, 'assigner', {
        title: 'Напоминания остановлены',
        body: `Срок актуальности «${ctx.task.title}» закончился. Задача осталась открытой.`,
      });
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

    case 'deal.reassigned':
      add(ctx.deal.owner?.id, 'assignee', {
        title: 'Сделка переназначена вам',
        body: `${ctx.deal.creator?.name ?? 'Менеджер'} переназначил вам: «${ctx.deal.title}»`,
      });
      if (ctx.deal.creator && ctx.deal.owner && ctx.deal.creator.id !== ctx.deal.owner.id) {
        add(ctx.deal.creator.id, 'assigner', {
          title: 'Сделка переназначена',
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
      if (ctx.contact.assigner && ctx.contact.assigner.id !== ctx.contact.assignee.id) {
        add(ctx.contact.assigner.id, 'assigner', {
          title: 'Контакт назначен',
          body: `${ctx.contact.name} → ${ctx.contact.assignee.name}`,
        });
      }
      break;

    case 'contact.reassigned':
      add(ctx.contact.assignee.id, 'assignee', {
        title: 'Контакт переназначен вам',
        body: `${ctx.contact.assigner?.name ?? 'Менеджер'} переназначил вам: ${ctx.contact.name}`,
      });
      if (ctx.contact.assigner && ctx.contact.assigner.id !== ctx.contact.assignee.id) {
        add(ctx.contact.assigner.id, 'assigner', {
          title: 'Контакт переназначен',
          body: `${ctx.contact.name} → ${ctx.contact.assignee.name}`,
        });
      }
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

// ─── Main dispatcher ──────────────────────────────────────────────────────────

/**
 * Claim the right to notify one recipient about one scheduled event, exactly once.
 *
 * This used to be findUnique → `if (exists) continue` → create, which is a check-then-act:
 * the unique index on (event_type, entity_id, recipient_id) is the only thing that actually
 * decides, and it decides at INSERT time, long after the read said "not there yet". The
 * scheduler runs runDeadlineNotifications on a 60 s interval that never awaited its previous
 * pass, so a slow pass overlapped its own successor over the same due tasks and both read
 * "not sent". The loser's P2002 then escaped dispatchNotification, killed the loop for every
 * remaining recipient of that event, and was swallowed by the `.catch(console.error)` on the
 * interval — permanently, because the winner's row now exists, so the retry on the next tick
 * skips the duplicate and never reaches the recipients that were cut off.
 *
 * `createMany({ skipDuplicates: true })` is one INSERT ... ON CONFLICT DO NOTHING, so the
 * decision is made where the constraint lives: `count === 1` means this caller won the row
 * and owes the recipient a notification, `count === 0` means someone already sent it. There
 * is no window between the two, and no exception to swallow.
 */
async function claimScheduledNotification(
  eventType: NotificationEventType,
  entityId: string,
  recipientId: string,
): Promise<boolean> {
  const claimed = await db.notificationSent.createMany({
    data: [{ event_type: eventType, entity_id: entityId, recipient_id: recipientId }],
    skipDuplicates: true,
  });

  return claimed.count === 1;
}

export async function dispatchNotification(ctx: EventContext): Promise<void> {
  const entityType = entityTypeFor(ctx.eventType);
  const entityId = entityIdFor(ctx);
  const messages = buildMessages(ctx);
  const deduplicated = SCHEDULED_EVENTS.has(ctx.eventType);

  for (const { recipientId, role, msg } of messages) {
    // Per-recipient isolation, for the same reason services/sequences.ts isolates each
    // enrollment: one recipient's failure — a deleted user, a transient write error — must
    // not decide whether the other people on this event hear about it at all. An event with
    // an assignee and an assigner has two independent deliveries, not one transaction.
    try {
      // Scheduled events fire repeatedly by design (the 24 h / 2 h / overdue windows overlap
      // several ticks), so they are deduplicated. Everything else is emitted by a domain
      // write that happened once and needs no claim.
      if (deduplicated && !(await claimScheduledNotification(ctx.eventType, entityId, recipientId))) {
        continue;
      }

      try {
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
      } catch (error) {
        // The claim is only meaningful if it is followed by a delivery. Having taken the row
        // and then failed to write the notification, release it so the next tick can retry —
        // otherwise the dedup row is a tombstone for a message nobody ever received.
        if (deduplicated) {
          await db.notificationSent
            .deleteMany({
              where: { event_type: ctx.eventType, entity_id: entityId, recipient_id: recipientId },
            })
            .catch(() => undefined);
        }
        throw error;
      }

      // Push is best-effort and already fire-and-forget: an unreachable device must not undo
      // the in-app notification that was just written.
      void sendPushToUser(recipientId, ctx.orgId, { title: msg.title, body: msg.body, data: { entityType, entityId } });
    } catch (error) {
      console.error(`[notifications] ${ctx.eventType} delivery to one recipient failed`, error);
    }
  }
}

// ─── Context builders (fetch from DB) ────────────────────────────────────────

async function userSnap(id: string | null | undefined): Promise<UserSnap | null> {
  if (!id) return null;
  const u = await db.user.findUnique({ where: { id }, select: { id: true, name: true, push_token: true } });
  return u ?? null;
}

export async function taskCtx(taskId: string, assignerId?: string): Promise<TaskCtx | null> {
  const t = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, due_date: true, assigned_to: true, created_by: true },
  });
  if (!t) return null;
  const [assignee, assigner] = await Promise.all([
    userSnap(t.assigned_to),
    userSnap(assignerId ?? t.created_by),
  ]);
  if (!assignee) return null;
  return { id: t.id, title: t.title, due_date: t.due_date, assignee, assigner };
}

export async function dealCtx(dealId: string, stageName?: string, actorId?: string): Promise<DealCtx | null> {
  const d = await db.deal.findUnique({
    where: { id: dealId },
    select: { id: true, title: true, expected_close: true, assigned_to: true, created_by: true, stage: { select: { name: true } } },
  });
  if (!d) return null;
  const [owner, creator] = await Promise.all([userSnap(d.assigned_to), userSnap(actorId ?? d.created_by)]);
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
