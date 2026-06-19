import { db } from './db';

export type TimelineItem =
  | { type: 'message'; id: string; summary: string | null; created_at: Date }
  | { type: 'task'; id: string; summary: string; created_at: Date }
  | { type: 'meeting'; id: string; summary: string; created_at: Date };

export type ContactTimeline = {
  contact_id: string;
  items: TimelineItem[];
};

/**
 * Return the merged, reverse-chronological activity timeline for a contact.
 * Includes messages, tasks, and calendar events.
 *
 * Does NOT check org ownership — callers must verify the contact belongs to
 * their org before calling this function.
 */
export async function getContactTimeline(orgId: string, contactId: string): Promise<ContactTimeline> {
  const [messages, tasks, events] = await Promise.all([
    db.message.findMany({
      where: { contact_id: contactId, organization_id: orgId },
      select: { id: true, body: true, channel: true, created_at: true },
    }),
    db.task.findMany({
      where: { contact_id: contactId, organization_id: orgId },
      select: { id: true, title: true, created_at: true },
    }),
    db.calendarEvent.findMany({
      where: { contact_id: contactId, organization_id: orgId },
      select: { id: true, title: true, created_at: true },
    }),
  ]);

  const items: TimelineItem[] = [
    ...messages.map(m => ({ type: 'message' as const, id: m.id, summary: m.body, created_at: m.created_at })),
    ...tasks.map(t => ({ type: 'task' as const, id: t.id, summary: t.title, created_at: t.created_at })),
    ...events.map(e => ({ type: 'meeting' as const, id: e.id, summary: e.title, created_at: e.created_at })),
  ].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

  return { contact_id: contactId, items };
}
