import { create } from 'zustand';
import { API_URL, authHeaders } from '../utils/api';
import { fetchWsTicket, resolveWsUrl } from '../utils/websocket';

export type ChatMessage = {
  id: string;
  channel: string;
  body: string;
  sender: { id: string; name: string };
  created_at: string;
};

export type Channel = {
  channel: string;
  type: 'group' | 'dm';
  name: string;
  partner: { id: string; name: string } | null;
  last_message: { body: string; sender_name: string; created_at: string } | null;
  unread: number;
};

interface ChatState {
  channels: Channel[];
  messages: Record<string, ChatMessage[]>; // channel → newest-first
  hasMore: Record<string, boolean>;
  ws: WebSocket | null;
  // Token whose ticket exchange is in flight, or null when none is. The exchange is async and
  // `ws` only becomes non-null at the very end of it, so `ws` alone cannot answer "is a
  // connection already being set up?" — see connect().
  connectingToken: string | null;
  loadingChannels: boolean;

  connect: (token: string) => void;
  disconnect: () => void;
  fetchChannels: () => Promise<void>;
  fetchMessages: (channel: string, before?: string) => Promise<void>;
  sendMessage: (channel: string, body: string) => Promise<void>;
  markRead: (channel: string) => Promise<void>;
  _addIncoming: (msg: ChatMessage) => void;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  channels: [],
  messages: {},
  hasMore: {},
  ws: null,
  connectingToken: null,
  loadingChannels: false,

  /**
   * Close the socket and drop everything read over it.
   *
   * Called from logout(). Without it, `connect()`'s `if (ws) return;` guard —
   * correct on its own, since the Chat tab calls connect() on every visit —
   * meant user A's socket survived user B signing in: still open, still
   * authenticated as A, still pushing A's organisation's messages into the
   * store B is reading. Same cross-account shape as the offline queue, and it
   * needed a teardown rather than a smarter guard, because there is nothing
   * wrong with the guard.
   *
   * Channels and messages are cleared too. Closing the pipe while leaving A's
   * conversations in memory would still paint them for B on the first render.
   */
  disconnect: () => {
    const { ws } = get();
    try {
      ws?.close();
    } catch {
      // Already closing or already dead — nothing to do, and logout must not
      // fail on it.
    }
    set({ ws: null, connectingToken: null, channels: [], messages: {} });
  },

  connect: (token: string) => {
    const { ws, connectingToken } = get();
    // Already connected — the Chat tab calls connect() on every visit.
    if (ws) return;
    // ...and an exchange for this same session is already running. `ws` is null for the whole
    // round trip below, so without this two visits in quick succession would open two sockets.
    if (connectingToken === token) return;

    set({ connectingToken: token });

    void (async () => {
      // The same exchange the org socket uses (src/utils/websocket.ts), against the same
      // /api/v1/ws endpoint: the JWT goes in the Authorization header and a short-lived,
      // single-use ticket goes in the URL.
      //
      // This used to open the socket with the bearer JWT in the query string. That is the
      // fallback websocket.ts deleted and documented as "must not come back" — a query string is
      // written to proxy logs, server access logs and client history, so it published a
      // long-lived credential to every hop on the path. It had not come back so much as never
      // left: this was a second implementation of the same handshake, and only the first one was
      // migrated. There is now one implementation, imported here.
      const ticket = await fetchWsTicket(token);

      // A different session started connecting while the exchange was in flight — logout
      // followed by somebody else signing in on the same device re-runs the Chat tab's effect.
      // The ticket was minted for `token`, so it must be dropped rather than used to open a
      // socket the new user then reads other people's messages from.
      if (get().connectingToken !== token) return;

      const url = resolveWsUrl(ticket);
      if (url === null) {
        // Fail closed: no ticket, no socket, and no downgrade path. A missing ticket means
        // "try again the next time the tab is opened", never "send the JWT instead".
        set({ connectingToken: null });
        return;
      }

      const socket = new WebSocket(url);

      socket.onopen = () => {};
      socket.onclose = () => set({ ws: null });
      socket.onerror = () => set({ ws: null });

      socket.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string) as { type: string; message?: ChatMessage };
          if (data.type === 'chat:message' && data.message) {
            get()._addIncoming(data.message);
          }
        } catch { /* ignore */ }
      };

      set({ ws: socket, connectingToken: null });
    })();
  },

  fetchChannels: async () => {
    set({ loadingChannels: true });
    try {
      const res = await fetch(`${API_URL}/chat/channels`, {
        headers: await authHeaders(),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { data: Channel[] };
      // General always pinned first, rest sorted by most recent message
      const sorted = [...json.data].sort((a, b) => {
        if (a.channel === 'general') return -1;
        if (b.channel === 'general') return 1;
        const aTime = a.last_message?.created_at ?? '';
        const bTime = b.last_message?.created_at ?? '';
        return bTime.localeCompare(aTime);
      });
      set({ channels: sorted });
    } catch { /* network error — ignore */ }
    finally { set({ loadingChannels: false }); }
  },

  fetchMessages: async (channel: string, before?: string) => {
    const params = new URLSearchParams({ channel, limit: '50' });
    if (before) params.set('before', before);
    try {
      const res = await fetch(`${API_URL}/chat/messages?${params.toString()}`, {
        headers: await authHeaders(),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { data: ChatMessage[]; meta: { has_more: boolean } };
      set((state) => {
        const existing = state.messages[channel] ?? [];
        // Merge: new page goes at end (older), deduplicate by id
        const merged = before
          ? [...existing, ...json.data.filter((m) => !existing.some((e) => e.id === m.id))]
          : json.data;
        return {
          messages: { ...state.messages, [channel]: merged },
          hasMore: { ...state.hasMore, [channel]: json.meta.has_more },
        };
      });
    } catch { /* ignore */ }
  },

  sendMessage: async (channel: string, body: string) => {
    const res = await fetch(`${API_URL}/chat/messages`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ channel, body }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: { message: string } };
      throw new Error(err.error?.message ?? 'Send failed');
    }
    const json = (await res.json()) as { data: ChatMessage };
    // Optimistic insert (WS will also deliver it — deduplicate by id)
    get()._addIncoming(json.data);
  },

  markRead: async (channel: string) => {
    try {
      await fetch(`${API_URL}/chat/read`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ channel }),
      });
      // Clear unread count in local channel list
      set((state) => ({
        channels: state.channels.map((c) =>
          c.channel === channel ? { ...c, unread: 0 } : c
        ),
      }));
    } catch { /* ignore */ }
  },

  _addIncoming: (msg: ChatMessage) => {
    set((state) => {
      const existing = state.messages[msg.channel] ?? [];
      if (existing.some((m) => m.id === msg.id)) return state;
      const updated = [msg, ...existing];
      // Update channel last_message + clear unread for group if we sent it
      const channels = state.channels.map((c) => {
        if (c.channel !== msg.channel) return c;
        return {
          ...c,
          last_message: {
            body: msg.body,
            sender_name: msg.sender.name,
            created_at: msg.created_at,
          },
        };
      });
      return { messages: { ...state.messages, [msg.channel]: updated }, channels };
    });
  },
}));
