import React, { useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, ListRenderItemInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, CheckCheck, CheckSquare, Users, Kanban } from 'lucide-react-native';
import { useNotificationStore, AppNotification } from '../../store/notificationStore';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { EmptyState, Skeleton } from '../../components/ui';

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

/** Loading placeholder shaped like a real notification row. */
function SkeletonRow({ styles }: { styles: ReturnType<typeof makeStyles> }): JSX.Element {
  return (
    <View style={styles.row}>
      <Skeleton width={38} height={38} rounded={radius.md} />
      <View style={styles.content}>
        <Skeleton width="55%" height={14} />
        <Skeleton width="85%" height={12} style={styles.skeletonBody} />
      </View>
    </View>
  );
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
        activeOpacity={0.7}
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

  // First page still in flight: show row-shaped skeletons rather than a bare
  // spinner, so the list does not jump when real rows arrive.
  const initialLoading = loading && notifications.length === 0;

  return (
    <View style={styles.container}>
      {initialLoading ? (
        <View style={styles.list}>
          {Array.from({ length: 6 }, (_, i) => <SkeletonRow key={i} styles={styles} />)}
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          contentContainerStyle={[styles.list, styles.listPad]}
          showsVerticalScrollIndicator={false}
          ListFooterComponent={loading ? <ActivityIndicator color={colors.accent} style={styles.footer} /> : null}
          ListEmptyComponent={
            !loading ? (
              <EmptyState
                icon={<Bell size={52} color={colors.skeleton} strokeWidth={1.3} />}
                title="Всё тихо"
                description="Здесь будут уведомления о задачах, сделках и контактах"
              />
            ) : null
          }
        />
      )}

      {unreadCount > 0 && (
        <TouchableOpacity style={styles.markAllBtn} onPress={() => void markAllRead()} activeOpacity={0.7}>
          <CheckCheck size={16} color={colors.accent} strokeWidth={2.5} />
          <Text style={styles.markAllText}>Прочитать все ({unreadCount})</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  list: { paddingTop: spacing.xs },
  listPad: { paddingBottom: spacing.xxl },
  footer: { marginVertical: spacing.lg },
  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: c.surface, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: c.border, gap: spacing.md,
  },
  rowUnread: { backgroundColor: c.skeleton },
  iconWrap: {
    width: 38, height: 38, borderRadius: radius.md,
    backgroundColor: c.wheat, alignItems: 'center', justifyContent: 'center',
  },
  iconWrapUnread: { backgroundColor: c.accentSoft },
  content: { flex: 1 },
  skeletonBody: { marginTop: spacing.sm },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  title: { ...type.body, color: c.textMuted, flex: 1, marginRight: spacing.sm },
  titleUnread: { fontWeight: '700', color: c.text1 },
  time: { ...type.micro, color: c.textMuted, flexShrink: 0, fontVariant: ['tabular-nums'] },
  body: { ...type.label, fontWeight: '500', color: c.amber },
  dot: {
    width: spacing.sm, height: spacing.sm, borderRadius: radius.pill,
    backgroundColor: c.accent, marginTop: spacing.sm, flexShrink: 0,
  },
  markAllBtn: {
    position: 'absolute', bottom: spacing.xl, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: c.surface, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    borderRadius: radius.xxl, borderWidth: 1, borderColor: c.border,
    shadowColor: '#000', // fixed: shadows read dark in both themes
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 6, elevation: 3,
  },
  markAllText: { ...type.body, fontWeight: '600', color: c.accent, fontVariant: ['tabular-nums'] },
});
