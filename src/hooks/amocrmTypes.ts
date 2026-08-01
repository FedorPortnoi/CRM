export type AmoConnectionState = 'active' | 'needs_reauth' | 'paused' | null;

export interface AmoSyncHealth {
  pending: number;
  processing: number;
  failed: number;
  conflicts: number;
}

export interface AmoStatus {
  connected: boolean;
  configured: boolean;
  status: AmoConnectionState;
  subdomain: string | null;
  base_url: string | null;
  token_expires_at: string | null;
  needs_reauth_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  webhook_count: number;
  connected_by: string | null;
  connected_at: string | null;
  sync: AmoSyncHealth;
}

export interface AmoStageWarning {
  code: 'DUPLICATE_TERMINAL_STATUS' | 'EMPTY_PIPELINE';
  amo_pipeline_id: number;
  amo_status_id: number | null;
  stage_name: string | null;
  flag: 'won' | 'lost' | null;
  message: string;
}

export interface AmoImportPreview {
  pipelines: Array<{
    amo_pipeline_id: number;
    name: string;
    is_archive: boolean;
    stages: Array<{
      amo_status_id: number;
      name: string;
      position: number;
      color: string | null;
      is_won_stage: boolean;
      is_lost_stage: boolean;
    }>;
  }>;
  warnings: AmoStageWarning[];
  sample: { contacts: number; companies: number; leads: number };
  has_more: { contacts: boolean; companies: boolean; leads: boolean };
  already_mapped: { contacts: number; companies: number; leads: number };
}

export type AmoImportCursor = {
  phase: 'pipelines' | 'companies' | 'contacts' | 'leads' | 'done';
  page: number;
};

export interface AmoImportRequest {
  include_leads: boolean;
  include_companies: boolean;
  cursor?: AmoImportCursor;
}

export interface AmoImportResult {
  contacts_imported: number;
  contacts_failed: number;
  deals_imported: number;
  deals_failed: number;
  total_contacts: number;
  companies_seen: number;
  companies_failed: number;
  pipelines_created: number;
  pipelines_updated: number;
  stages_created: number;
  stages_updated: number;
  warnings: AmoStageWarning[];
  partial: boolean;
  cursor?: AmoImportCursor;
  error?: string;
}

export interface AmoReconcileResult {
  entitiesInspected: number;
  healed: number;
  localOnly: number;
}

/** Mirrors backend/services/capabilities.ts. The server remains authoritative. */
export function roleCanManageAmo(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** contacts.bulk currently belongs to owner/admin, as does the integration gate. */
export function roleCanImportAmo(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** Adds each cursor-bounded response into the one result the operator sees. */
export function mergeAmoImportResults(
  previous: AmoImportResult | null,
  next: AmoImportResult,
): AmoImportResult {
  if (!previous) return next;

  const warningKeys = new Set<string>();
  const warnings = [...previous.warnings, ...next.warnings].filter((warning) => {
    const key = `${warning.code}:${warning.amo_pipeline_id}:${warning.amo_status_id ?? ''}`;
    if (warningKeys.has(key)) return false;
    warningKeys.add(key);
    return true;
  });

  return {
    contacts_imported: previous.contacts_imported + next.contacts_imported,
    contacts_failed: previous.contacts_failed + next.contacts_failed,
    deals_imported: previous.deals_imported + next.deals_imported,
    deals_failed: previous.deals_failed + next.deals_failed,
    total_contacts: previous.total_contacts + next.total_contacts,
    companies_seen: previous.companies_seen + next.companies_seen,
    companies_failed: previous.companies_failed + next.companies_failed,
    pipelines_created: previous.pipelines_created + next.pipelines_created,
    pipelines_updated: previous.pipelines_updated + next.pipelines_updated,
    stages_created: previous.stages_created + next.stages_created,
    stages_updated: previous.stages_updated + next.stages_updated,
    warnings,
    partial: next.partial,
    cursor: next.cursor,
    error: next.error,
  };
}
