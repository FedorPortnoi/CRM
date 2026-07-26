import { Prisma, CalendarEventStatus } from '@prisma/client';
import { db } from '../../services/db';
import { registerTool, McpUser } from '../server';
import { validateMcpWriteReferences, requireMcpWrite } from '../validation';
import { getAccessibleUserIds, Requester } from '../../services/visibility';

type CalendarStatusValue = 'scheduled' | 'completed' | 'cancelled';

/**
 * The acting user's visibility cone, exactly as the REST calendar controller
 * resolves it for single-record access (`getAccessibleUserIds` — self plus the
 * whole subtree beneath them).  `null` means owner/admin — no per-user
 * restriction — so every `...coneWhere(visibleIds)` spread below is a no-op for
 * them and no role is special-cased here.
 *
 * McpUser.role is a plain string from the JWT; cast to the Requester shape the
 * visibility service expects, the same cast the deal tools use.  An unknown or
 * absent role falls through to the member branch inside getVisibleUserIds, so
 * it fails closed (restricted) rather than open.
 */
function visibilityCone(user: McpUser): Promise<string[] | null> {
  return getAccessibleUserIds(user as Requester);
}

/**
 * The per-user restriction added to an already org-scoped CalendarEvent `where`.
 * The cone is additive: `organization_id` always stays on the query.
 *
 * Coned on `created_by`, mirroring the REST calendar controller. CalendarEvent
 * has no `assigned_to` column, and `attendee_ids` is a Json blob the REST path
 * only ever reads as a caller-supplied *filter* (`array_contains`), never as a
 * visibility grant — so attendance does not widen the cone here either. Events
 * with a NULL `created_by` fall outside every non-null cone, which is the same
 * fail-closed behaviour REST already has.
 */
function coneWhere(visibleIds: string[] | null): Prisma.CalendarEventWhereInput {
  return visibleIds === null ? {} : { created_by: { in: visibleIds } };
}

function isCalendarStatus(v: unknown): v is CalendarStatusValue {
  return v === 'scheduled' || v === 'completed' || v === 'cancelled';
}

const eventInclude = {
  contact: { select: { id: true, first_name: true, last_name: true } },
  deal: { select: { id: true, title: true } },
} as const;

registerTool(
  'get_events',
  'List calendar events for the authenticated org with optional filters',
  {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'ISO 8601 lower bound for start_time' },
      end: { type: 'string', description: 'ISO 8601 upper bound for start_time' },
      contact_id: { type: 'string', description: 'Filter by contact UUID' },
      deal_id: { type: 'string', description: 'Filter by deal UUID' },
      status: { type: 'string', enum: ['scheduled', 'completed', 'cancelled'] },
      page: { type: 'integer', default: 1 },
      per_page: { type: 'integer', default: 20, maximum: 100 },
    },
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const start = typeof args.start === 'string' ? args.start : undefined;
    const end = typeof args.end === 'string' ? args.end : undefined;
    const contact_id = typeof args.contact_id === 'string' ? args.contact_id : undefined;
    const deal_id = typeof args.deal_id === 'string' ? args.deal_id : undefined;
    const status = isCalendarStatus(args.status) ? args.status : undefined;
    const page = typeof args.page === 'number' ? Math.max(1, Math.floor(args.page)) : 1;
    const per_page = typeof args.per_page === 'number' ? Math.min(100, Math.max(1, Math.floor(args.per_page))) : 20;

    const visibleIds = await visibilityCone(user);

    const where: Prisma.CalendarEventWhereInput = {
      organization_id: user.org_id,
      ...coneWhere(visibleIds),
      ...(status ? { status } : { status: { not: CalendarEventStatus.cancelled } }),
      ...(contact_id && { contact_id }),
      ...(deal_id && { deal_id }),
      ...((start || end) && {
        start_time: {
          ...(start && { gte: new Date(start) }),
          ...(end && { lte: new Date(end) }),
        },
      }),
    };

    const [events, total] = await Promise.all([
      db.calendarEvent.findMany({
        where,
        skip: (page - 1) * per_page,
        take: per_page,
        orderBy: { start_time: 'asc' },
        include: eventInclude,
      }),
      db.calendarEvent.count({ where }),
    ]);

    return { data: events, meta: { total, page, per_page } };
  },
);

registerTool(
  'get_event',
  'Get a single calendar event by ID',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Calendar event UUID' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const id = typeof args.id === 'string' ? args.id : '';

    const visibleIds = await visibilityCone(user);

    const event = await db.calendarEvent.findFirst({
      where: { id, organization_id: user.org_id, ...coneWhere(visibleIds) },
      include: eventInclude,
    });

    // Out-of-cone events read exactly like non-existent ones — never leak that
    // the id belongs to somebody else's branch.
    if (!event) {
      return { error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } };
    }

    return { data: event };
  },
);

registerTool(
  'create_event',
  'Create a new calendar event',
  {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title' },
      start_time: { type: 'string', description: 'Start time (ISO 8601)' },
      end_time: { type: 'string', description: 'End time (ISO 8601, must be after start_time)' },
      description: { type: 'string' },
      contact_id: { type: 'string', description: 'Contact UUID to link' },
      deal_id: { type: 'string', description: 'Deal UUID to link' },
      location: { type: 'string' },
      meeting_url: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['title', 'start_time', 'end_time'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    // calendar.ts was the only MCP tool file with no write-role gate, so a viewer —
    // read-only everywhere else — could create, update, cancel and complete events.
    // The assistant made these tools reachable over HTTP, which turned that into a
    // live hole. contacts/deals/tasks have gated their writes this way all along.
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const title = typeof args.title === 'string' ? args.title : '';
    const start_time = typeof args.start_time === 'string' ? args.start_time : '';
    const end_time = typeof args.end_time === 'string' ? args.end_time : '';
    const description = typeof args.description === 'string' ? args.description : undefined;
    const contact_id = typeof args.contact_id === 'string' ? args.contact_id : undefined;
    const deal_id = typeof args.deal_id === 'string' ? args.deal_id : undefined;
    const location = typeof args.location === 'string' ? args.location : undefined;
    const meeting_url = typeof args.meeting_url === 'string' ? args.meeting_url : undefined;
    const notes = typeof args.notes === 'string' ? args.notes : undefined;

    const startDate = new Date(start_time);
    const endDate = new Date(end_time);

    if (endDate.getTime() <= startDate.getTime()) {
      return { error: { code: 'VALIDATION_ERROR', message: 'end_time must be after start_time' } };
    }

    const referenceError = await validateMcpWriteReferences(user, { contact_id, deal_id });
    if (referenceError) {
      return referenceError;
    }

    // No cone check needed: created_by is forced to the caller, so a new event
    // always lands inside their own branch.

    const event = await db.calendarEvent.create({
      data: {
        title,
        start_time: startDate,
        end_time: endDate,
        description,
        contact_id,
        deal_id,
        location,
        meeting_url,
        notes,
        attendee_ids: [],
        organization_id: user.org_id,
        created_by: user.sub,
        status: CalendarEventStatus.scheduled,
      },
      include: eventInclude,
    });

    return { data: event };
  },
);

registerTool(
  'update_event',
  'Update fields on an existing calendar event',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Calendar event UUID' },
      title: { type: 'string' },
      start_time: { type: 'string', description: 'ISO 8601' },
      end_time: { type: 'string', description: 'ISO 8601' },
      description: { type: 'string' },
      location: { type: 'string' },
      meeting_url: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    // calendar.ts was the only MCP tool file with no write-role gate, so a viewer —
    // read-only everywhere else — could create, update, cancel and complete events.
    // The assistant made these tools reachable over HTTP, which turned that into a
    // live hole. contacts/deals/tasks have gated their writes this way all along.
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const id = typeof args.id === 'string' ? args.id : '';

    const visibleIds = await visibilityCone(user);

    // Cone-scoped lookup gates the mutation below: an out-of-cone id resolves to
    // null here and returns before any write, indistinguishable from a bad id.
    const event = await db.calendarEvent.findFirst({
      where: { id, organization_id: user.org_id, ...coneWhere(visibleIds) },
    });

    if (!event) {
      return { error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } };
    }

    if (event.status === CalendarEventStatus.cancelled) {
      return { error: { code: 'EVENT_CANCELLED', message: 'Cannot update a cancelled event' } };
    }

    const start_time = typeof args.start_time === 'string' ? new Date(args.start_time) : undefined;
    const end_time = typeof args.end_time === 'string' ? new Date(args.end_time) : undefined;

    const nextStart = start_time ?? event.start_time;
    const nextEnd = end_time ?? event.end_time;

    if (nextEnd.getTime() <= nextStart.getTime()) {
      return { error: { code: 'VALIDATION_ERROR', message: 'end_time must be after start_time' } };
    }

    const updateData: Prisma.CalendarEventUncheckedUpdateInput = {};
    if (typeof args.title === 'string') updateData.title = args.title;
    if (start_time) updateData.start_time = start_time;
    if (end_time) updateData.end_time = end_time;
    if (typeof args.description === 'string') updateData.description = args.description;
    if (typeof args.location === 'string') updateData.location = args.location;
    if (typeof args.meeting_url === 'string') updateData.meeting_url = args.meeting_url;
    if (typeof args.notes === 'string') updateData.notes = args.notes;

    const updated = await db.calendarEvent.update({
      where: { id },
      data: updateData,
      include: eventInclude,
    });

    return { data: updated };
  },
);

registerTool(
  'cancel_event',
  'Cancel a calendar event',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Calendar event UUID' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    // calendar.ts was the only MCP tool file with no write-role gate, so a viewer —
    // read-only everywhere else — could create, update, cancel and complete events.
    // The assistant made these tools reachable over HTTP, which turned that into a
    // live hole. contacts/deals/tasks have gated their writes this way all along.
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const id = typeof args.id === 'string' ? args.id : '';

    const visibleIds = await visibilityCone(user);

    // Cone-scoped lookup gates the mutation below: an out-of-cone id resolves to
    // null here and returns before any write, indistinguishable from a bad id.
    const event = await db.calendarEvent.findFirst({
      where: { id, organization_id: user.org_id, ...coneWhere(visibleIds) },
    });

    if (!event) {
      return { error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } };
    }

    if (event.status === CalendarEventStatus.cancelled) {
      return { error: { code: 'EVENT_ALREADY_CANCELLED', message: 'Event is already cancelled' } };
    }

    const updated = await db.calendarEvent.update({
      where: { id },
      data: { status: CalendarEventStatus.cancelled },
      include: eventInclude,
    });

    return { data: updated };
  },
);

registerTool(
  'complete_event',
  'Toggle a calendar event between completed and scheduled (calling twice undoes completion)',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Calendar event UUID' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    // calendar.ts was the only MCP tool file with no write-role gate, so a viewer —
    // read-only everywhere else — could create, update, cancel and complete events.
    // The assistant made these tools reachable over HTTP, which turned that into a
    // live hole. contacts/deals/tasks have gated their writes this way all along.
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const id = typeof args.id === 'string' ? args.id : '';

    const visibleIds = await visibilityCone(user);

    // Cone-scoped lookup gates the mutation below: an out-of-cone id resolves to
    // null here and returns before any write, indistinguishable from a bad id.
    const event = await db.calendarEvent.findFirst({
      where: { id, organization_id: user.org_id, ...coneWhere(visibleIds) },
    });

    if (!event) {
      return { error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } };
    }

    if (event.status === CalendarEventStatus.cancelled) {
      return { error: { code: 'EVENT_CANCELLED', message: 'Cannot complete a cancelled event' } };
    }

    const updated = await db.calendarEvent.update({
      where: { id },
      data:
        event.status === CalendarEventStatus.completed
          ? { status: CalendarEventStatus.scheduled, completed_at: null }
          : { status: CalendarEventStatus.completed, completed_at: new Date() },
      include: eventInclude,
    });

    return { data: updated };
  },
);
