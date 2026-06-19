import { create } from 'zustand';
import { API_URL, authHeaders } from '../utils/api';

type PipelineStage = {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  color: string | null;
  is_won_stage: boolean;
  is_lost_stage: boolean;
  created_at: string;
  updated_at: string;
};

type Pipeline = {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  organization_id: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  stages: PipelineStage[];
  _count: { deals: number };
};

interface PipelinesState {
  pipelines: Pipeline[];
  isLoading: boolean;
  error: string | null;
  fetchPipelines: () => Promise<void>;
}

type ApiListResponse = {
  data: Pipeline[];
};

export const usePipelinesStore = create<PipelinesState>()((set) => ({
  pipelines: [],
  isLoading: false,
  error: null,

  fetchPipelines: async (): Promise<void> => {
    set({ isLoading: true, error: null });

    try {
      const response: Response = await fetch(`${API_URL}/deals/pipelines`, {
        method: 'GET',
        headers: await authHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const body: ApiListResponse = (await response.json()) as ApiListResponse;
      set({ pipelines: body.data, isLoading: false });
    } catch (e: unknown) {
      const msg: string = e instanceof Error ? e.message : 'Unknown error';
      set({ error: msg, isLoading: false });
    }
  },
}));
