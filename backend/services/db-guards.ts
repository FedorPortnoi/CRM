import { db } from './db';

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
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

export async function assertUserBelongsToOrg(id: string, orgId: string): Promise<void> {
  const row = await db.user.findFirst({
    where: { id, organization_id: orgId },
    select: { id: true },
  });
  if (!row) {
    throw notFound('User not found');
  }
}

export async function assertDealBelongsToOrg(id: string, orgId: string): Promise<void> {
  const row = await db.deal.findFirst({
    where: { id, organization_id: orgId },
    select: { id: true },
  });
  if (!row) {
    throw notFound('Deal not found');
  }
}
