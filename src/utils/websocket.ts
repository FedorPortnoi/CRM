import { useEffect, useRef, useCallback } from 'react';
import { useUserStore } from '../store/userStore';
import { API_URL } from './api';

type WsMessage = { type: string; data: unknown };
type MessageHandler = (msg: WsMessage) => void;

function wsBase(): string {
  return API_URL.replace(/^http/, 'ws').replace(/\/api\/v1\/?$/, '');
}

function getTicketWsUrl(ticket: string): string {
  return `${wsBase()}/api/v1/ws?ticket=${encodeURIComponent(ticket)}`;
}

// DEPRECATED fallback: puts the long-lived JWT in the URL. Kept only for backends older than
// the /ws/ticket endpoint; remove once every deployed backend serves tickets.
function getTokenWsUrl(token: string): string {
  return `${wsBase()}/api/v1/ws?token=${encodeURIComponent(token)}`;
}

// Exchange the JWT (sent in the Authorization header, never in a URL) for a short-lived,
// single-use handshake ticket. Returns null when the backend has no ticket endpoint (404) or
// the request fails, in which case the caller falls back to the legacy ?token= URL.
async function fetchWsTicket(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/ws/ticket`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { ticket?: string } };
    return json.data?.ticket ?? null;
  } catch {
    return null;
  }
}

export function useOrgWebSocket(onMessage: MessageHandler): void {
  const token = useUserStore((s) => s.token);
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (!token || !mountedRef.current) return;

    const scheduleRetry = () => {
      if (!mountedRef.current) return;
      const delay = Math.min(30_000, 1_000 * 2 ** retryCountRef.current);
      retryCountRef.current += 1;
      retryTimerRef.current = setTimeout(connect, delay);
    };

    void (async () => {
      const ticket = await fetchWsTicket(token);
      // The token may have been cleared (logout) while the ticket request was in flight.
      if (!mountedRef.current) return;

      const ws = new WebSocket(ticket ? getTicketWsUrl(ticket) : getTokenWsUrl(token));
      wsRef.current = ws;

      ws.onopen = () => {
        retryCountRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as WsMessage;
          onMessageRef.current(msg);
        } catch { /* ignore malformed frames */ }
      };

      ws.onclose = () => {
        scheduleRetry();
      };

      ws.onerror = () => ws.close();
    })();
  }, [token]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);
}
