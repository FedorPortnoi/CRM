import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The AI assistant must be EXACTLY as powerful as the person using it.
//
// Every MCP tool runs with the caller's own principal, so the only thing that
// can make the assistant stronger than its user is a gate that asks a coarser
// question than the app does. That is precisely what happened:
// `requireMcpWrite()` asked hasAnyWriteCapability() — "may this role write
// ANYTHING?" — for every write tool in the registry. A `support` operator holds
// contacts.write and tasks.write and NOT deals.write; they passed the shared
// gate and created deals through the assistant that no capability of theirs
// permits. Symmetrically, the six analytics tools hand back money with no
// revenue.view check, and `support` does not hold revenue.view either.
//
// THE LOAD-BEARING TEST IN THIS FILE IS A PROPERTY, NOT A LIST OF CASES.
//
// `every role × every gated tool → refused iff the role lacks the mapped
// capability` is what actually holds the invariant, because it grows on its own:
// a role added to capabilities.ts and a tool added to MCP_TOOL_CAPABILITIES are
// both swept up with no edit here. The named regressions further down
// (support→create_deal, support→get_revenue) are there so a reader can see the
// bug that motivated the change, not because they are the coverage.
//
// The remaining gap this file also pins: a write tool that FORGETS its row in
// the table. `requireMcpToolCapability` falls back to org.manage so it fails
// closed, but a locked-out tool is still a bug, so «every mutating tool name is
// mapped» is asserted structurally against the live registry.
// ---------------------------------------------------------------------------

const ORG = '77777777-7777-4777-8777-000000000001';
const CALLER = '77777777-7777-4777-8777-00000000000a';
const CONTACT = '77777777-7777-4777-8777-000000000101';
const CONTACT_2 = '77777777-7777-4777-8777-000000000102';
const DEAL = '77777777-7777-4777-8777-000000000201';
const PIPELINE = '77777777-7777-4777-8777-000000000301';
const STAGE = '77777777-7777-4777-8777-000000000401';
const TASK = '77777777-7777-4777-8777-000000000501';
const EVENT = '77777777-7777-4777-8777-000000000601';

// ─── Boot the real registry outside a running server ──────────────────────────
// backend/mcp/server and backend/mcp/validation are the code under test, so
// NEITHER is mocked away. Only the transport, the audit sink, the database and
// the domain services behind the tools are.

vi.mock('../../../backend/config/env', () => ({ loadLocalEnv: () => undefined }));
vi.mock('../../../backend/config/security', () => ({
  getJwtSecret: () => 'test-secret-not-a-real-key-0123456789abcdef',
}));
vi.mock('fast-jwt', () => ({ createVerifier: () => () => ({}) }));
vi.mock('../../../backend/services/audit', () => ({ auditLog: vi.fn() }));

/**
 * Every Prisma entry point a tool in the registry can mutate through. They are
 * asserted NOT to have been called on the refusal paths — a gate that returns
 * FORBIDDEN *after* the write would satisfy an error-shape assertion and still
 * have corrupted the tenant's data.
 */
const dbMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(async () => []),
  $transaction: vi.fn(async () => undefined),
  org: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  user: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
  contact: { findFirst: vi.fn(async () => null), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  deal: {
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    groupBy: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  task: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  message: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
  calendarEvent: {
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  pipeline: { findMany: vi.fn(async () => []) },
  pipelineStage: { findFirst: vi.fn(async () => null) },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

// The domain layer, which is where the real writes would land. Same role as the
// Prisma mocks above: if one of these is called on a refusal path, the gate ran
// too late.
const contactDomainMock = vi.hoisted(() => ({
  listContactsForUser: vi.fn(async () => ({ data: [], total: 0 })),
  getContactForUser: vi.fn(async () => null),
  createContactForUser: vi.fn(async () => ({ id: 'contact-fixture' })),
  updateContactForUser: vi.fn(async () => ({ id: 'contact-fixture' })),
  archiveContactForUser: vi.fn(async () => ({ id: 'contact-fixture' })),
  ContactNotFoundError: class ContactNotFoundError extends Error { code = 'NOT_FOUND'; },
  ContactForbiddenError: class ContactForbiddenError extends Error { code = 'FORBIDDEN'; },
}));

const dealDomainMock = vi.hoisted(() => ({
  listDealsForUser: vi.fn(async () => ({ data: [], total: 0 })),
  getDealForUser: vi.fn(async () => null),
  createDealForUser: vi.fn(async () => ({ id: 'deal-fixture' })),
  updateDealForUser: vi.fn(async () => ({ id: 'deal-fixture' })),
  DealDomainError: class DealDomainError extends Error {
    domainError = { code: 'DEAL_NOT_FOUND', message: 'Deal not found' };
  },
}));

const taskDomainMock = vi.hoisted(() => ({
  listTasksForUser: vi.fn(async () => ({ data: [], total: 0 })),
  getTaskForUser: vi.fn(async () => null),
  createTaskForUser: vi.fn(async () => ({ ok: true, task: { id: 'task-fixture' } })),
  updateTaskForUser: vi.fn(async () => ({ ok: true, task: { id: 'task-fixture' } })),
  completeTaskForUser: vi.fn(async () => ({ ok: true, task: { id: 'task-fixture' } })),
  getOverdueTasksForUser: vi.fn(async () => []),
}));

vi.mock('../../../backend/services/contact-domain', () => contactDomainMock);
vi.mock('../../../backend/services/deal-domain', () => dealDomainMock);
vi.mock('../../../backend/services/task-domain', () => taskDomainMock);

// The cone is a different axis (see capabilities.ts). Pinned wide open here on
// purpose: a refusal in this file must be attributable to the ROLE, never to
// hierarchy narrowing the rows to none.
vi.mock('../../../backend/services/visibility', () => ({
  getAccessibleUserIds: vi.fn(async () => null),
  getVisibleUserIds: vi.fn(async () => null),
  canSeeUser: vi.fn(() => true),
}));

vi.mock('../../../backend/services/workflows', () => ({ evaluateWorkflows: vi.fn(async () => undefined) }));
vi.mock('../../../backend/api/controllers/activities', () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock('../../../backend/services/notificationEngine', () => ({
  dispatchNotification: vi.fn(async () => undefined),
  dealCtx: vi.fn(async () => null),
}));

// The principal check is a database question (is the user active, is the session
// live) and is answered elsewhere — tests/unit/backend/mcp-validation.test.ts.
// The rest of the module, including MCP_TOOL_CAPABILITIES and the gate itself,
// is the code under test and stays REAL.
vi.mock('../../../backend/mcp/validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../backend/mcp/validation')>()),
  validateMcpPrincipal: vi.fn(async () => null),
}));

import { invokeMcpTool, listMcpTools } from '../../../backend/mcp/server';
import {
  MCP_TOOL_CAPABILITIES,
  mcpCapabilityDeniedMessage,
  requireMcpCapability,
  requireMcpToolCapability,
  mcpToolAllowedForRole,
  type McpGatedTool,
} from '../../../backend/mcp/validation';
import {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  can,
  type Capability,
  type Role,
} from '../../../backend/services/capabilities';

const ROLES = Object.keys(ROLE_CAPABILITIES) as Role[];
const GATED = Object.entries(MCP_TOOL_CAPABILITIES) as Array<[McpGatedTool, Capability]>;

function principal(role: string) {
  return { sub: CALLER, org_id: ORG, role, sid: 'sid-parity' };
}

/**
 * Arguments good enough for the handler to get PAST its own input validation, so
 * that a refusal can only have come from the capability gate. The allowed paths
 * are deliberately allowed to fail further downstream (NOT_FOUND against the
 * empty fixtures) — this file asserts who is refused, not what a tool returns.
 */
const ARGS: Partial<Record<McpGatedTool, Record<string, unknown>>> = {
  create_contact: { first_name: 'Тест' },
  update_contact: { id: CONTACT, company: 'ООО Ромашка' },
  archive_contact: { id: CONTACT },
  merge_contacts: { target_id: CONTACT, source_id: CONTACT_2 },

  create_deal: { title: 'Поставка', contact_id: CONTACT, pipeline_id: PIPELINE, stage_id: STAGE },
  update_deal: { id: DEAL, value: 150000 },
  move_deal_to_stage: { id: DEAL, stage_id: STAGE },

  create_task: { title: 'Позвонить клиенту', assigned_to: CALLER },
  update_task: { id: TASK, title: 'Перезвонить' },
  complete_task: { id: TASK },

  create_event: {
    title: 'Встреча',
    start_time: '2026-08-01T10:00:00.000Z',
    end_time: '2026-08-01T11:00:00.000Z',
  },
  update_event: { id: EVENT, title: 'Встреча перенесена' },
  cancel_event: { id: EVENT },
  complete_event: { id: EVENT },
};

/** Every mocked door a mutation could go through. */
function writeMocks(): Array<{ mock: { calls: unknown[][] } }> {
  return [
    dbMock.$transaction,
    dbMock.contact.create, dbMock.contact.update, dbMock.contact.updateMany,
    dbMock.deal.create, dbMock.deal.update, dbMock.deal.updateMany,
    dbMock.task.create, dbMock.task.update, dbMock.task.updateMany,
    dbMock.calendarEvent.create, dbMock.calendarEvent.update, dbMock.calendarEvent.updateMany,
    contactDomainMock.createContactForUser,
    contactDomainMock.updateContactForUser,
    contactDomainMock.archiveContactForUser,
    dealDomainMock.createDealForUser,
    dealDomainMock.updateDealForUser,
    taskDomainMock.createTaskForUser,
    taskDomainMock.updateTaskForUser,
    taskDomainMock.completeTaskForUser,
  ];
}

function writesAttempted(): number {
  return writeMocks().reduce((n, m) => n + m.mock.calls.length, 0);
}

/** The tool's own error envelope, if it returned one. */
function errorOf(result: unknown): { code?: string; message?: string } | undefined {
  if (!result || typeof result !== 'object') return undefined;
  return (result as { error?: { code?: string; message?: string } }).error;
}

/**
 * Did the CAPABILITY gate refuse this call? Matched on the message, not just the
 * code: `validateMcpWriteReferences` returns FORBIDDEN too (cross-org reference),
 * and a test that cannot tell the two apart would pass on the wrong refusal.
 */
async function refusedByCapabilityGate(tool: McpGatedTool, role: string): Promise<boolean> {
  const outcome = await invokeMcpTool(tool, { ...(ARGS[tool] ?? {}) }, principal(role));
  if (!outcome.ok) return false;
  const capability = MCP_TOOL_CAPABILITIES[tool];
  return errorOf(outcome.result)?.message === mcpCapabilityDeniedMessage(capability);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$queryRaw.mockResolvedValue([]);
  dbMock.org.findUniqueOrThrow.mockResolvedValue({ stalled_threshold_days: 30, decay_factor: 0.5 });
  dbMock.org.findUnique.mockResolvedValue({ id: ORG });
  dbMock.user.findFirst.mockResolvedValue({ id: CALLER });
});

// ═══ 0. The fixture is not vacuous ════════════════════════════════════════════

describe('the mapping under test is real and complete enough to matter', () => {
  it('covers every capability it claims to, and only real capabilities', () => {
    for (const [, capability] of GATED) {
      expect(CAPABILITIES).toContain(capability);
    }
  });

  it('spans more than one capability — a single-capability table would be the old bug', () => {
    expect(new Set(GATED.map(([, c]) => c)).size).toBeGreaterThan(3);
  });

  it('the roles it is exercised against really do differ in those capabilities', () => {
    // If this ever became uniform, every assertion below would be trivially
    // satisfied by a gate that always allows.
    expect(can('support', 'contacts.write')).toBe(true);
    expect(can('support', 'deals.write')).toBe(false);
    expect(can('support', 'revenue.view')).toBe(false);
    expect(can('marketer', 'deals.write')).toBe(false);
    expect(can('accountant', 'tasks.write')).toBe(false);
    expect(can('viewer', 'contacts.write')).toBe(false);
    expect(ROLES).toHaveLength(8);
  });
});

// ═══ 1. THE PROPERTY ══════════════════════════════════════════════════════════

describe('every role × every gated tool: refused iff the role lacks the capability', () => {
  for (const [tool, capability] of GATED) {
    for (const role of ROLES) {
      const permitted = can(role, capability);

      it(`${role} ${permitted ? 'may' : 'may NOT'} invoke ${tool} (${capability})`, async () => {
        expect(await refusedByCapabilityGate(tool, role)).toBe(!permitted);
      });
    }
  }

  it('a refused write never reaches the database or the domain layer', async () => {
    for (const [tool, capability] of GATED) {
      for (const role of ROLES) {
        if (can(role, capability)) continue;
        vi.clearAllMocks();
        await invokeMcpTool(tool, { ...(ARGS[tool] ?? {}) }, principal(role));
        expect(writesAttempted(), `${role} → ${tool} wrote before being refused`).toBe(0);
      }
    }
  });

  it('an unrecognised role claim is refused everything (fails closed)', async () => {
    for (const [tool] of GATED) {
      expect(await refusedByCapabilityGate(tool, 'no-such-role'), tool).toBe(true);
      expect(await refusedByCapabilityGate(tool, ''), tool).toBe(true);
    }
  });

  it('owner is refused nothing — the assistant is not WEAKER than its user either', async () => {
    for (const [tool] of GATED) {
      expect(await refusedByCapabilityGate(tool, 'owner'), tool).toBe(false);
    }
  });
});

// ═══ 2. The regressions that motivated all of the above ═══════════════════════

describe('the specific holes that were open', () => {
  it('support is refused create_deal — the bug: contacts.write is not deals.write', async () => {
    const outcome = await invokeMcpTool('create_deal', { ...ARGS.create_deal }, principal('support'));

    expect(outcome.ok).toBe(true);
    expect(errorOf(outcome.ok ? outcome.result : null)).toEqual({
      code: 'FORBIDDEN',
      message: mcpCapabilityDeniedMessage('deals.write'),
    });
    expect(dealDomainMock.createDealForUser).not.toHaveBeenCalled();
  });

  it('…while the same support user may still create a contact and a task', async () => {
    expect(await refusedByCapabilityGate('create_contact', 'support')).toBe(false);
    expect(await refusedByCapabilityGate('create_task', 'support')).toBe(false);
  });

  it('support is refused get_revenue — money the app never shows them', async () => {
    const outcome = await invokeMcpTool('get_revenue', {}, principal('support'));

    expect(errorOf(outcome.ok ? outcome.result : null)?.message).toBe(
      mcpCapabilityDeniedMessage('revenue.view'),
    );
    expect(dbMock.deal.findMany).not.toHaveBeenCalled();
  });

  it('accountant reads the money and writes nothing at all', async () => {
    expect(await refusedByCapabilityGate('get_revenue', 'accountant')).toBe(false);
    expect(await refusedByCapabilityGate('get_funnel', 'accountant')).toBe(false);
    expect(await refusedByCapabilityGate('create_contact', 'accountant')).toBe(true);
    expect(await refusedByCapabilityGate('create_task', 'accountant')).toBe(true);
    expect(await refusedByCapabilityGate('create_event', 'accountant')).toBe(true);
  });

  it('marketer works the contact base but cannot touch anyone else\'s deal', async () => {
    expect(await refusedByCapabilityGate('create_contact', 'marketer')).toBe(false);
    expect(await refusedByCapabilityGate('create_task', 'marketer')).toBe(false);
    expect(await refusedByCapabilityGate('update_deal', 'marketer')).toBe(true);
    expect(await refusedByCapabilityGate('move_deal_to_stage', 'marketer')).toBe(true);
  });

  it('a calendar write is the task tier, so support keeps it and accountant does not', async () => {
    expect(await refusedByCapabilityGate('create_event', 'support')).toBe(false);
    expect(await refusedByCapabilityGate('cancel_event', 'support')).toBe(false);
    expect(await refusedByCapabilityGate('create_event', 'viewer')).toBe(true);
  });

  it('merge_contacts is contacts.bulk, not contacts.write — owner and admin only', async () => {
    expect(await refusedByCapabilityGate('merge_contacts', 'owner')).toBe(false);
    expect(await refusedByCapabilityGate('merge_contacts', 'admin')).toBe(false);
    // head and member hold contacts.write; merging archives a record and
    // rewrites four tables' foreign keys, which is the bulk tier.
    expect(await refusedByCapabilityGate('merge_contacts', 'head')).toBe(true);
    expect(await refusedByCapabilityGate('merge_contacts', 'member')).toBe(true);
    expect(await refusedByCapabilityGate('merge_contacts', 'support')).toBe(true);
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });
});

// ═══ 3. The catalogue the model is offered ════════════════════════════════════

describe('listMcpTools offers a role only what that role can invoke', () => {
  async function names(role: string): Promise<string[]> {
    return (await listMcpTools(principal(role))).map((t) => t.name);
  }

  it('the owner sees the whole registry', async () => {
    const owner = await names('owner');

    expect(owner.length).toBeGreaterThan(20);
    for (const [tool] of GATED) expect(owner).toContain(tool);
  });

  it('the catalogue shrinks for every restricted role, and strictly', async () => {
    const owner = await names('owner');

    for (const role of ROLES) {
      if (role === 'owner' || role === 'admin') continue;
      const offered = await names(role);

      expect(offered.length, `${role} was offered as much as the owner`).toBeLessThan(owner.length);
      expect(offered.every((n) => owner.includes(n))).toBe(true);
    }
  });

  it('a viewer is offered no gated tool at all — including create_deal', async () => {
    const viewer = await names('viewer');

    expect(viewer).not.toContain('create_deal');
    for (const [tool] of GATED) expect(viewer, tool).not.toContain(tool);
    // …but the plain entity reads are still there: read-only is not no-op.
    expect(viewer).toContain('get_contacts');
    expect(viewer).toContain('get_deals');
    expect(viewer).toContain('get_tasks');
  });

  it('support is offered contact and task writes but no deal write and no money', async () => {
    const support = await names('support');

    expect(support).toContain('create_contact');
    expect(support).toContain('create_task');
    expect(support).toContain('create_event');
    expect(support).not.toContain('create_deal');
    expect(support).not.toContain('update_deal');
    expect(support).not.toContain('merge_contacts');
    expect(support).not.toContain('get_revenue');
    expect(support).not.toContain('get_dashboard');
  });

  it('accountant is offered the analytics and none of the writes', async () => {
    const accountant = await names('accountant');

    expect(accountant).toContain('get_revenue');
    expect(accountant).toContain('get_rep_performance');
    for (const [tool, capability] of GATED) {
      if (capability === 'revenue.view') continue;
      expect(accountant, tool).not.toContain(tool);
    }
  });

  it('closes the loop: nothing a role is offered refuses that role', async () => {
    for (const role of ROLES) {
      for (const name of await names(role)) {
        const capability = MCP_TOOL_CAPABILITIES[name as McpGatedTool];
        if (!capability) continue;
        expect(
          await refusedByCapabilityGate(name as McpGatedTool, role),
          `${role} was offered ${name} and then refused it`,
        ).toBe(false);
      }
    }
  });

  it('and the converse: nothing withheld from a role would have let that role in', async () => {
    const owner = await names('owner');

    for (const role of ROLES) {
      const offered = new Set(await names(role));
      for (const withheld of owner.filter((n) => !offered.has(n))) {
        expect(mcpToolAllowedForRole(role, withheld), `${role}/${withheld}`).toBe(false);
      }
    }
  });
});

// ═══ 4. A future write tool cannot slip through unmapped ══════════════════════

describe('the table cannot silently fall behind the registry', () => {
  // Every verb the registry uses for a mutation. A tool named with one of these
  // and absent from MCP_TOOL_CAPABILITIES is a write with no declared capability.
  const MUTATING_PREFIXES = ['create_', 'update_', 'delete_', 'archive_', 'cancel_', 'complete_', 'merge_', 'move_', 'assign_', 'send_'];

  it('every mutating tool in the live registry has a capability mapped', async () => {
    const registry = (await listMcpTools(principal('owner'))).map((t) => t.name);

    // Sanity: if the registry ever came back empty this assertion would be vacuous.
    expect(registry.length).toBeGreaterThan(20);

    const unmapped = registry
      .filter((name) => MUTATING_PREFIXES.some((p) => name.startsWith(p)))
      .filter((name) => !(name in MCP_TOOL_CAPABILITIES));

    expect(unmapped).toEqual([]);
  });

  it('every mapped tool actually exists in the registry — no rotten rows', async () => {
    const registry = new Set((await listMcpTools(principal('owner'))).map((t) => t.name));
    const missing = GATED.map(([tool]) => tool).filter((tool) => !registry.has(tool));

    expect(missing).toEqual([]);
  });

  it('an unmapped tool name fails CLOSED at the gate, open at the catalogue', () => {
    // The two questions differ on purpose; see the comments on both functions.
    // A handler asking to be gated with no row is a bug, so it locks down to
    // org.manage; a tool that never asks to be gated is a plain read.
    expect(requireMcpToolCapability(principal('member'), 'invented_tool')?.error.code).toBe('FORBIDDEN');
    expect(requireMcpToolCapability(principal('owner'), 'invented_tool')).toBeNull();
    expect(mcpToolAllowedForRole('viewer', 'invented_tool')).toBe(true);
  });
});

// ═══ 5. The primitive itself ══════════════════════════════════════════════════

describe('requireMcpCapability', () => {
  it('returns the McpToolError shape, not a throw', () => {
    expect(requireMcpCapability(principal('viewer'), 'deals.write')).toEqual({
      error: { code: 'FORBIDDEN', message: mcpCapabilityDeniedMessage('deals.write') },
    });
  });

  it('names the capability it wanted, so the refusal is diagnosable', () => {
    const denied = requireMcpCapability(principal('support'), 'revenue.view');

    expect(denied?.error.message).toContain('revenue.view');
  });

  it('passes a role that holds the capability', () => {
    expect(requireMcpCapability(principal('member'), 'deals.write')).toBeNull();
  });

  it('asks can(), so it agrees with every other gate in the product', () => {
    for (const role of ROLES) {
      for (const capability of CAPABILITIES) {
        expect(requireMcpCapability(principal(role), capability) === null).toBe(can(role, capability));
      }
    }
  });
});
