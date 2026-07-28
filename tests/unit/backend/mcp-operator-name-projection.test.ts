import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// No MCP tool result may carry an operator's ФИО.
//
// `User.name` in this product is an OPERATOR's ФИО — a second data subject
// riding along in payloads that are about a CUSTOMER. Three shared services
// still select it because the APP renders it (see the sibling test file
// task-contact-assignee-name-app-path.test.ts, which pins that half), so it
// cannot be deleted at the source the way c456e0f and cb88ba9 deleted theirs.
// It is stripped instead at the one door in front of the model:
// projectModelFacing(), applied by registerTool in backend/mcp/server.ts.
//
// These tests come in two halves.
//
//   1. The projection itself: what it drops, and — just as important — what it
//      must NOT drop. `pipeline.name` and `stage.name` are the reason the
//      assistant's redactToolResult() could never have done this job, so they
//      are asserted present, not merely unmentioned.
//
//   2. The wiring: a tool result actually goes through it, including a tool
//      invented inside this file that nobody reviewed. That last one is the
//      point of putting the projection at registerTool rather than patching
//      three call sites — a future leak has to be opted INTO.
//
// The fixture ФИО is deliberately unlike anything else in the repository, and
// the fake domain layer below still HANDS IT OVER. Delete the projection and
// these go red; they are not asserting against an empty fixture.
// ---------------------------------------------------------------------------

const ORG = '44444444-4444-4444-8444-000000000001';
const CALLER = '44444444-4444-4444-8444-00000000000a';
const OPERATOR_ID = '44444444-4444-4444-8444-00000000000b';
const TASK_ID = '55555555-5555-4555-8555-000000000001';

/** Distinctive on purpose: this string appears nowhere else in the codebase. */
const OPERATOR_FIO = 'Никодим Ржевусский-Пшеничнов';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url).href);
const SCHEMA_PATH = `${REPO_ROOT}backend/prisma/schema.prisma`;
const TOOLS_DIR = `${REPO_ROOT}backend/mcp/tools`;

// ─── Fake task-domain ─────────────────────────────────────────────────────────
// Returns the row the REAL getTaskForUser returns, ФИО and all. The projection
// is the only thing between it and the caller.

function taskRow(): Record<string, unknown> {
  return {
    id: TASK_ID,
    organization_id: ORG,
    title: 'Позвонить клиенту',
    status: 'pending',
    assigned_to: OPERATOR_ID,
    due_date: new Date('2026-01-01T00:00:00.000Z'),
    assignee: { id: OPERATOR_ID, name: OPERATOR_FIO },
    contact: { id: 'c1', first_name: 'Пётр', last_name: 'Клиентов' },
  };
}

const taskDomainMock = vi.hoisted(() => ({
  listTasksForUser: vi.fn(),
  getTaskForUser: vi.fn(),
  createTaskForUser: vi.fn(),
  updateTaskForUser: vi.fn(),
  completeTaskForUser: vi.fn(),
  getOverdueTasksForUser: vi.fn(),
}));

vi.mock('../../../backend/services/task-domain', () => taskDomainMock);

// ─── The real backend/mcp/server, with its transport concerns stubbed ─────────
// registerTool and invokeMcpTool are the code under test here, so the module is
// NOT mocked. Only what it needs to boot outside a running server is.

vi.mock('../../../backend/config/env', () => ({ loadLocalEnv: () => undefined }));
vi.mock('../../../backend/config/security', () => ({
  getJwtSecret: () => 'test-secret-not-a-real-key-0123456789abcdef',
}));
vi.mock('fast-jwt', () => ({ createVerifier: () => () => ({}) }));
vi.mock('../../../backend/services/audit', () => ({ auditLog: vi.fn() }));
vi.mock('../../../backend/mcp/validation', () => ({
  validateMcpPrincipal: vi.fn(async () => null),
  requireMcpWrite: vi.fn(() => null),
}));
vi.mock('../../../backend/services/db', () => ({ db: {} }));

// loadMcpTools() imports all five tool modules. Only the task tools are under
// test; the rest would drag in encryption, workflows and the notification
// engine for nothing.
vi.mock('../../../backend/mcp/tools/contacts', () => ({}));
vi.mock('../../../backend/mcp/tools/deals', () => ({}));
vi.mock('../../../backend/mcp/tools/calendar', () => ({}));
vi.mock('../../../backend/mcp/tools/analytics', () => ({}));

import { invokeMcpTool, registerTool } from '../../../backend/mcp/server';
import {
  projectModelFacing,
  USER_RELATION_KEYS,
  USER_ROW_MARKER_KEYS,
  OPERATOR_NAME_KEYS,
} from '../../../backend/mcp/model-projection';
import { redactToolResult } from '../../../backend/services/assistant';

const caller = { sub: CALLER, org_id: ORG, role: 'owner', sid: 'sid-1' };

/** Every leaf in a structure, at any depth, with the path it was found at. */
function walk(value: unknown, path = '$'): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((v, i) => walk(v, `${path}[${i}]`));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => walk(v, `${path}.${k}`));
  }
  return [{ path, value }];
}

function containsFio(value: unknown): boolean {
  return walk(value).some((leaf) => typeof leaf.value === 'string' && leaf.value.includes(OPERATOR_FIO));
}

async function invoke(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const outcome = await invokeMcpTool(name, args, caller);
  if (!outcome.ok) throw new Error(`tool ${name} failed: ${outcome.error.code}`);
  return outcome.result;
}

beforeEach(() => {
  taskDomainMock.getTaskForUser.mockResolvedValue(taskRow());
  taskDomainMock.getOverdueTasksForUser.mockResolvedValue([taskRow()]);
  taskDomainMock.listTasksForUser.mockResolvedValue({ data: [taskRow()], total: 1 });
});

// ═══ 1. The projection itself ═════════════════════════════════════════════════

describe('projectModelFacing strips operator names', () => {
  it('control: the fixture really does carry the ФИО, so absence below means something', () => {
    expect(containsFio(taskRow())).toBe(true);
    expect(taskRow().assignee).toMatchObject({ name: OPERATOR_FIO });
  });

  it('drops assignee.name and keeps assignee.id', () => {
    const out = projectModelFacing({ data: taskRow() }) as { data: { assignee: Record<string, unknown> } };

    expect(out.data.assignee).toEqual({ id: OPERATOR_ID });
    expect(out.data.assignee).not.toHaveProperty('name');
    expect(containsFio(out)).toBe(false);
  });

  it('keeps the scalar `assigned_to` uuid — the model chains tool calls on ids', () => {
    const out = projectModelFacing({ data: taskRow() }) as { data: { assigned_to: string } };

    expect(out.data.assigned_to).toBe(OPERATOR_ID);
  });

  it.each([...USER_RELATION_KEYS])('drops the name under the User relation key `%s`', (key) => {
    const out = projectModelFacing({ data: { [key]: { id: OPERATOR_ID, name: OPERATOR_FIO } } });

    expect(containsFio(out)).toBe(false);
    expect(JSON.stringify(out)).toContain(OPERATOR_ID);
  });

  it('reaches into arrays and inherits the array key', () => {
    const out = projectModelFacing({
      data: { reports: [{ id: 'u1', name: OPERATOR_FIO }, { id: 'u2', name: OPERATOR_FIO }] },
    });

    expect(containsFio(out)).toBe(false);
  });

  it('reaches an operator nested several levels down', () => {
    const out = projectModelFacing({
      data: [{ deal: { tasks: [{ assignee: { id: OPERATOR_ID, name: OPERATOR_FIO } }] } }],
    });

    expect(containsFio(out)).toBe(false);
  });

  it('drops every name-shaped key inside a user container, not just `name`', () => {
    const stuffed = Object.fromEntries([...OPERATOR_NAME_KEYS].map((k) => [k, OPERATOR_FIO]));
    const out = projectModelFacing({ data: { creator: { id: OPERATOR_ID, ...stuffed } } }) as {
      data: { creator: Record<string, unknown> };
    };

    expect(out.data.creator).toEqual({ id: OPERATOR_ID });
  });

  it('recognises a bare User row by a User-only column, whatever key it arrived under', () => {
    const out = projectModelFacing({
      data: { rows: [{ id: OPERATOR_ID, name: OPERATOR_FIO, username: 'nikodim', is_verified: true }] },
    });

    expect(containsFio(out)).toBe(false);
    expect(JSON.stringify(out)).toContain('nikodim'); // only the NAME is the target
  });

  it('a nested contact inside a user container keeps its own names', () => {
    const out = projectModelFacing({
      data: { assignee: { id: OPERATOR_ID, name: OPERATOR_FIO, contact: { first_name: 'Пётр' } } },
    }) as { data: { assignee: { contact: { first_name: string } } } };

    expect(containsFio(out)).toBe(false);
    expect(out.data.assignee.contact.first_name).toBe('Пётр');
  });
});

describe('projectModelFacing leaves the legitimate names alone', () => {
  // This block is the whole reason the fix is not "add `name` to REDACTED_KEYS".
  it('keeps pipeline.name and stage.name — get_deals and move_deal_to_stage need them', () => {
    const deal = {
      data: {
        id: 'd1',
        title: 'Поставка',
        pipeline: { id: 'p1', name: 'Основная воронка' },
        stage: { id: 's1', name: 'Переговоры', position: 2 },
        contact: { id: 'c1', first_name: 'Пётр', last_name: 'Клиентов' },
      },
    };

    expect(projectModelFacing(deal)).toEqual(deal);
  });

  it('keeps the *_name labels get_pipeline_health returns', () => {
    const health = {
      data: [
        {
          pipeline_id: 'p1',
          pipeline_name: 'Основная воронка',
          transitions: [{ from_stage_name: 'Новый', to_stage_name: 'Переговоры' }],
        },
      ],
    };

    expect(projectModelFacing(health)).toEqual(health);
  });

  it('keeps the pipeline rows and nested stage names get_pipelines returns', () => {
    const pipelines = {
      data: [{ id: 'p1', name: 'Основная воронка', stages: [{ id: 's1', name: 'Новый', position: 0 }] }],
    };

    expect(projectModelFacing(pipelines)).toEqual(pipelines);
  });

  it("keeps a contact's own first_name / last_name — that is a separate, deliberate decision", () => {
    const contact = { data: { id: 'c1', first_name: 'Пётр', last_name: 'Клиентов', company: 'ООО Ромашка' } };

    expect(projectModelFacing(contact)).toEqual(contact);
  });

  it('leaves the get_rep_performance row shape untouched — that carve-out is decision record 002', () => {
    // Documented, not accidental: `{ user_id, name }` has no user-ish container
    // key and no User marker column, so neither rule reaches it. The tool also
    // declares { operatorNames: 'allowed' } at registration. If a future change
    // makes this row come back stripped, that is a product decision to make in
    // docs/decisions/002-operator-names-in-model-facing-analytics.md, not a
    // test to relax here.
    const reps = { data: [{ user_id: OPERATOR_ID, name: OPERATOR_FIO, deals_won: 3, win_rate: 62 }] };

    expect(projectModelFacing(reps)).toEqual(reps);
  });

  it('passes Date instances through as Dates, not as rewritten objects', () => {
    const due = new Date('2026-01-01T00:00:00.000Z');
    const out = projectModelFacing({ data: { due_date: due } }) as { data: { due_date: Date } };

    expect(out.data.due_date).toBeInstanceOf(Date);
    expect(out.data.due_date.getTime()).toBe(due.getTime());
  });

  it('survives a pathologically deep structure instead of blowing the stack', () => {
    let deep: Record<string, unknown> = { assignee: { name: OPERATOR_FIO } };
    for (let i = 0; i < 200; i += 1) deep = { nested: deep };

    expect(() => projectModelFacing(deep)).not.toThrow();
    expect(containsFio(projectModelFacing(deep))).toBe(false);
  });
});

// ═══ 2. The container list cannot silently rot ════════════════════════════════

describe('the User-relation list stays in step with the schema', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');

  it('every field typed User / User? / User[] in schema.prisma is a known container key', () => {
    const found = new Set<string>();
    for (const line of schema.split('\n')) {
      const match = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+User(\?|\[\])?(\s|$)/.exec(line);
      if (match?.[1]) found.add(match[1].toLowerCase());
    }

    // Sanity: if this parse ever finds nothing, the assertion below is vacuous.
    expect(found.size).toBeGreaterThan(10);

    const missing = [...found].filter((key) => !USER_RELATION_KEYS.has(key));
    expect(missing).toEqual([]);
  });

  it('the User-row markers are columns no other model has', () => {
    // A marker shared with another model would strip that model's `name`.
    for (const marker of USER_ROW_MARKER_KEYS) {
      const declarations = schema
        .split('\n')
        .filter((line) => new RegExp(`^\\s+${marker}\\s+\\S`).test(line));
      expect(declarations, `${marker} is declared on more than one model`).toHaveLength(1);
    }
  });
});

// ═══ 3. The wiring ════════════════════════════════════════════════════════════

describe('registerTool applies the projection to every tool result', () => {
  it('get_task: the ФИО is gone, the assignee id is not', async () => {
    const result = (await invoke('get_task', { id: TASK_ID })) as {
      data: { assignee: Record<string, unknown>; assigned_to: string };
    };

    expect(containsFio(result)).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Ржевусский');
    expect(result.data.assignee).toEqual({ id: OPERATOR_ID });
    expect(result.data.assigned_to).toBe(OPERATOR_ID);
  });

  it('get_task: the domain layer really did hand a name over — the tool is what dropped it', async () => {
    await invoke('get_task', { id: TASK_ID });

    const handedOver = await taskDomainMock.getTaskForUser.mock.results[0]?.value;
    expect(containsFio(handedOver)).toBe(true);
  });

  it('get_overdue_tasks: no ФИО in any row', async () => {
    const result = (await invoke('get_overdue_tasks')) as { data: Array<Record<string, unknown>> };

    expect(containsFio(result)).toBe(false);
    expect(result.data[0]?.assigned_to).toBe(OPERATOR_ID);
  });

  it('get_tasks: no ФИО in the list either', async () => {
    const result = await invoke('get_tasks');

    expect(containsFio(result)).toBe(false);
  });

  it('a brand-new tool nobody reviewed is covered by default', async () => {
    // The point of wrapping at registerTool. This handler leaks on purpose and
    // was never audited; it still cannot get a name out.
    registerTool('careless_future_tool', 'invented by this test', { type: 'object' }, async () => ({
      data: { assignee: { id: OPERATOR_ID, name: OPERATOR_FIO } },
    }));

    const result = await invoke('careless_future_tool');

    expect(containsFio(result)).toBe(false);
  });

  it('the opt-out is honoured, so a genuine per-operator report still works', async () => {
    registerTool(
      'declared_rep_report',
      'stands in for get_rep_performance',
      { type: 'object' },
      async () => ({ data: [{ user_id: OPERATOR_ID, name: OPERATOR_FIO }] }),
      { operatorNames: 'allowed' },
    );

    const result = await invoke('declared_rep_report');

    expect(containsFio(result)).toBe(true);
  });

  it('exactly one registered tool declares the opt-out, and it is get_rep_performance', () => {
    const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));
    const declaring: string[] = [];

    for (const file of files) {
      const source = readFileSync(`${TOOLS_DIR}/${file}`, 'utf8');
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

      const hits = code.match(/operatorNames\s*:\s*'allowed'/g) ?? [];
      for (let i = 0; i < hits.length; i += 1) declaring.push(file);
    }

    expect(declaring).toEqual(['analytics.ts']);

    const analytics = readFileSync(`${TOOLS_DIR}/analytics.ts`, 'utf8');
    const afterRepPerf = analytics.slice(analytics.indexOf("'get_rep_performance'"));
    expect(afterRepPerf).toContain("operatorNames: 'allowed'");
  });
});

// ═══ 4. Nothing downstream would have caught it ═══════════════════════════════

describe('the assistant redactor is not a backstop for this', () => {
  it('redactToolResult passes an operator ФИО straight through', () => {
    const leaky = { data: { assigned_to: OPERATOR_ID, assignee: { id: OPERATOR_ID, name: OPERATOR_FIO } } };

    expect(JSON.stringify(redactToolResult(leaky))).toContain(OPERATOR_FIO);
  });

  it('and it must keep passing pipeline / stage names, which is why it can never do this job', () => {
    const labels = { data: { pipeline: { name: 'Основная воронка' }, stage: { name: 'Новый' } } };

    expect(JSON.stringify(redactToolResult(labels))).toContain('Основная воронка');
    expect(JSON.stringify(redactToolResult(labels))).toContain('Новый');
  });

  it('what get_task actually returns survives the redactor with no name in it', async () => {
    const result = await invoke('get_task', { id: TASK_ID });

    expect(JSON.stringify(redactToolResult(result))).not.toContain(OPERATOR_FIO);
  });
});
