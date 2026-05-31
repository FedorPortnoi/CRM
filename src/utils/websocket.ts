import { useEffect, useRef, useCallback } from 'react';
import { useUserStore } from '../store/userStore';
import { API_URL } from './api';

type WsMessage = { type: string; data: unknown };
type MessageHandler = (msg: WsMessage) => void;

function getWsUrl(token: string): string {
  const base = API_URL.replace(/^http/, 'ws').replace(/\/api\/v1\/?$/, '');
  return `${base}/api/v1/ws?token=${encodeURIComponent(token)}`;
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

    const ws = new WebSocket(getWsUrl(token));
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
      if (!mountedRef.current) return;
      const delay = Math.min(30_000, 1_000 * 2 ** retryCountRef.current);
      retryCountRef.current += 1;
      retryTimerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();
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
