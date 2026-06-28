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

export const usePipelinesStore = create<PipelinesState>()((set, get) => ({
  pipelines: [],
  isLoading: false,
  error: null,

  fetchPipelines: async (): Promise<void> => {
    if (get().isLoading) return;
    set({ isLoading: true, error: null });

    // Delay before XHR: React Native's networking layer corrupts responseText
    // when multiple XHRs fire concurrently (dashboard polling + this request).
    await new Promise<void>((r) => setTimeout(r, 350));

    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((r) => setTimeout(r, 400));
      }
      try {
        const headers = await authHeaders();
        const text = await new Promise<string>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', `${API_URL}/deals/pipelines`, true);
          xhr.setRequestHeader('Authorization', headers['Authorization']);
          xhr.responseType = 'text';
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(String(xhr.responseText ?? xhr.response ?? ''));
            } else {
              reject(new Error(`Request failed with status ${xhr.status}`));
            }
          };
          xhr.onerror = () => reject(new Error('Network request failed'));
          xhr.ontimeout = () => reject(new Error('Network request timed out'));
          xhr.send(null);
        });

        const body: ApiListResponse = JSON.parse(text) as ApiListResponse;
        set({ pipelines: body.data, isLoading: false });
        return;
      } catch (e: unknown) {
        lastError = e instanceof Error ? e.message : 'Unknown error';
      }
    }
    set({ error: lastError, isLoading: false });
  },
}));
