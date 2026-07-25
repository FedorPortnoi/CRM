// Data layer for the reporting screens.
//
// Backend: GET /api/v1/reports/{funnel,reps,win-loss,revenue,pipeline-health}
// Every route shares the same querystring (period, date_from, date_to, pipeline_id, scope);
// /revenue adds granularity and currency. Every response is `{ data, meta }` where meta carries
// the resolved range, the org currency and whether the visibility cone narrowed the numbers.
//
// The backend returns raw numbers and ISO strings only — all formatting happens in the screens
// through src/market/profile.ts.
import { useQuery, keepPreviousData, type UseQueryResult } from '@tanstack/react-query';
import { useUserStore } from '../store/userStore';
import { API_URL } from '../utils/api';

export const REPORT_PERIODS = ['7d', '30d', '90d', 'month', 'quarter', 'year', 'custom'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REVENUE_GRANULARITIES = ['day', 'week', 'month'] as const;
export type RevenueGranularity = (typeof REVENUE_GRANULARITIES)[number];

export type ReportScope = 'direct' | 'subtree';

export const DEFAULT_REPORT_PERIOD: ReportPeriod = '30d';

export type ReportFilters = {
  period: ReportPeriod;
  /** ISO date (YYYY-MM-DD). Only sent when period is `custom`. */
  date_from: string | null;
  date_to: string | null;
  pipeline_id: string | null;
  scope: ReportScope;
};

export const DEFAULT_REPORT_FILTERS: ReportFilters = {
  period: DEFAULT_REPORT_PERIOD,
  date_from: null,
  date_to: null,
  pipeline_id: null,
  scope: 'subtree',
};

export type ReportMeta = {
  period: ReportPeriod;
  date_from: string;
  date_to: string;
  currency: string;
  scope: ReportScope;
  restricted_to_visible_users: boolean;
  stalled_threshold_days?: number;
  decay_factor?: number;
  stalled_since?: string;
  granularity?: RevenueGranularity;
  buckets_truncated?: boolean;
  formula?: string;
  note?: string;
};

export type ReportEnvelope<T> = { data: T; meta: ReportMeta };

// ─── Report payloads (mirrors backend/services/reporting.ts) ──────────────────

export type FunnelStage = {
  stage_id: string;
  stage_name: string;
  position: number;
  is_won_stage: boolean;
  is_lost_stage: boolean;
  deal_count: number;
  open_count: number;
  won_count: number;
  lost_count: number;
  total_value: number;
  /** Percentage (0-100) of the deals that reached this stage which also reached the next one. */
  conversion_to_next: number | null;
};

export type FunnelPipeline = {
  pipeline_id: string;
  pipeline_name: string;
  stages: FunnelStage[];
  totals: { deal_count: number; total_value: number };
};

export type SalesFunnelReport = {
  period: ReportPeriod;
  pipelines: FunnelPipeline[];
  totals: {
    deal_count: number;
    total_value: number;
    unstaged_deal_count: number;
    unstaged_value: number;
  };
};

export type RepPerformanceRow = {
  user_id: string;
  name: string | null;
  role: string | null;
  deals_won: number;
  deals_lost: number;
  deals_open: number;
  stalled_deals: number;
  revenue: number;
  lost_value: number;
  open_value: number;
  average_deal_value: number;
  tasks_completed: number;
  activity_count: number;
  pipeline_health_score: number;
};

export type RepPerformanceTotals = Omit<RepPerformanceRow, 'user_id' | 'name' | 'role'>;

export type RepPerformanceReport = {
  period: ReportPeriod;
  reps: RepPerformanceRow[];
  totals: RepPerformanceTotals;
};

export type WinLossReasonRow = {
  lost_reason: string | null;
  count: number;
  value: number;
  share: number;
};

export type WinLossSourceRow = {
  source: string | null;
  won_count: number;
  won_value: number;
  lost_count: number;
  lost_value: number;
  decided_count: number;
  decided_value: number;
  /** Plain share of decided deals, not the health score. */
  won_share: number;
};

export type WinLossReport = {
  period: ReportPeriod;
  totals: {
    won_count: number;
    won_value: number;
    lost_count: number;
    lost_value: number;
    decided_count: number;
    decided_value: number;
    won_share: number;
    average_won_value: number;
    average_lost_value: number;
  };
  by_lost_reason: WinLossReasonRow[];
  by_source: WinLossSourceRow[];
};

export type RevenueBucket = {
  period_start: string;
  period_end: string;
  deal_count: number;
  revenue: number;
  average_deal_value: number;
};

export type RevenueReport = {
  period: ReportPeriod;
  granularity: RevenueGranularity;
  currency: string;
  series: RevenueBucket[];
  totals: { deal_count: number; revenue: number; average_deal_value: number };
  other_currencies: Array<{ currency: string; deal_count: number; revenue: number }>;
};

export type PipelineHealthRow = {
  pipeline_id: string | null;
  pipeline_name: string | null;
  pipeline_health_score: number;
  won: number;
  lost: number;
  stalled: number;
  open: number;
};

export type PipelineHealthReport = {
  period: ReportPeriod;
  pipeline_health_score: number;
  components: {
    won: number;
    lost: number;
    stalled: number;
    open: number;
    decay_factor: number;
    stalled_threshold_days: number;
    stalled_since: string;
  };
  pipelines: PipelineHealthRow[];
};

// ─── Fetching ─────────────────────────────────────────────────────────────────

export const REPORT_KINDS = ['funnel', 'reps', 'win-loss', 'revenue', 'pipeline-health'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Serializes the filters into the shared querystring. Only the values the backend accepts. */
export function buildReportQuery(
  filters: ReportFilters,
  extra: Record<string, string> = {},
): string {
  const parts: string[] = [`period=${encodeURIComponent(filters.period)}`];

  if (filters.period === 'custom') {
    // Supplying either boundary is what actually forces a custom range server-side; sending
    // period=custom on its own falls back to the default 30 days.
    if (filters.date_from) parts.push(`date_from=${encodeURIComponent(filters.date_from)}`);
    if (filters.date_to) parts.push(`date_to=${encodeURIComponent(filters.date_to)}`);
  }

  parts.push(`scope=${encodeURIComponent(filters.scope)}`);
  if (filters.pipeline_id) parts.push(`pipeline_id=${encodeURIComponent(filters.pipeline_id)}`);

  for (const [key, value] of Object.entries(extra)) {
    parts.push(`${key}=${encodeURIComponent(value)}`);
  }

  return `?${parts.join('&')}`;
}

async function fetchReport<T>(
  kind: ReportKind,
  token: string,
  query: string,
): Promise<ReportEnvelope<T>> {
  const res = await fetch(`${API_URL}/reports/${kind}${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Developer-facing only: the screens render reports.failedToLoad, never this message.
  if (!res.ok) throw new Error(`Report ${kind} failed with status ${res.status}`);
  return (await res.json()) as ReportEnvelope<T>;
}

type UseReportOptions = {
  /** Reports are tabbed — only the visible one is fetched. */
  enabled?: boolean;
  /** Extra querystring values (revenue granularity / currency). */
  extra?: Record<string, string>;
};

function useReport<T>(
  kind: ReportKind,
  filters: ReportFilters,
  options: UseReportOptions = {},
): UseQueryResult<ReportEnvelope<T>, Error> {
  const token = useUserStore((s) => s.token);
  const query = buildReportQuery(filters, options.extra);

  return useQuery<ReportEnvelope<T>, Error>({
    queryKey: ['reports', kind, query, token],
    queryFn: () => fetchReport<T>(kind, token ?? '', query),
    enabled: Boolean(token) && options.enabled !== false,
    // Keeps the previous period's numbers on screen while a new range loads, so switching
    // period does not flash the skeleton.
    placeholderData: keepPreviousData,
  });
}

export function useFunnelReport(
  filters: ReportFilters,
  enabled: boolean,
): UseQueryResult<ReportEnvelope<SalesFunnelReport>, Error> {
  return useReport<SalesFunnelReport>('funnel', filters, { enabled });
}

export function useRepPerformanceReport(
  filters: ReportFilters,
  enabled: boolean,
): UseQueryResult<ReportEnvelope<RepPerformanceReport>, Error> {
  return useReport<RepPerformanceReport>('reps', filters, { enabled });
}

export function useWinLossReport(
  filters: ReportFilters,
  enabled: boolean,
): UseQueryResult<ReportEnvelope<WinLossReport>, Error> {
  return useReport<WinLossReport>('win-loss', filters, { enabled });
}

export function useRevenueReport(
  filters: ReportFilters,
  granularity: RevenueGranularity,
  enabled: boolean,
): UseQueryResult<ReportEnvelope<RevenueReport>, Error> {
  return useReport<RevenueReport>('revenue', filters, { enabled, extra: { granularity } });
}

export function usePipelineHealthReport(
  filters: ReportFilters,
  enabled: boolean,
): UseQueryResult<ReportEnvelope<PipelineHealthReport>, Error> {
  return useReport<PipelineHealthReport>('pipeline-health', filters, { enabled });
}
