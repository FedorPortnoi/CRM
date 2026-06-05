import React, { useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, ListRenderItemInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, CheckCheck, CheckSquare, Users, Kanban } from 'lucide-react-native';
import { useNotificationStore, AppNotification } from '../../store/notificationStore';

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

function entityIcon(entityType: string): React.ReactElement {
  const color = '#B07868';
  const size = 18;
  if (entityType === 'task') return <CheckSquare size={size} color={color} strokeWidth={1.8} />;
  if (entityType === 'deal') return <Kanban size={size} color={color} strokeWidth={1.8} />;
  return <Users size={size} color={color} strokeWidth={1.8} />;
}

function routeFor(n: AppNotification): string {
  if (n.entity_type === 'task') return `/task/${n.entity_id}`;
  if (n.entity_type === 'deal') return `/deal/${n.entity_id}`;
  return `/contact/${n.entity_id}`;
}

export default function NotificationsScreen() {
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
          {entityIcon(item.entity_type)}
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
    [handleOpen],
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
        ListFooterComponent={loading ? <ActivityIndicator color="#C45A10" style={{ marginVertical: 16 }} /> : null}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Bell size={52} color="#E8DDD6" strokeWidth={1.3} />
              <Text style={styles.emptyTitle}>Всё тихо</Text>
              <Text style={styles.emptySub}>Здесь будут уведомления о задачах, сделках и контактах</Text>
            </View>
          ) : null
        }
      />

      {unreadCount > 0 && (
        <TouchableOpacity style={styles.markAllBtn} onPress={() => void markAllRead()} activeOpacity={0.85}>
          <CheckCheck size={16} color="#C45A10" strokeWidth={2.5} />
          <Text style={styles.markAllText}>Прочитать все ({unreadCount})</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  list: { paddingTop: 4 },
  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#F5EDE8', gap: 12,
  },
  rowUnread: { backgroundColor: '#FFF8F5' },
  iconWrap: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: '#F5EDE8', alignItems: 'center', justifyContent: 'center',
    marginTop: 1,
  },
  iconWrapUnread: { backgroundColor: '#FDDECF' },
  content: { flex: 1 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  title: { fontSize: 14, fontWeight: '500', color: '#6B5B55', flex: 1, marginRight: 8 },
  titleUnread: { fontWeight: '700', color: '#383432' },
  time: { fontSize: 11, color: '#CFADA3', flexShrink: 0 },
  body: { fontSize: 13, color: '#B07868', lineHeight: 18 },
  dot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#C45A10', marginTop: 6, flexShrink: 0,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12, marginTop: 100 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#383432' },
  emptySub: { fontSize: 14, color: '#B07868', textAlign: 'center', lineHeight: 20 },
  markAllBtn: {
    position: 'absolute', bottom: 20, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fff', paddingHorizontal: 18, paddingVertical: 10,
    borderRadius: 20, borderWidth: 1, borderColor: '#E8DDD6',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 6, elevation: 3,
  },
  markAllText: { color: '#C45A10', fontWeight: '600', fontSize: 14 },
});
