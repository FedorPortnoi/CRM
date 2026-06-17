import { create } from 'zustand';
import { useUserStore } from './userStore';

export interface AppNotification {
  id: string;
  event_type: string;
  role: string;
  title: string;
  body: string;
  entity_type: string;
  entity_id: string;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

interface NotificationState {
  notifications: AppNotification[];
  unreadCount: number;
  loading: boolean;
  page: number;
  total: number;
  fetchNotifications: (reset?: boolean) => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
}

function apiBase() {
  return process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';
}

function authHeaders() {
  const token = useUserStore.getState().token;
  return { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' };
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  loading: false,
  page: 1,
  total: 0,

  fetchNotifications: async (reset = false) => {
    const nextPage = reset ? 1 : get().page;
    if (get().loading) return;
    set({ loading: true });

    try {
      const res = await fetch(`${apiBase()}/notifications?page=${nextPage}&per_page=30`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const json = await res.json() as { data: AppNotification[]; meta: { total: number; unread: number } };
      set((s) => ({
        notifications: reset ? json.data : [...s.notifications, ...json.data],
        total: json.meta.total,
        unreadCount: json.meta.unread,
        page: nextPage + 1,
      }));
    } finally {
      set({ loading: false });
    }
  },

  markRead: async (id: string) => {
    set((s) => ({
      notifications: s.notifications.map((n) => n.id === id ? { ...n, is_read: true } : n),
      unreadCount: Math.max(0, s.unreadCount - (s.notifications.find((n) => n.id === id)?.is_read ? 0 : 1)),
    }));
    await fetch(`${apiBase()}/notifications/${id}/read`, {
      method: 'PATCH',
      headers: { Authorization: authHeaders().Authorization },
    });
  },

  markAllRead: async () => {
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, is_read: true })),
      unreadCount: 0,
    }));
    await fetch(`${apiBase()}/notifications/read-all`, {
      method: 'PATCH',
      headers: { Authorization: authHeaders().Authorization },
    });
  },

  fetchUnreadCount: async () => {
    try {
      const res = await fetch(`${apiBase()}/notifications/unread-count`, { headers: authHeaders() });
      if (!res.ok) return;
      const json = await res.json() as { data: { count: number } };
      set({ unreadCount: json.data.count });
    } catch {
      // silently ignore
    }
  },
}));
