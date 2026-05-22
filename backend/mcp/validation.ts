import { db } from '../services/db';

type McpPrincipal = { sub: string; org_id: string };

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
  if (!isNonEmptyString(user.sub) || !isNonEmptyString(user.org_id)) {
    return mcpError('INVALID_TOKEN', 'JWT payload must include sub and org_id');
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
