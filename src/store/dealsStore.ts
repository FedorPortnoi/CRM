import { create } from 'zustand';
import { API_URL, authHeaders } from '../utils/api';
import * as offlineQueue from '../utils/offlineQueue';

type DealStatus = 'open' | 'won' | 'lost' | 'archived';

type Deal = {
  id: string;
  title: string;
  value: number | null;
  currency: string | null;
  status: DealStatus;
  pipeline_id: string | null;
  stage_id: string | null;
  expected_close: string | null;
  contact_id: string;
  contact: { id: string; first_name: string; last_name: string };
  pipeline: { id: string; name: string } | null;
  stage: { id: string; name: string; position: number } | null;
  assigned_to: string | null;
  created_by: string | null;
  next_action: string | null;
  next_action_due: string | null;
  stage_entered_at: string | null;
  created_at: string;
  updated_at: string;
};

interface DealsState {
  deals: Deal[];
  isLoading: boolean;
  error: string | null;
  fetchDeals: () => Promise<void>;
  moveDeal: (dealId: string, stageId: string) => Promise<void>;
}

type ApiListResponse = {
  data: Deal[];
  meta?: {
    total?: number;
  };
};

type ApiDealResponse = {
  data: Deal;
};

type ApiErrorResponse = {
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
};

const DEALS_PER_PAGE = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseApiError(text: string, fallback: string): string {
  if (!text) {
    return fallback;
  }

  try {
    const parsed: unknown = JSON.parse(text);

    if (!isRecord(parsed)) {
      return fallback;
    }

    const response: ApiErrorResponse = parsed as ApiErrorResponse;

    if (
      response.error?.code === 'DEAL_NOT_OPEN' &&
      typeof response.error.message === 'string'
    ) {
      return response.error.message;
    }

    if (typeof response.message === 'string') {
      return response.message;
    }

    if (typeof response.error?.message === 'string') {
      return response.error.message;
    }
  } catch (e: unknown) {
    const msg: string = e instanceof Error ? e.message : 'Unknown error';
    return text || msg;
  }

  return fallback;
}

async function readJsonResponse<TResponse>(response: Response): Promise<TResponse> {
  const text: string = await response.text();

  if (!response.ok) {
    throw new Error(parseApiError(text, `Request failed with status ${response.status}`));
  }

  try {
    return JSON.parse(text) as TResponse;
  } catch (e: unknown) {
    const msg: string = e instanceof Error ? e.message : 'Unknown error';
    throw new Error(msg);
  }
}

export const useDealsStore = create<DealsState>()((set, get) => ({
  deals: [],
  isLoading: false,
  error: null,

  fetchDeals: async (): Promise<void> => {
    set({ isLoading: true, error: null });

    try {
      const params = new URLSearchParams({
        page: '1',
        per_page: String(DEALS_PER_PAGE),
        status: 'open',
      });
      const response: Response = await fetch(`${API_URL}/deals?${params.toString()}`, {
        method: 'GET',
        headers: await authHeaders(),
      });
      const body: ApiListResponse = await readJsonResponse<ApiListResponse>(response);
      set({ deals: body.data, isLoading: false });
    } catch (e: unknown) {
      const msg: string = e instanceof Error ? e.message : 'Unknown error';
      set({ error: msg, isLoading: false });
    }
  },

  moveDeal: async (dealId: string, stageId: string): Promise<void> => {
    set({
      deals: get().deals.map((d: Deal) =>
        d.id === dealId ? { ...d, stage_id: stageId, stage_entered_at: new Date().toISOString() } : d,
      ),
    });

    try {
      const response: Response = await fetch(`${API_URL}/deals/${dealId}/stage`, {
        method: 'PATCH',
        headers: await authHeaders(),
        body: JSON.stringify({ stage_id: stageId }),
      });
      const body: ApiDealResponse = await readJsonResponse<ApiDealResponse>(response);

      set({
        deals: get().deals.map((d: Deal) => (d.id === dealId ? body.data : d)),
      });
    } catch {
      await offlineQueue.enqueue({
        url: `${API_URL}/deals/${dealId}/stage`,
        method: 'PATCH',
        body: JSON.stringify({ stage_id: stageId }),
      });
    }
  },
}));
