import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../utils/api';

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

function wsUrl(): string {
  const base = API_URL.replace(/^https/, 'wss').replace(/^http/, 'ws');
  return `${base}/ws`;
}

interface ChatState {
  channels: Channel[];
  messages: Record<string, ChatMessage[]>; // channel → newest-first
  hasMore: Record<string, boolean>;
  ws: WebSocket | null;
  loadingChannels: boolean;

  connect: (token: string) => void;
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
  loadingChannels: false,

  connect: (token: string) => {
    const existing = get().ws;
    if (existing) return;

    const socket = new WebSocket(`${wsUrl()}?token=${encodeURIComponent(token)}`);

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

    set({ ws: socket });
  },

  fetchChannels: async () => {
    const token = await SecureStore.getItemAsync('crm_auth_token');
    if (!token) return;
    set({ loadingChannels: true });
    try {
      const res = await fetch(`${API_URL}/chat/channels`, {
        headers: { Authorization: `Bearer ${token}` },
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
    const token = await SecureStore.getItemAsync('crm_auth_token');
    if (!token) return;
    const params = new URLSearchParams({ channel, limit: '50' });
    if (before) params.set('before', before);
    try {
      const res = await fetch(`${API_URL}/chat/messages?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
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
    const token = await SecureStore.getItemAsync('crm_auth_token');
    if (!token) return;
    const res = await fetch(`${API_URL}/chat/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    const token = await SecureStore.getItemAsync('crm_auth_token');
    if (!token) return;
    try {
      await fetch(`${API_URL}/chat/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
