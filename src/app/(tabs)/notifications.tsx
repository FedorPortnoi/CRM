import React, { useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, ListRenderItemInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, CheckCheck, CheckSquare, Users, Kanban } from 'lucide-react-native';
import { useNotificationStore, AppNotification } from '../../store/notificationStore';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ч`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} д`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function entityIcon(entityType: string, amber: string): React.ReactElement {
  const size = 18;
  if (entityType === 'task') return <CheckSquare size={size} color={amber} strokeWidth={1.8} />;
  if (entityType === 'deal') return <Kanban size={size} color={amber} strokeWidth={1.8} />;
  return <Users size={size} color={amber} strokeWidth={1.8} />;
}

function routeFor(n: AppNotification): string {
  if (n.entity_type === 'task') return `/task/${n.entity_id}`;
  if (n.entity_type === 'deal') return `/deal/${n.entity_id}`;
  return `/contact/${n.entity_id}`;
}

export default function NotificationsScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { notifications, unreadCount, loading, total, fetchNotifications, markRead, markAllRead } =
    useNotificationStore();

  useEffect(() => {
    void fetchNotifications(true);
  }, []);

  const handleOpen = useCallback(
    (n: AppNotification) => {
      if (!n.is_read) void markRead(n.id);
      router.push(routeFor(n) as never);
    },
    [markRead, router],
  );

  const loadMore = useCallback(() => {
    if (notifications.length < total && !loading) void fetchNotifications(false);
  }, [notifications.length, total, loading, fetchNotifications]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<AppNotification>) => (
      <TouchableOpacity
        style={[styles.row, !item.is_read && styles.rowUnread]}
        onPress={() => handleOpen(item)}
        activeOpacity={0.75}
      >
        <View style={[styles.iconWrap, !item.is_read && styles.iconWrapUnread]}>
          {entityIcon(item.entity_type, colors.amber)}
        </View>
        <View style={styles.content}>
          <View style={styles.topRow}>
            <Text style={[styles.title, !item.is_read && styles.titleUnread]} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
          </View>
          <Text style={styles.body} numberOfLines={2}>{item.body}</Text>
        </View>
        {!item.is_read && <View style={styles.dot} />}
      </TouchableOpacity>
    ),
    [handleOpen, styles, colors.amber],
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        contentContainerStyle={[styles.list, { paddingBottom: 32 }]}
        showsVerticalScrollIndicator={false}
        ListFooterComponent={loading ? <ActivityIndicator color={colors.orange} style={{ marginVertical: 16 }} /> : null}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Bell size={52} color={colors.skeleton} strokeWidth={1.3} />
              <Text style={styles.emptyTitle}>Всё тихо</Text>
              <Text style={styles.emptySub}>Здесь будут уведомления о задачах, сделках и контактах</Text>
            </View>
          ) : null
        }
      />

      {unreadCount > 0 && (
        <TouchableOpacity style={styles.markAllBtn} onPress={() => void markAllRead()} activeOpacity={0.85}>
          <CheckCheck size={16} color={colors.orange} strokeWidth={2.5} />
          <Text style={styles.markAllText}>Прочитать все ({unreadCount})</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  list: { paddingTop: 4 },
  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: c.bgPanel, paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: c.border, gap: 12,
  },
  rowUnread: { backgroundColor: c.skeleton },
  iconWrap: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: c.wheat, alignItems: 'center', justifyContent: 'center',
    marginTop: 1,
  },
  iconWrapUnread: { backgroundColor: 'rgba(204,120,92,0.15)' },
  content: { flex: 1 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  title: { fontSize: 14, fontWeight: '500', color: c.textMuted, flex: 1, marginRight: 8 },
  titleUnread: { fontWeight: '700', color: c.text1 },
  time: { fontSize: 11, color: c.textMuted, flexShrink: 0 },
  body: { fontSize: 13, color: c.amber, lineHeight: 18 },
  dot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: c.orange, marginTop: 6, flexShrink: 0,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12, marginTop: 100 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: c.text1 },
  emptySub: { fontSize: 14, color: c.amber, textAlign: 'center', lineHeight: 20 },
  markAllBtn: {
    position: 'absolute', bottom: 20, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: c.bgPanel, paddingHorizontal: 18, paddingVertical: 10,
    borderRadius: 20, borderWidth: 1, borderColor: c.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 6, elevation: 3,
  },
  markAllText: { color: c.orange, fontWeight: '600', fontSize: 14 },
});
