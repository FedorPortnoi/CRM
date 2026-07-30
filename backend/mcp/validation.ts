import { can, type Capability } from '../services/capabilities';
import { db } from '../services/db';
import { validateAuthSession } from '../services/sessions';
import type { McpUser } from './server';

type McpPrincipal = { sub: string; org_id: string; sid?: string };

export type McpToolError = {
  error: {
    code: string;
    message: string;
  };
};

type McpWriteReferences = {
  assigned_to?: string;
  contact_id?: string;
  deal_id?: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function mcpError(code: string, message: string): McpToolError {
  return { error: { code, message } };
}

export async function validateMcpPrincipal(user: McpPrincipal): Promise<McpToolError | null> {
  if (!isNonEmptyString(user.sub) || !isNonEmptyString(user.org_id) || !isNonEmptyString(user.sid)) {
    return mcpError('INVALID_TOKEN', 'JWT payload must include sub, org_id, and sid');
  }

  const [activeUser, org] = await Promise.all([
    db.user.findFirst({
      where: { id: user.sub, organization_id: user.org_id, is_active: true },
      select: { id: true },
    }),
    db.org.findUnique({
      where: { id: user.org_id },
      select: { id: true },
    }),
  ]);

  if (!activeUser || !org) {
    return mcpError('UNAUTHORIZED', 'Authenticated user is inactive or does not belong to an active organization');
  }

  const activeSession = await validateAuthSession({
    sessionId: user.sid,
    userId: user.sub,
    organizationId: user.org_id,
  });
  if (!activeSession) {
    return mcpError('SESSION_REVOKED', 'Authentication session has expired or was revoked');
  }

  return null;
}

async function activeUserBelongsToOrg(userId: string, orgId: string): Promise<boolean> {
  const user = await db.user.findFirst({
    where: { id: userId, organization_id: orgId, is_active: true },
    select: { id: true },
  });

  return user !== null;
}

async function contactBelongsToOrg(contactId: string, orgId: string): Promise<boolean> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, organization_id: orgId },
    select: { id: true },
  });

  return contact !== null;
}

async function dealBelongsToOrg(dealId: string, orgId: string): Promise<boolean> {
  const deal = await db.deal.findFirst({
    where: { id: dealId, organization_id: orgId },
    select: { id: true },
  });

  return deal !== null;
}

export async function validateMcpWriteReferences(
  user: McpPrincipal,
  refs: McpWriteReferences,
): Promise<McpToolError | null> {
  const [ownsAssignee, ownsContact, ownsDeal] = await Promise.all([
    refs.assigned_to === undefined || refs.assigned_to === user.sub
      ? Promise.resolve(true)
      : activeUserBelongsToOrg(refs.assigned_to, user.org_id),
    refs.contact_id === undefined
      ? Promise.resolve(true)
      : contactBelongsToOrg(refs.contact_id, user.org_id),
    refs.deal_id === undefined
      ? Promise.resolve(true)
      : dealBelongsToOrg(refs.deal_id, user.org_id),
  ]);

  if (!ownsAssignee) {
    return mcpError('FORBIDDEN', 'Assigned user does not belong to your organization');
  }

  if (!ownsContact) {
    return mcpError('FORBIDDEN', 'Contact does not belong to your organization');
  }

  if (!ownsDeal) {
    return mcpError('FORBIDDEN', 'Deal does not belong to your organization');
  }

  return null;
}

// ─── Capability gate ─────────────────────────────────────────────────────────
//
// WHAT WAS HERE BEFORE, AND WHY IT WAS NOT ENOUGH
//
// `requireMcpWrite(user)` asked one binary question — hasAnyWriteCapability() —
// for every write tool in the registry. That is the right shape for the HTTP
// preHandler, which sees a method and a URL and nothing else, but it is far too
// coarse here, because an MCP tool name says exactly WHICH entity is about to be
// mutated. A `support` user holds contacts.write and tasks.write and NOT
// deals.write; under one shared gate they passed it and created deals through
// the assistant. The assistant was more powerful than the person using it, which
// is the one thing it must never be.
//
// So the gate now asks per tool, and the question it asks lives in one table.
//
/**
 * Which capability each MCP tool requires, keyed by tool name.
 *
 * Deliberately ONE table rather than a capability literal at each call site —
 * the same reasoning as `ACTION_CAPABILITY` in backend/api/authenticate.ts: the
 * whole authorization surface of the assistant is legible in a single screen,
 * and it cannot drift from the gate that reads it.
 *
 * A tool ABSENT from this table is ungated: the plain entity reads
 * (get_contacts, get_deal, get_events, get_pipelines …) are reachable by any
 * role, and the visibility cone — not the role — decides which ROWS come back.
 * See `requireMcpToolCapability` for what happens when a gated tool is missing a
 * row, and `mcpToolAllowedForRole` for why absence means "offer it" there.
 *
 * The mappings mirror what the same operation costs elsewhere in the product:
 *   - merge_contacts is contacts.bulk, NOT contacts.write. It archives one
 *     record and rewrites the foreign keys of four tables; capabilities.ts calls
 *     that out by name ("import, bulk assign/archive, merge") and
 *     authenticate.ts already routes any POST …/merge to contacts.bulk. Owner
 *     and admin only.
 *   - calendar writes are tasks.write. There is no calendar capability, and a
 *     meeting is scheduled work with a due time — the task tier, not the deal
 *     tier. (activities.write would grant the identical set of roles today, so
 *     nothing hinges on the choice; tasks.write is the honest name for it.)
 *   - the six analytics tools are revenue.view because their payload carries
 *     money: deal `total_value` in get_dashboard / get_funnel / get_lead_sources
 *     / get_rep_performance and revenue itself in get_revenue.
 *     get_pipeline_health is the one that carries no rouble figure — only
 *     conversion rates — and is gated anyway: revenue.view is defined as
 *     "monetary figures AND revenue analytics", and stage-by-stage conversion is
 *     the latter. A `support` operator has no more business reading it than the
 *     app gives them.
 */
export const MCP_TOOL_CAPABILITIES = {
  create_contact: 'contacts.write',
  update_contact: 'contacts.write',
  archive_contact: 'contacts.write',
  merge_contacts: 'contacts.bulk',

  create_deal: 'deals.write',
  update_deal: 'deals.write',
  move_deal_to_stage: 'deals.write',

  create_task: 'tasks.write',
  update_task: 'tasks.write',
  complete_task: 'tasks.write',

  create_event: 'tasks.write',
  update_event: 'tasks.write',
  cancel_event: 'tasks.write',
  complete_event: 'tasks.write',

  // Pipeline READS. The mutating deal tools above were gated from the start and
  // these were not, on the assumption that "read" needed no gate — but a deal
  // row carries `value` and `currency`, so listing deals is a way to read the
  // org's money one record at a time, which is exactly what `revenue.view`
  // below exists to prevent. `support` holds neither capability.
  //
  // The REST twin of this gate is the `deals.read` branch of adminRoutePolicy in
  // ../api/authenticate.ts. Both surfaces must answer the same question, or the
  // assistant becomes either a softer door than the API or a stricter one — and
  // both have been real bugs in this codebase.
  get_deals: 'deals.read',
  get_deal: 'deals.read',
  get_pipelines: 'deals.read',

  get_dashboard: 'revenue.view',
  get_funnel: 'revenue.view',
  get_lead_sources: 'revenue.view',
  get_pipeline_health: 'revenue.view',
  get_rep_performance: 'revenue.view',
  get_revenue: 'revenue.view',
} as const satisfies Record<string, Capability>;

export type McpGatedTool = keyof typeof MCP_TOOL_CAPABILITIES;

/**
 * The refusal text, exported so a caller can tell a capability denial apart from
 * the other FORBIDDEN a tool can return (`validateMcpWriteReferences` uses the
 * same code for a cross-org reference). The code stays 'FORBIDDEN' because that
 * is what the existing tool-cone suites and the assistant's error handling read.
 */
export function mcpCapabilityDeniedMessage(capability: Capability): string {
  return `This role is not permitted to perform this operation (requires ${capability})`;
}

/** The primitive: may this principal exercise this capability at all? */
export function requireMcpCapability(user: McpUser, capability: Capability): McpToolError | null {
  if (!can(user.role, capability)) {
    return mcpError('FORBIDDEN', mcpCapabilityDeniedMessage(capability));
  }
  return null;
}

/**
 * The form every gated tool actually calls. Looks the requirement up by tool
 * name so the mapping exists in exactly one place.
 *
 * An unmapped name falls back to `org.manage` — owner and admin only — for the
 * same reason authenticate.ts does: a write tool whose row somebody forgot LOCKS
 * DOWN instead of opening up. It is a bug either way, and
 * tests/unit/backend/mcp-capability-parity.test.ts fails on any mutating tool
 * name that is missing from the table, so it is a bug that cannot ship quietly.
 */
export function requireMcpToolCapability(user: McpUser, tool: string): McpToolError | null {
  const required: Capability = MCP_TOOL_CAPABILITIES[tool as McpGatedTool] ?? 'org.manage';
  return requireMcpCapability(user, required);
}

/**
 * Whether this role could invoke this tool at all — the question
 * `listMcpTools()` asks so a role is never offered a tool that would refuse it.
 *
 * Absence from the table means "yes" here, because the catalogue must describe
 * the gates that EXIST rather than invent a second policy: an ungated tool
 * really is invocable by anyone. Note the deliberate asymmetry with
 * `requireMcpToolCapability`, where absence means "no" — the two answer
 * different questions. There, a handler has already declared that it needs
 * gating, and the missing row is the mistake.
 */
export function mcpToolAllowedForRole(role: string | null | undefined, tool: string): boolean {
  const required = MCP_TOOL_CAPABILITIES[tool as McpGatedTool];
  return required === undefined || can(role, required);
}
