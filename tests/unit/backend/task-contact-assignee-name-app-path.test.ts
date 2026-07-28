import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// The other direction: the APP must still get the assignee's name.
//
// mcp-operator-name-projection.test.ts pins that no operator ФИО reaches a
// language model. The obvious way to make that test pass is to delete
// `assignee: { select: { id, name } }` from the shared domain functions — and
// that would silently break the user interface, because
// src/app/task/[id].tsx:371 renders `task.assignee.name` and
// src/app/task/edit/[id].tsx:239-240 seeds its assignee picker from
// `assignee.id` / `assignee.name` on the same response. GET /contacts/:id feeds
// src/app/contact/[id].tsx and the external public API the same way.
//
// So this file asserts the PRESENCE of the ФИО on the REST-facing path, over a
// fake Prisma engine that answers whatever `select` the query asks for. An
// over-correction that scrubs the name everywhere instead of at the MCP
// boundary turns these red.
//
// The one function that legitimately stopped asking is getOverdueTasksForUser:
// its only caller is the MCP tool get_overdue_tasks, so there is no human on
// the other end and the name has no reason to leave Postgres at all. That
// asymmetry is asserted here too, in both directions, so neither half can drift.
// ---------------------------------------------------------------------------

const ORG = '66666666-6666-4666-8666-000000000001';
const CALLER = '66666666-6666-4666-8666-00000000000a';
const OPERATOR_ID = '66666666-6666-4666-8666-00000000000b';
const TASK_ID = '77777777-7777-4777-8777-000000000001';
const CONTACT_ID = '77777777-7777-4777-8777-000000000002';

/** Distinctive on purpose: this string appears nowhere else in the codebase. */
const OPERATOR_FIO = 'Никодим Ржевусский-Пшеничнов';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url).href);

const USER_ROW: Record<string, unknown> = {
  id: OPERATOR_ID,
  organization_id: ORG,
  name: OPERATOR_FIO,
  role: 'member',
};

/** Answers an `include: { assignee: { select: … } }` from the user row above. */
function withAssignee(row: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  const include = args?.include as Record<string, unknown> | undefined;

  for (const [relation, spec] of Object.entries(include ?? {})) {
    if (relation !== 'assignee' || !spec) continue;
    const select = (spec as { select?: Record<string, boolean> }).select;
    if (!select) {
      out.assignee = { ...USER_ROW };
      continue;
    }
    const projected: Record<string, unknown> = {};
    for (const [field, wanted] of Object.entries(select)) {
      if (wanted) projected[field] = USER_ROW[field];
    }
    out.assignee = projected;
  }

  return out;
}

const dbMock = vi.hoisted(() => ({
  task: { findFirst: vi.fn(), findMany: vi.fn() },
  contact: { findFirst: vi.fn() },
  $queryRaw: vi.fn(),
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

// contact-domain decrypts email/phone/mobile on the way out; the ciphertext is
// beside the point here and the real implementation wants a server secret.
vi.mock('../../../backend/services/encryption', () => ({
  encryptField: (v: unknown) => v,
  decryptField: (v: unknown) => v ?? null,
  blindIndex: () => null,
  ENCRYPTED_FIELD_PREFIX: 'enc:v1:',
}));

import { getTaskForUser, getOverdueTasksForUser } from '../../../backend/services/task-domain';
import { getContactForUser } from '../../../backend/services/contact-domain';

const requester = { sub: CALLER, org_id: ORG, role: 'owner' as const };

function argsOf(mock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`query was never made (call ${index})`);
  return call[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();

  dbMock.task.findFirst.mockImplementation(async (args: Record<string, unknown>) =>
    withAssignee(
      { id: TASK_ID, organization_id: ORG, title: 'Позвонить клиенту', assigned_to: OPERATOR_ID },
      args,
    ),
  );

  dbMock.task.findMany.mockImplementation(async (args: Record<string, unknown>) => [
    withAssignee(
      { id: TASK_ID, organization_id: ORG, title: 'Просрочено', assigned_to: OPERATOR_ID },
      args,
    ),
  ]);

  dbMock.contact.findFirst.mockImplementation(async (args: Record<string, unknown>) =>
    withAssignee(
      {
        id: CONTACT_ID,
        organization_id: ORG,
        first_name: 'Пётр',
        last_name: 'Клиентов',
        email: null,
        phone: null,
        mobile: null,
        assigned_to: OPERATOR_ID,
        created_by: CALLER,
      },
      args,
    ),
  );
});

describe('the app-facing path still returns the assignee ФИО', () => {
  it('control: the fake engine only answers what the query asks for', async () => {
    const bare = (await dbMock.task.findFirst({ where: { id: TASK_ID } })) as Record<string, unknown>;
    expect(bare).not.toHaveProperty('assignee');
  });

  it('getTaskForUser returns assignee.name — src/app/task/[id].tsx:371 renders it', async () => {
    // The declared return type is the bare Prisma row — the `include` widens
    // the runtime shape without widening the signature, which is precisely the
    // gap this test exists to hold open.
    const task = (await getTaskForUser(TASK_ID, ORG, requester)) as unknown as {
      assignee: { id: string; name: string };
    };

    expect(task.assignee.name).toBe(OPERATOR_FIO);
    expect(task.assignee.id).toBe(OPERATOR_ID);
  });

  it('getTaskForUser asks Postgres for the name, so the include is really still there', async () => {
    await getTaskForUser(TASK_ID, ORG, requester);

    expect(argsOf(dbMock.task.findFirst)).toMatchObject({
      include: { assignee: { select: { id: true, name: true } } },
    });
  });

  it('getContactForUser returns assignee.name — GET /contacts/:id and the public API read it', async () => {
    const contact = (await getContactForUser(CONTACT_ID, ORG, requester)) as {
      assignee: { id: string; name: string };
    };

    expect(contact.assignee.name).toBe(OPERATOR_FIO);
    expect(contact.assignee.id).toBe(OPERATOR_ID);
  });

  it('getContactForUser asks Postgres for the name too', async () => {
    await getContactForUser(CONTACT_ID, ORG, requester);

    expect(argsOf(dbMock.contact.findFirst)).toMatchObject({
      include: { assignee: { select: { id: true, name: true } } },
    });
  });
});

describe('getOverdueTasksForUser is model-only, so it asks for nothing it does not need', () => {
  it('does not select the assignee at all', async () => {
    await getOverdueTasksForUser(ORG, requester);

    const args = argsOf(dbMock.task.findMany);
    expect(JSON.stringify(args.include)).not.toContain('assignee');
    // `first_name` / `last_name` belong to the contact and stay; what must not
    // appear anywhere in this query is a bare `name` select.
    expect(JSON.stringify(args)).not.toContain('"name"');
  });

  it('returns no assignee object, and the ФИО never leaves Postgres on this path', async () => {
    const tasks = (await getOverdueTasksForUser(ORG, requester)) as Array<Record<string, unknown>>;

    expect(tasks[0]).not.toHaveProperty('assignee');
    expect(JSON.stringify(tasks)).not.toContain(OPERATOR_FIO);
  });

  it('still carries the assignee identifier the model chains on', async () => {
    const tasks = (await getOverdueTasksForUser(ORG, requester)) as Array<{ assigned_to: string }>;

    expect(tasks[0]?.assigned_to).toBe(OPERATOR_ID);
  });

  it('and keeps the linked contact, which is a separate deliberate decision', async () => {
    await getOverdueTasksForUser(ORG, requester);

    expect(argsOf(dbMock.task.findMany)).toMatchObject({
      include: { contact: { select: { id: true, first_name: true, last_name: true } } },
    });
  });
});

describe('the projection stays on the model side of the house', () => {
  it('nothing outside backend/mcp/ imports model-projection', () => {
    // If a REST controller or a shared service ever starts running the model
    // projection, the app loses the name and the test above only catches it for
    // these two functions. Keep the seam where it is.
    const roots = ['backend/api', 'backend/services', 'src'];
    const offenders: string[] = [];

    const visit = (dir: string): void => {
      for (const entry of readdirSync(`${REPO_ROOT}${dir}`, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          visit(rel);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        // An IMPORT, not a mention: contact-domain.ts and task-domain.ts both
        // name this module in a comment explaining where their ФИО is stripped,
        // and that is exactly the pointer a future reader needs.
        const source = readFileSync(`${REPO_ROOT}${rel}`, 'utf8');
        if (/(?:from|import|require)\s*\(?\s*['"][^'"]*model-projection['"]/.test(source)) {
          offenders.push(rel);
        }
      }
    };

    for (const root of roots) visit(root);

    expect(offenders).toEqual([]);
  });
});
