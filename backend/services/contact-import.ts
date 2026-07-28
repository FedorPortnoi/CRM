import { Prisma } from '@prisma/client';
import { db } from './db';
import { encryptField, blindIndex } from './encryption';

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
  const data: Prisma.ContactCreateManyInput[] = rows.map(row => {
    // Trim once and reuse. The encrypted column and its blind index MUST be derived from
    // the same plaintext: encryptField uses a random IV per call, so the ciphertext is not
    // searchable, and every email/phone lookup in contact-search.ts matches on the *_bidx
    // HMAC instead. Writing one without the other — which this function did until
    // 2026-07-27 — silently produced contacts that could never be found by email or phone.
    const email = optionalTrimmedString(row.email);
    const phone = optionalTrimmedString(row.phone);
    const mobile = optionalTrimmedString(row.mobile);

    return {
      organization_id: orgId,
      created_by: userId,
      first_name: row.first_name.trim(),
      last_name: optionalTrimmedString(row.last_name),
      company: optionalTrimmedString(row.company),
      email: email ? encryptField(email) : undefined,
      phone: phone ? encryptField(phone) : undefined,
      mobile: mobile ? encryptField(mobile) : undefined,
      email_bidx: email ? blindIndex(email, 'email') : undefined,
      phone_bidx: phone ? blindIndex(phone, 'phone') : undefined,
      mobile_bidx: mobile ? blindIndex(mobile, 'mobile') : undefined,
      source: optionalTrimmedString(row.source),
      notes: optionalTrimmedString(row.notes),
      type: row.type,
    };
  });

  const result = await db.$transaction(async (tx) => tx.contact.createMany({ data }));

  return { imported_count: result.count };
}
