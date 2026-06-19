import { Prisma } from '@prisma/client';
import { db } from './db';
import { encryptField } from './encryption';

export type ContactImportRow = {
  first_name: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  source?: string;
  notes?: string;
  type?: 'lead' | 'customer' | 'partner' | 'other';
};

export function optionalTrimmedString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function importCsvRows(
  orgId: string,
  userId: string,
  rows: ContactImportRow[],
): Promise<{ imported_count: number }> {
  const data: Prisma.ContactCreateManyInput[] = rows.map(row => ({
    organization_id: orgId,
    created_by: userId,
    first_name: row.first_name.trim(),
    last_name: optionalTrimmedString(row.last_name),
    company: optionalTrimmedString(row.company),
    email: optionalTrimmedString(row.email) ? encryptField(optionalTrimmedString(row.email)!) : undefined,
    phone: optionalTrimmedString(row.phone) ? encryptField(optionalTrimmedString(row.phone)!) : undefined,
    mobile: optionalTrimmedString(row.mobile) ? encryptField(optionalTrimmedString(row.mobile)!) : undefined,
    source: optionalTrimmedString(row.source),
    notes: optionalTrimmedString(row.notes),
    type: row.type,
  }));

  const result = await db.$transaction(async (tx) => tx.contact.createMany({ data }));

  return { imported_count: result.count };
}
