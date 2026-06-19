import { useQuery, UseQueryResult } from '@tanstack/react-query';
import { API_URL } from '../utils/api';
import { useUserStore } from '../store/userStore';

export interface AuditEntry {
  id: string;
  user_id: string | null;
  action: string;
  created_at: string;
}

interface AuditLogResponse {
  data: AuditEntry[];
}

type EntityType = 'contact' | 'deal' | 'task' | 'calendar_event';

export function useAuditLog(
  entityType: EntityType,
  entityId: string | undefined,
): UseQueryResult<AuditEntry[], Error> {
  const token = useUserStore((s) => s.token);

  return useQuery<AuditEntry[], Error>({
    queryKey: ['audit-log', entityType, entityId, token],
    queryFn: async (): Promise<AuditEntry[]> => {
      if (!token) throw new Error('Unauthorized');
      if (!entityId) throw new Error('Entity ID is required');

      const res = await fetch(
        `${API_URL}/activities?entity_type=${entityType}&entity_id=${entityId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!res.ok) {
        throw new Error(`Request failed with status ${res.status}`);
      }

      const body = (await res.json()) as AuditLogResponse;
      return body.data;
    },
    enabled: !!token && !!entityId,
  });
}
