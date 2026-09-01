import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
}  from 'react-native';
import type { DimensionValue } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Plus, Workflow as WorkflowIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import HomeBackButton from '../../components/HomeBackButton';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';

interface WorkflowItem {
  id: string;
  name: string;
  trigger: string;
  status: string;
  actions: unknown[];
  _count: { runs: number };
}

interface WorkflowsApiResponse {
  data: WorkflowItem[];
  meta: { total: number };
}

interface SkeletonBoxProps {
  width: DimensionValue;
  height: number;
  borderRadius?: number;
  marginBottom?: number;
}

function SkeletonBox({ width, height, borderRadius = 4, marginBottom = 0 }: SkeletonBoxProps): JSX.Element {
  const { colors } = useTheme();
  return <View style={{ width, height, backgroundColor: colors.accentSoft, borderRadius, marginBottom }} />;
}

const TRIGGER_KEY_MAP: Record<string, string> = {
  contact_created: 'trigger_contact_created',
  deal_stage_changed: 'trigger_deal_stage_changed',
  task_completed: 'trigger_task_completed',
  deal_won: 'trigger_deal_won',
  deal_created: 'trigger_deal_created',
  task_created: 'trigger_task_created',
  deal_stale: 'trigger_deal_stale',
};

export default function WorkflowsScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const [items, setItems] = useState<WorkflowItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const fetchWorkflows = useCallback(
    (silent: boolean): void => {
      if (!token) return;
      if (!silent) {
        setIsLoading(true);
        setError(null);
      }
      fetch(API_URL + '/workflows', {
        headers: { Authorization: 'Bearer ' + token },
      })
        .then((res) => {
          if (!res.ok) throw new Error('Workflows failed with status ' + res.status);
          return res.json() as Promise<WorkflowsApiResponse>;
        })
        .then((body) => {
          setItems(body.data);
          setIsLoading(false);
          setIsRefreshing(false);
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : t('errors.networkError'));
          setIsLoading(false);
          setIsRefreshing(false);
        });
    },
    [token, t],
  );

  useEffect(() => {
    fetchWorkflows(false);
  }, [fetchWorkflows]);

  const handleRefresh = useCallback((): void => {
    setIsRefreshing(true);
    fetchWorkflows(true);
  }, [fetchWorkflows]);

  const handleToggle = useCallback(
    (item: WorkflowItem, newValue: boolean): void => {
      if (!token) return;
      const newStatus = newValue ? 'active' : 'paused';
      setItems((prev) =>
        prev.map((w) => (w.id === item.id ? { ...w, status: newStatus } : w)),
      );
      fetch(API_URL + '/workflows/' + item.id, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: newStatus }),
      })
        .then((res) => {
          if (!res.ok) throw new Error('PATCH failed: ' + res.status);
        })
        .catch(() => {
          setItems((prev) =>
            prev.map((w) => (w.id === item.id ? { ...w, status: item.status } : w)),
          );
        });
    },
    [token],
  );

  const getTriggerLabel = useCallback(
    (trigger: string): string => {
      const key = TRIGGER_KEY_MAP[trigger];
      if (key) return t('workflows.' + key);
      return trigger.replace(/_/g, ' ');
    },
    [t],
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <SkeletonBox width={140} height={28} borderRadius={6} />
          <SkeletonBox width={40} height={40} borderRadius={8} />
        </View>
        <View style={styles.list}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.skeletonRow}>
              <SkeletonBox width={42} height={42} borderRadius={8} marginBottom={0} />
              <View style={styles.skeletonBody}>
                <SkeletonBox width='70%' height={16} borderRadius={4} marginBottom={8} />
                <SkeletonBox width='50%' height={13} borderRadius={4} />
              </View>
              <SkeletonBox width={51} height={31} borderRadius={16} />
            </View>
          ))}
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <HomeBackButton />
            <Text style={styles.title}>{t('workflows.title')}</Text>
          </View>
          <TouchableOpacity
            style={styles.addButton}
            onPress={() => { router.push('/workflows/new' as never); }}
            accessibilityRole='button'
          >
            <Plus size={20} color={colors.onAccent} />
          </TouchableOpacity>
        </View>
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => { fetchWorkflows(false); }}>
            <Text style={styles.retryText}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <HomeBackButton />
          <Text style={styles.title}>{t('workflows.title')}</Text>
        </View>
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => { router.push('/workflows/new' as never); }}
          accessibilityRole='button'
        >
          <Plus size={20} color={colors.onAccent} />
        </TouchableOpacity>
      </View>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={items.length === 0 ? styles.emptyList : styles.list}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={<Text style={styles.emptyText}>{t('workflows.empty')}</Text>}
        renderItem={({ item }) => {
          const actionCount = Array.isArray(item.actions) ? item.actions.length : 0;
          const isEnabled = item.status === 'active';
          return (
            <View style={styles.row}>
              <View style={styles.iconBox}>
                <WorkflowIcon size={20} color={colors.accent} />
              </View>
              <TouchableOpacity
                style={styles.rowBody}
                onPress={() => { router.push(('/workflows/' + item.id) as never); }}
                activeOpacity={0.7}
              >
                <Text style={styles.rowTitle}>{item.name}</Text>
                <Text style={styles.rowMeta}>{getTriggerLabel(item.trigger)}</Text>
              </TouchableOpacity>
              <View style={styles.rowRight}>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{actionCount}</Text>
                </View>
                <Switch
                  value={isEnabled}
                  onValueChange={(val) => { handleToggle(item, val); }}
                  trackColor={{ false: colors.border, true: '#93C5FD' }}
                  thumbColor={isEnabled ? colors.accent : colors.textMuted}
                />
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  header: {
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: type.display.fontSize, fontWeight: '700', color: c.text1 },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  emptyList: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { color: c.amber, fontSize: type.heading.fontSize, textAlign: 'center' },
  row: {
    minHeight: 72,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.md,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  skeletonRow: {
    minHeight: 72,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.md,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  skeletonBody: { flex: 1, marginHorizontal: spacing.md },
  iconBox: {
    width: 42,
    height: 42,
    borderRadius: radius.lg,
    backgroundColor: c.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: type.heading.fontSize, fontWeight: '700', color: c.text1 },
  rowMeta: { marginTop: spacing.xs, color: c.amber, fontSize: type.label.fontSize },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: spacing.sm },
  badge: {
    minWidth: 24,
    height: 24,
    borderRadius: radius.lg,
    backgroundColor: c.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { fontSize: type.caption.fontSize, fontWeight: '700', color: c.accent },
  errorText: { color: c.danger, marginBottom: spacing.md, textAlign: 'center' },
  retryButton: {
    paddingHorizontal: spacing.lg,
    height: 40,
    borderRadius: radius.lg,
    backgroundColor: c.accent,
    justifyContent: 'center',
  },
  retryText: { color: c.onAccent, fontWeight: '700' },
});
