import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// merge_contacts must not return an operator's ФИО.
//
// The tool used to re-read the merged contact with
// `include: { assignee: { select: { id: true, name: true } } }`. That `name` is
// a User row's ФИО — an OPERATOR, a second data subject, in the result of an
// operation about a CUSTOMER. The result goes straight out through
// backend/services/assistant.ts → redactToolResult() to the language model and
// into AssistantMessage.content as plain text.
//
// There is no backstop downstream: REDACTED_KEYS and PII_KEY_FRAGMENTS in
// assistant.ts match email / phone / mobile only, and a bare `name` key cannot
// be added to them because `stage.name` and `pipeline.name` are legitimate.
// One of the tests below proves that by running the REAL redactor over a row
// that still carries the name and showing it comes back untouched. So the field
// has to be absent at the source, which is what these tests pin.
//
// The fixture ФИО is deliberately unlike every other name in the repo, so a hit
// anywhere is unambiguous — and the fake Prisma engine below still HOLDS that
// name and will still hand it over if a `select` asks for it. Re-add the
// include and these tests go red; they are not asserting against an empty
// database.
// ---------------------------------------------------------------------------

const ORG = '22222222-2222-4222-8222-000000000001';
const CALLER = '22222222-2222-4222-8222-00000000000a';
const OPERATOR_ID = '22222222-2222-4222-8222-00000000000b';

/** Distinctive on purpose: this string appears nowhere else in the codebase. */
const OPERATOR_FIO = 'Аполлинария Вышеславцева-Кордубайло';

const TARGET_ID = '33333333-3333-4333-8333-000000000001';
const SOURCE_ID = '33333333-3333-4333-8333-000000000002';

const TOOL_SOURCE_PATH = fileURLToPath(
  new URL('../../../backend/mcp/tools/contacts.ts', import.meta.url).href,
);

type ContactRow = {
  id: string;
  organization_id: string;
  first_name: string;
  last_name: string | null;
  status: string;
  assigned_to: string | null;
  created_by: string | null;
};

function contactRow(id: string, first_name: string): ContactRow {
  return {
    id,
    organization_id: ORG,
    first_name,
    last_name: 'Клиентов',
    status: 'active',
    assigned_to: OPERATOR_ID,
    created_by: CALLER,
  };
}

const CONTACTS: ContactRow[] = [contactRow(TARGET_ID, 'Цель'), contactRow(SOURCE_ID, 'Источник')];

// ─── Fake Prisma ──────────────────────────────────────────────────────────────
// contact.findFirst HONOURS `include.assignee`. The operator's ФИО is sitting
// right there in the fixture user: whatever `select` the query asks for is
// answered from it, so a reinstated `name: true` gets a real name back and the
// assertions below have something to catch.

const USERS = [{ id: OPERATOR_ID, organization_id: ORG, name: OPERATOR_FIO, email: 'op@example.test' }];

const dbMock = vi.hoisted(() => ({
  contact: { findFirst: vi.fn(), update: vi.fn() },
  deal: { updateMany: vi.fn() },
  task: { updateMany: vi.fn() },
  message: { updateMany: vi.fn() },
  calendarEvent: { updateMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

// The merge tool talks to Prisma directly; the rest of the file's tools go
// through contact-domain, which drags in encryption and workflows. Stubbed so
// this stays a unit test of the merge path.
vi.mock('../../../backend/services/contact-domain', () => ({
  listContactsForUser: vi.fn(),
  getContactForUser: vi.fn(),
  createContactForUser: vi.fn(),
  updateContactForUser: vi.fn(),
  archiveContactForUser: vi.fn(),
  ContactNotFoundError: class ContactNotFoundError extends Error {
    code = 'NOT_FOUND';
  },
  ContactForbiddenError: class ContactForbiddenError extends Error {
    code = 'FORBIDDEN';
  },
}));

type ToolHandler = (
  args: Record<string, unknown>,
  user: { sub: string; org_id: string; role: string },
) => Promise<Record<string, unknown>>;

type ToolEntry = { description: string; inputSchema: Record<string, unknown>; handler: ToolHandler };

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../../backend/mcp/server', () => ({
  registerTool: (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: unknown,
  ) => {
    registry.set(name, { description, inputSchema, handler });
  },
  // assistant.ts imports these from the same module; unused here, but the mock
  // has to provide them or the import below fails to resolve.
  listMcpTools: vi.fn(),
  invokeMcpTool: vi.fn(),
}));

import '../../../backend/mcp/tools/contacts';
import { redactToolResult } from '../../../backend/services/assistant';

function tool(name: string): ToolEntry {
  const entry = registry.get(name);
  if (!entry) throw new Error(`tool ${name} was never registered`);
  return entry as ToolEntry;
}

const caller = { sub: CALLER, org_id: ORG, role: 'owner' };

/** Every string in a structure, at any depth, plus the key it was stored under. */
function walk(value: unknown, path = '$'): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((v, i) => walk(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => walk(v, `${path}.${k}`));
  }
  return [{ path, value }];
}

function mergeArgsAt(index: number): Record<string, unknown> {
  const call = dbMock.contact.findFirst.mock.calls[index];
  if (!call) throw new Error(`contact.findFirst was not called ${index + 1} times`);
  return call[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();

  dbMock.contact.findFirst.mockImplementation(async (args: Record<string, unknown>) => {
    const where = (args?.where ?? {}) as { id?: string; organization_id?: string };
    const row = CONTACTS.find((c) => c.id === where.id && c.organization_id === where.organization_id);
    if (!row) return null;

    const out: Record<string, unknown> = { ...row };
    const include = args?.include as Record<string, unknown> | undefined;

    if (include?.assignee) {
      const user = USERS.find((u) => u.id === row.assigned_to);
      if (user) {
        const spec = include.assignee as { select?: Record<string, boolean> } | true;
        const select = spec === true ? undefined : spec.select;
        if (!select) {
          out.assignee = { ...user };
        } else {
          const projected: Record<string, unknown> = {};
          for (const [field, wanted] of Object.entries(select)) {
            if (wanted) projected[field] = (user as Record<string, unknown>)[field];
          }
          out.assignee = projected;
        }
      }
    }

    return out;
  });

  dbMock.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      deal: { updateMany: dbMock.deal.updateMany },
      task: { updateMany: dbMock.task.updateMany },
      message: { updateMany: dbMock.message.updateMany },
      calendarEvent: { updateMany: dbMock.calendarEvent.updateMany },
      contact: { update: dbMock.contact.update },
    }),
  );
});

describe('merge_contacts does not return an operator ФИО', () => {
  it('control: the fake Prisma engine WOULD hand the name over if asked', async () => {
    // Without this, every assertion below could be passing because the fixture
    // is empty rather than because the tool stopped asking.
    const row = (await dbMock.contact.findFirst({
      where: { id: TARGET_ID, organization_id: ORG },
      include: { assignee: { select: { id: true, name: true } } },
    })) as { assignee?: { name?: string } };

    expect(row.assignee?.name).toBe(OPERATOR_FIO);
  });

  it('the merged-contact result contains the ФИО nowhere at any depth', async () => {
    const result = await tool('merge_contacts').handler(
      { target_id: TARGET_ID, source_id: SOURCE_ID },
      caller,
    );

    const hits = walk(result).filter((leaf) => typeof leaf.value === 'string' && leaf.value.includes(OPERATOR_FIO));
    expect(hits).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(OPERATOR_FIO);
    expect(JSON.stringify(result)).not.toContain('Вышеславцева');
  });

  it('carries no `assignee` object at all — the name is gone structurally, not blanked', async () => {
    const result = await tool('merge_contacts').handler(
      { target_id: TARGET_ID, source_id: SOURCE_ID },
      caller,
    );

    const data = (result as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('assignee');
    expect(Object.keys(data).some((k) => k.toLowerCase().includes('name') && k !== 'first_name' && k !== 'last_name')).toBe(false);
  });

  it('still returns the assignee IDENTIFIER, so the model can chain on it', async () => {
    const result = await tool('merge_contacts').handler(
      { target_id: TARGET_ID, source_id: SOURCE_ID },
      caller,
    );

    expect((result as { data: { assigned_to: string } }).data.assigned_to).toBe(OPERATOR_ID);
  });

  it('never asks Postgres for the name: no query on this path selects the assignee', async () => {
    await tool('merge_contacts').handler({ target_id: TARGET_ID, source_id: SOURCE_ID }, caller);

    expect(dbMock.contact.findFirst).toHaveBeenCalledTimes(3);

    for (let i = 0; i < 3; i += 1) {
      const args = mergeArgsAt(i);
      expect(args).not.toHaveProperty('include');
      expect(JSON.stringify(args)).not.toContain('assignee');
      expect(JSON.stringify(args)).not.toContain('name');
    }
  });

  it('the fallback branch (post-merge re-read returns null) is name-free too', async () => {
    let calls = 0;
    dbMock.contact.findFirst.mockImplementation(async (args: Record<string, unknown>) => {
      calls += 1;
      // Third call is the post-merge re-read; make it miss so `?? target` runs.
      if (calls === 3) return null;
      const where = (args?.where ?? {}) as { id?: string; organization_id?: string };
      const row = CONTACTS.find((c) => c.id === where.id && c.organization_id === where.organization_id);
      return row ? { ...row } : null;
    });

    const result = await tool('merge_contacts').handler(
      { target_id: TARGET_ID, source_id: SOURCE_ID },
      caller,
    );

    expect(JSON.stringify(result)).not.toContain(OPERATOR_FIO);
    expect((result as { data: Record<string, unknown> }).data).not.toHaveProperty('assignee');
  });

  it('the assistant redactor is NOT a backstop — the source fix is the only defence', async () => {
    // The exact row the old code produced, run through the real projection that
    // stands between a tool result and the provider.
    const leaky = {
      data: { id: TARGET_ID, assigned_to: OPERATOR_ID, assignee: { id: OPERATOR_ID, name: OPERATOR_FIO } },
    };
    expect(JSON.stringify(redactToolResult(leaky))).toContain(OPERATOR_FIO);

    // And what the tool actually returns today, through the same projection.
    const result = await tool('merge_contacts').handler(
      { target_id: TARGET_ID, source_id: SOURCE_ID },
      caller,
    );
    expect(JSON.stringify(redactToolResult(result))).not.toContain(OPERATOR_FIO);
  });

  it('the tool contract advertises no owner name', () => {
    const entry = tool('merge_contacts');
    const advertised = `${entry.description} ${JSON.stringify(entry.inputSchema)}`.toLowerCase();

    expect(advertised).not.toContain('assignee');
    expect(advertised).not.toContain('owner name');
    expect(advertised).not.toContain('фио');
  });

  it('source guard: backend/mcp/tools/contacts.ts selects no User.name anywhere', () => {
    const source = readFileSync(TOOL_SOURCE_PATH, 'utf8');

    // Comments in the file mention `assignee` and `name` deliberately; strip
    // them so the guard reads code only.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    expect(code).not.toContain('name: true');
    expect(code).not.toMatch(/include\s*:\s*\{[^}]*assignee/);
  });
});
