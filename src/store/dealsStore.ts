import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import NetInfo from '@react-native-community/netinfo';
import { API_URL } from '../utils/api';
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
  contact_id: string;
  contact: { id: string; first_name: string; last_name: string };
  pipeline: { id: string; name: string } | null;
  stage: { id: string; name: string; position: number } | null;
  assigned_to: string | null;
  created_by: string | null;
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

const DEALS_PER_PAGE = 100;

async function getToken(): Promise<string> {
  const token: string | null = await SecureStore.getItemAsync('crm_auth_token');
  return token ?? '';
}

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
      const token: string = await getToken();
      const deals: Deal[] = [];
      let page = 1;
      let total: number | null = null;

      while (total === null || deals.length < total) {
        const params = new URLSearchParams({
          page: String(page),
          per_page: String(DEALS_PER_PAGE),
          status: 'open',
        });
        const response: Response = await fetch(`${API_URL}/deals?${params.toString()}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        const body: ApiListResponse = await readJsonResponse<ApiListResponse>(response);

        deals.push(...body.data);
        total = typeof body.meta?.total === 'number' ? body.meta.total : null;

        if (body.data.length < DEALS_PER_PAGE) {
          break;
        }

        page += 1;
      }

      set({ deals, isLoading: false });
    } catch (e: unknown) {
      const msg: string = e instanceof Error ? e.message : 'Unknown error';
      set({ error: msg, isLoading: false });
    }
  },

  moveDeal: async (dealId: string, stageId: string): Promise<void> => {
    const snapshot: Deal[] = get().deals;

    set({
      deals: get().deals.map((d: Deal) =>
        d.id === dealId ? { ...d, stage_id: stageId } : d,
      ),
    });

    const netState = await NetInfo.fetch();
    const isOnline: boolean =
      netState.isConnected === true && netState.isInternetReachable !== false;

    if (!isOnline) {
      await offlineQueue.enqueue({
        url: `${API_URL}/deals/${dealId}/stage`,
        method: 'PATCH',
        body: JSON.stringify({ stage_id: stageId }),
      });
      return;
    }

    try {
      const token: string = await getToken();
      const response: Response = await fetch(`${API_URL}/deals/${dealId}/stage`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ stage_id: stageId }),
      });
      const body: ApiDealResponse = await readJsonResponse<ApiDealResponse>(response);

      set({
        deals: get().deals.map((d: Deal) => (d.id === dealId ? body.data : d)),
      });
    } catch (e: unknown) {
      const msg: string = e instanceof Error ? e.message : 'Unknown error';
      set({ deals: snapshot, error: msg });
    }
  },
}));
