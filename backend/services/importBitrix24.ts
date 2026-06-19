import { db } from './db';
import { paginateBitrix } from './bitrix-paginator';

export interface Bx24ImportResult {
  contacts_imported: number;
  contacts_failed: number;
  deals_imported: number;
  deals_failed: number;
  total_contacts: number;
}

interface Bx24Contact {
  ID: string;
  NAME?: string;
  LAST_NAME?: string;
  PHONE?: Array<{ VALUE: string }>;
  EMAIL?: Array<{ VALUE: string }>;
  COMPANY_TITLE?: string;
  SOURCE?: string;
  COMMENTS?: string;
}

interface Bx24Deal {
  ID: string;
  TITLE?: string;
  OPPORTUNITY?: string;
  CURRENCY_ID?: string;
  STAGE_ID?: string;
  CLOSEDATE?: string;
}

async function bx24Get<T>(webhookUrl: string, method: string, params: Record<string, unknown> = {}): Promise<{ result: T; next?: number; total?: number }> {
  const url = new URL(`${webhookUrl.replace(/\/$/, '')}/${method}.json`);
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => url.searchParams.set(`${k}[${i}]`, String(item)));
    } else {
      url.searchParams.set(k, String(v));
    }
  });

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Bitrix24 API error: ${res.status}`);
  return res.json() as Promise<{ result: T; next?: number; total?: number }>;
}

export async function importFromBitrix24(
  webhookUrl: string,
  orgId: string,
  userId: string,
  includeDeals = true,
): Promise<Bx24ImportResult> {
  const result: Bx24ImportResult = {
    contacts_imported: 0, contacts_failed: 0,
    deals_imported: 0, deals_failed: 0,
    total_contacts: 0,
  };

  // ── Contacts ─────────────────────────────────────────────────────────────
  const contactSelect = ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'COMPANY_TITLE', 'SOURCE', 'COMMENTS'];

  for await (const batch of paginateBitrix(async (start) => {
    const page = await bx24Get<Bx24Contact[]>(webhookUrl, 'crm.contact.list', {
      start,
      select: contactSelect,
    });
    result.total_contacts = page.total ?? result.total_contacts;
    // Safety cap: 1000 contacts per import
    if (start >= 1000) return { result: [], next: undefined, total: page.total };
    return page;
  })) {
    for (const c of batch) {
      try {
        const firstName = c.NAME?.trim() || 'Контакт';
        const phone = c.PHONE?.[0]?.VALUE?.trim() || undefined;
        const email = c.EMAIL?.[0]?.VALUE?.trim() || undefined;

        await db.contact.create({
          data: {
            organization_id: orgId,
            created_by: userId,
            first_name: firstName,
            last_name: c.LAST_NAME?.trim() || undefined,
            phone,
            email,
            company: c.COMPANY_TITLE?.trim() || undefined,
            source: c.SOURCE ? `bitrix24_${c.SOURCE.toLowerCase()}` : 'bitrix24',
            notes: c.COMMENTS?.trim() || undefined,
          },
        });
        result.contacts_imported++;
      } catch {
        result.contacts_failed++;
      }
    }
  }

  // ── Deals (best-effort: import into default pipeline) ────────────────────
  if (includeDeals) {
    const pipeline = await db.pipeline.findFirst({
      where: { organization_id: orgId, is_default: true },
      include: { stages: { orderBy: { position: 'asc' }, take: 1 } },
    });

    if (pipeline && pipeline.stages.length > 0) {
      const defaultStageId = pipeline.stages[0].id;
      for await (const batch of paginateBitrix(async (start) => {
        // Safety cap: 500 deals per import
        if (start >= 500) return { result: [] as Bx24Deal[], next: undefined, total: 0 };
        return bx24Get<Bx24Deal[]>(webhookUrl, 'crm.deal.list', {
          start,
          select: ['ID', 'TITLE', 'OPPORTUNITY', 'CURRENCY_ID', 'CLOSEDATE'],
        });
      })) {
        for (const d of batch) {
          try {
            // Deals need a contact_id — create a placeholder contact
            const placeholder = await db.contact.create({
              data: {
                organization_id: orgId,
                created_by: userId,
                first_name: 'Сделка',
                last_name: d.TITLE?.trim() || 'Bitrix24',
                source: 'bitrix24',
                notes: `Импортировано из Bitrix24 (сделка ID: ${d.ID})`,
              },
            });

            await db.deal.create({
              data: {
                organization_id: orgId,
                created_by: userId,
                title: d.TITLE?.trim() || `Сделка ${d.ID}`,
                contact_id: placeholder.id,
                pipeline_id: pipeline.id,
                stage_id: defaultStageId,
                value: d.OPPORTUNITY ? parseFloat(d.OPPORTUNITY) : undefined,
                currency: d.CURRENCY_ID || 'RUB',
                expected_close: d.CLOSEDATE ? new Date(d.CLOSEDATE) : undefined,
                source: 'bitrix24',
              },
            });
            result.deals_imported++;
          } catch {
            result.deals_failed++;
          }
        }
      }
    }
  }

  return result;
}
