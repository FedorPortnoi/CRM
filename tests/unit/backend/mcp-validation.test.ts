import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  user: {
    findFirst: vi.fn(),
  },
  org: {
    findUnique: vi.fn(),
  },
  contact: {
    findFirst: vi.fn(),
  },
  deal: {
    findFirst: vi.fn(),
  },
}));

vi.mock('../../../backend/services/db', () => ({
  db: dbMock,
}));

import { validateMcpPrincipal, validateMcpWriteReferences } from '../../../backend/mcp/validation';

const user = {
  sub: '00000000-0000-4000-a000-000000000001',
  org_id: '00000000-0000-4000-a000-000000000010',
};

describe('MCP validation helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires the token user to be active and scoped to an existing org', async () => {
    dbMock.user.findFirst.mockResolvedValue(null);
    dbMock.org.findUnique.mockResolvedValue({ id: user.org_id });

    await expect(validateMcpPrincipal(user)).resolves.toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authenticated user is inactive or does not belong to an active organization',
      },
    });
    expect(dbMock.user.findFirst).toHaveBeenCalledWith({
      where: { id: user.sub, organization_id: user.org_id, is_active: true },
      select: { id: true },
    });
  });

  it('accepts an active user in an existing org', async () => {
    dbMock.user.findFirst.mockResolvedValue({ id: user.sub });
    dbMock.org.findUnique.mockResolvedValue({ id: user.org_id });

    await expect(validateMcpPrincipal(user)).resolves.toBeNull();
  });

  it('does not re-query the current user when assigning work to self', async () => {
    await expect(validateMcpWriteReferences(user, { assigned_to: user.sub })).resolves.toBeNull();
    expect(dbMock.user.findFirst).not.toHaveBeenCalled();
  });

  it('rejects cross-org or inactive assignee references before writes', async () => {
    dbMock.user.findFirst.mockResolvedValue(null);

    await expect(validateMcpWriteReferences(user, {
      assigned_to: '00000000-0000-4000-a000-000000000099',
    })).resolves.toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'Assigned user does not belong to your organization',
      },
    });
    expect(dbMock.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: '00000000-0000-4000-a000-000000000099',
        organization_id: user.org_id,
        is_active: true,
      },
      select: { id: true },
    });
  });

  it('rejects cross-org contact and deal references before writes', async () => {
    dbMock.contact.findFirst.mockResolvedValue(null);
    dbMock.deal.findFirst.mockResolvedValue({ id: 'deal-1' });

    await expect(validateMcpWriteReferences(user, {
      contact_id: '00000000-0000-4000-a000-000000000020',
      deal_id: '00000000-0000-4000-a000-000000000030',
    })).resolves.toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'Contact does not belong to your organization',
      },
    });
    expect(dbMock.contact.findFirst).toHaveBeenCalledWith({
      where: { id: '00000000-0000-4000-a000-000000000020', organization_id: user.org_id },
      select: { id: true },
    });
    expect(dbMock.deal.findFirst).toHaveBeenCalledWith({
      where: { id: '00000000-0000-4000-a000-000000000030', organization_id: user.org_id },
      select: { id: true },
    });
  });
});
