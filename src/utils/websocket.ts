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
//
// Exported because src/store/chatStore.ts opens the very same /api/v1/ws endpoint and has to go
// through the very same exchange. A second, private copy of "how we open the socket" is exactly
// how the `?token=` fallback removed above survived elsewhere in the app: there must be one
// implementation of this handshake, and this is it.
export async function fetchWsTicket(token: string): Promise<string | null> {
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

export type HandshakeOutcome =
  // A ticket came back and still belongs to the session that asked for it.
  | { status: 'ready'; url: string }
  // The backend could not issue a ticket. Retryable — see the backoff in useOrgWebSocket.
  | { status: 'no-ticket' }
  // The session moved on while the exchange was in flight. NOT retryable by this caller: the
  // attempt that superseded it is already running.
  | { status: 'stale' };

// One handshake attempt, from "we want a socket" to "here is the URL to open".
//
// `currentToken` and `mounted` are read AFTER the exchange resolves, and the token comparison is
// the load-bearing half of the check. Mount state alone does not work, and the reason is not
// subtle: connect() below is a useCallback keyed on [token] and its effect depends on [connect],
// so changing accounts runs the cleanup (mounted := false) and then the new effect body
// (mounted := true) back-to-back and synchronously — long before any in-flight fetchWsTicket
// resolves. By the time the guard runs, `mounted` is true again, so guarding on it waves through
// a ticket minted for the PREVIOUS user and opens a socket into the previous account's org from
// inside the new user's session. A ticket belongs to the token that asked for it and to nothing
// else, so that is what it is checked against.
export async function openHandshake(
  token: string,
  currentToken: () => string | null,
  mounted: () => boolean,
): Promise<HandshakeOutcome> {
  const ticket = await fetchWsTicket(token);

  if (!mounted() || currentToken() !== token) {
    return { status: 'stale' };
  }

  const url = resolveWsUrl(ticket);
  return url === null ? { status: 'no-ticket' } : { status: 'ready', url };
}

export function useOrgWebSocket(onMessage: MessageHandler): void {
  const token = useUserStore((s) => s.token);
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // The session this hook is serving right now. connect() closes over the token it was built
  // with; this ref carries whatever the latest effect run installed, and the two are compared
  // once the ticket comes back. See openHandshake() for why mountedRef cannot do that job.
  const tokenRef = useRef<string | null>(token);
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
      const handshake = await openHandshake(
        token,
        () => tokenRef.current,
        () => mountedRef.current,
      );

      // Signed out, or somebody else is signed in now. Drop the ticket on the floor and do not
      // schedule a retry: scheduleRetry() would re-enter this same connect() closure, which is
      // still bound to the departed token, and mint another ticket for a session that is gone.
      // The effect run for the current token has already started its own attempt.
      if (handshake.status === 'stale') return;

      if (handshake.status === 'no-ticket') {
        // Fail closed: no ticket, no socket. Reuse the same backoff as a dropped connection so
        // a backend that is briefly unhealthy produces the usual 1s→30s curve instead of a
        // tight retry loop, and so live updates resume by themselves once it recovers.
        scheduleRetry();
        return;
      }

      const ws = new WebSocket(handshake.url);
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
    // Must be written before connect() runs: it is the value every in-flight handshake — the
    // one started here and any still resolving from the previous token — is checked against.
    tokenRef.current = token;
    connect();
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect, token]);
}
