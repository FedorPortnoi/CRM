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

// The handshake URL, or null when there is no ticket to hand over.
//
// There used to be a `?token=` fallback here for backends predating /ws/ticket. It is gone and
// must not come back: a query string is written to proxy logs, server access logs and client
// history, so that fallback published the long-lived bearer JWT to every hop on the path. Worse,
// it triggered on ANY failure of /ws/ticket — a transient 500 or a timeout was enough. There is
// a single deployed backend and it serves tickets, so a missing ticket now means "retry", never
// "downgrade": the connection fails closed.
export function resolveWsUrl(ticket: string | null): string | null {
  return ticket === null ? null : getTicketWsUrl(ticket);
}

// Exchange the JWT (sent in the Authorization header, never in a URL) for a short-lived,
// single-use handshake ticket. Returns null on any failure, which the caller treats as a
// connection failure to be retried with backoff.
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

      const url = resolveWsUrl(ticket);
      if (url === null) {
        // Fail closed: no ticket, no socket. Reuse the same backoff as a dropped connection so
        // a backend that is briefly unhealthy produces the usual 1s→30s curve instead of a
        // tight retry loop, and so live updates resume by themselves once it recovers.
        scheduleRetry();
        return;
      }

      const ws = new WebSocket(url);
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
