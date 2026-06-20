import { db } from './db';

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

export async function userBelongsToOrg(userId: string, orgId: string): Promise<boolean> {
  const row = await db.user.findFirst({
    where: { id: userId, organization_id: orgId, is_active: true },
    select: { id: true },
  });
  return row !== null;
}

export async function assertContactBelongsToOrg(id: string, orgId: string): Promise<void> {
  const row = await db.contact.findFirst({
    where: { id, organization_id: orgId },
    select: { id: true },
  });
  if (!row) {
    throw notFound('Contact not found');
  }
}

