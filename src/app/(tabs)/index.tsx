import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { TrendingUp, CheckSquare, Activity, Zap, UserPlus, PlusCircle, ListChecks, ChevronRight } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { notifyPendingCaptureCount } from '../../utils/notifications';

const TEAL = '#065f46';
const CAPTURE_COUNT_POLL_INTERVAL_MS = 60000;

type DashboardData = {
  open_deals: { count: number; total_value: number };
  tasks_due_today: number;
  recent_activity: Array<{ type: string; id: string; summary: string; created_at: string }>;
  pipeline_health_score: number;
};

type TodayTask = {
  id: string;
  title: string;
  due_date: string | null;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
};

type RecentContact = {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
};

type SectionState<T> = {
  data: T | null;
  isLoading: boolean;
  error: string | null;
};

function initialSection<T>(): SectionState<T> {
  return { data: null, isLoading: true, error: null };
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

function formatCurrency(value: number): string {
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPipelineHealth(score: number): string {
  const percent = score <= 1 ? score * 100 : score;
  return percent.toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%';
}

function formatDueDate(date: string | null): string {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function contactName(contact: RecentContact): string {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ');
}

function getInitials(name: string): string {
  return name.split(' ').map(w => w[0] ?? '').slice(0, 2).join('').toUpperCase();
}

interface SectionErrorProps {
  message: string;
  onRetry: () => void;
  retryLabel: string;
}

function SectionError({ message, onRetry, retryLabel }: SectionErrorProps): JSX.Element {
  return (
    <View style={styles.inlineError}>
      <Text style={styles.inlineErrorText}>{message}</Text>
      <TouchableOpacity style={styles.inlineRetryButton} onPress={onRetry}>
        <Text style={styles.inlineRetryText}>{retryLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function DashboardScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const user = useUserStore((s) => s.user);
  const [summary, setSummary] = useState<SectionState<DashboardData>>(initialSection<DashboardData>);
  const [tasks, setTasks] = useState<SectionState<TodayTask[]>>(initialSection<TodayTask[]>);
  const [contacts, setContacts] = useState<SectionState<RecentContact[]>>(initialSection<RecentContact[]>);
  const [captureCount, setCaptureCount] = useState<number>(0);
  const [workflowCount, setWorkflowCount] = useState<SectionState<number>>(initialSection<number>);
  const [refreshing, setRefreshing] = useState(false);
  const previousCaptureCountRef = useRef<number | null>(null);

  const fetchSummary = useCallback(
    async (showSkeleton: boolean): Promise<void> => {
      if (!token) return;
      if (showSkeleton) setSummary((prev) => ({ ...prev, isLoading: true }));
      try {
        setSummary((prev) => ({ ...prev, error: null }));
        const res = await fetch(`${API_URL}/analytics/dashboard`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Dashboard failed with status ${res.status}`);
        const json = (await res.json()) as { data: DashboardData };
        setSummary({ data: json.data, isLoading: false, error: null });
      } catch (e: unknown) {
        setSummary((prev) => ({
          data: prev.data,
          isLoading: false,
          error: errorMessage(e, 'Failed to load dashboard summary'),
        }));
      }
    },
    [token],
  );

  const fetchTasks = useCallback(
    async (showSkeleton: boolean): Promise<void> => {
      if (!token) return;
      if (showSkeleton) setTasks((prev) => ({ ...prev, isLoading: true }));
      try {
        setTasks((prev) => ({ ...prev, error: null }));
        const res = await fetch(`${API_URL}/tasks/today`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Tasks failed with status ${res.status}`);
        const json = (await res.json()) as { data: TodayTask[] };
        setTasks({ data: json.data.slice(0, 5), isLoading: false, error: null });
      } catch (e: unknown) {
        setTasks((prev) => ({
          data: prev.data,
          isLoading: false,
          error: errorMessage(e, 'Failed to load today tasks'),
        }));
      }
    },
    [token],
  );

  const fetchContacts = useCallback(
    async (showSkeleton: boolean): Promise<void> => {
      if (!token) return;
      if (showSkeleton) setContacts((prev) => ({ ...prev, isLoading: true }));
      try {
        setContacts((prev) => ({ ...prev, error: null }));
        const res = await fetch(`${API_URL}/contacts?per_page=5&sort=created_at&order=desc`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Contacts failed with status ${res.status}`);
        const json = (await res.json()) as { data: RecentContact[] };
        setContacts({ data: json.data, isLoading: false, error: null });
      } catch (e: unknown) {
        setContacts((prev) => ({
          data: prev.data,
          isLoading: false,
          error: errorMessage(e, 'Failed to load recent contacts'),
        }));
      }
    },
    [token],
  );

  const fetchWorkflowCount = useCallback(async (showSkeleton: boolean): Promise<void> => {
    if (!token) return;
    if (showSkeleton) setWorkflowCount((prev) => ({ ...prev, isLoading: true }));
    try {
      setWorkflowCount((prev) => ({ ...prev, error: null }));
      const res = await fetch(`${API_URL}/workflows?status=active`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Workflows failed with status ${res.status}`);
      const json = (await res.json()) as { meta: { total: number } };
      setWorkflowCount({ data: json.meta.total, isLoading: false, error: null });
    } catch (e: unknown) {
      setWorkflowCount((prev) => ({
        data: prev.data,
        isLoading: false,
        error: errorMessage(e, 'Failed to load workflows'),
      }));
    }
  }, [token]);

  const fetchCaptureCount = useCallback(async (): Promise<void> => {
    if (!token) return;
    try {
      const res = await fetch(`${API_URL}/captures`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const json = (await res.json()) as { meta: { total: number } };
      const nextCount = json.meta.total;
      const previousCount = previousCaptureCountRef.current;
      previousCaptureCountRef.current = nextCount;
      setCaptureCount(nextCount);
      if (previousCount !== null && nextCount > previousCount) {
        void notifyPendingCaptureCount(
          t('dashboard.pendingCapturesNotificationTitle'),
          t('dashboard.pendingCapturesNotificationBody', { count: nextCount }),
        );
      }
    } catch {
      // non-critical
    }
  }, [token, t]);

  const fetchAll = useCallback(
    async (showSkeleton: boolean): Promise<void> => {
      await Promise.all([
        fetchSummary(showSkeleton),
        fetchTasks(showSkeleton),
        fetchContacts(showSkeleton),
        fetchCaptureCount(),
        fetchWorkflowCount(showSkeleton),
      ]);
    },
    [fetchSummary, fetchTasks, fetchContacts, fetchCaptureCount, fetchWorkflowCount],
  );

  useEffect(() => {
    void fetchAll(true);
  }, [fetchAll]);

  useEffect(() => {
    previousCaptureCountRef.current = null;
    setCaptureCount(0);
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    const interval = setInterval(() => {
      void fetchCaptureCount();
    }, CAPTURE_COUNT_POLL_INTERVAL_MS);
    return () => { clearInterval(interval); };
  }, [token, fetchCaptureCount]);

  const onRefresh = useCallback((): void => {
    setRefreshing(true);
    void fetchAll(false).finally(() => setRefreshing(false));
  }, [fetchAll]);

  const firstName = user?.name?.split(' ')[0] ?? 'there';
  const initials = user?.name ? getInitials(user.name) : '?';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={TEAL} />}
    >
      <View style={styles.circle1} pointerEvents="none" />
      <View style={styles.circle2} pointerEvents="none" />
      <View style={styles.circle3} pointerEvents="none" />

      {/* Header greeting */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.greetingText}>{t('dashboard.greeting', { name: firstName })}</Text>
          <Text style={styles.greetingSub}>{t('dashboard.workspaceToday')}</Text>
        </View>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarInitials}>{initials}</Text>
        </View>
      </View>

      {/* Metric cards */}
      <View style={styles.metricsRow}>
        {summary.isLoading ? (
          <>
            <View style={styles.metricSkeleton} />
            <View style={styles.metricSkeleton} />
            <View style={styles.metricSkeleton} />
          </>
        ) : summary.error ? (
          <View style={styles.fullWidth}>
            <SectionError message={summary.error} onRetry={() => { void fetchSummary(true); }} retryLabel={t('common.retry')} />
          </View>
        ) : summary.data ? (
          <>
            <View style={styles.metricCard}>
              <View style={[styles.metricIconBox, { backgroundColor: 'rgba(6,95,70,0.08)' }]}>
                <TrendingUp size={18} color={TEAL} />
              </View>
              <Text style={styles.metricNumber}>{summary.data.open_deals.count}</Text>
              <Text style={styles.metricLabel}>{t('dashboard.openDeals')}</Text>
              <Text style={styles.metricSub}>{formatCurrency(summary.data.open_deals.total_value)}</Text>
            </View>
            <View style={styles.metricCard}>
              <View style={[styles.metricIconBox, { backgroundColor: 'rgba(245,158,11,0.12)' }]}>
                <CheckSquare size={18} color="#f59e0b" />
              </View>
              <Text style={styles.metricNumber}>{summary.data.tasks_due_today}</Text>
              <Text style={styles.metricLabel}>{t('dashboard.dueToday')}</Text>
              <Text style={styles.metricSub}>{t('tabs.tasks')}</Text>
            </View>
            <View style={styles.metricCard}>
              <View style={[styles.metricIconBox, { backgroundColor: 'rgba(6,95,70,0.08)' }]}>
                <Activity size={18} color={TEAL} />
              </View>
              <Text style={styles.metricNumber}>{formatPipelineHealth(summary.data.pipeline_health_score)}</Text>
              <Text style={styles.metricLabel}>{t('dashboard.pipelineHealth')}</Text>
              <Text style={styles.metricSub}>{t('dashboard.score')}</Text>
            </View>
          </>
        ) : null}
      </View>

      {/* Quick actions */}
      <View style={styles.section}>
        <Text style={styles.sectionHeader}>{t('dashboard.quickActions')}</Text>
        <View style={styles.quickActionsRow}>
          <TouchableOpacity
            style={styles.quickAction}
            onPress={() => { router.push('/contact/new'); }}
            accessibilityRole="button"
          >
            <View style={styles.quickActionIcon}>
              <UserPlus size={18} color={TEAL} />
            </View>
            <Text style={styles.quickActionLabel}>{t('contacts.add')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.quickAction}
            onPress={() => { router.push('/deal/new'); }}
            accessibilityRole="button"
          >
            <View style={styles.quickActionIcon}>
              <PlusCircle size={18} color={TEAL} />
            </View>
            <Text style={styles.quickActionLabel}>{t('deals.add')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.quickAction}
            onPress={() => { router.push('/task/new'); }}
            accessibilityRole="button"
          >
            <View style={styles.quickActionIcon}>
              <ListChecks size={18} color={TEAL} />
            </View>
            <Text style={styles.quickActionLabel}>{t('tasks.add')}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Today's focus (tasks) */}
      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionHeader}>{t('dashboard.todayFocus')}</Text>
          <TouchableOpacity onPress={() => { router.push('/(tabs)/tasks'); }} accessibilityRole="button">
            <Text style={styles.viewAllText}>{t('dashboard.viewAll')}</Text>
          </TouchableOpacity>
        </View>
        {tasks.isLoading ? (
          <>
            <View style={styles.rowSkeleton} />
            <View style={styles.rowSkeleton} />
          </>
        ) : tasks.error ? (
          <SectionError message={tasks.error} onRetry={() => { void fetchTasks(true); }} retryLabel={t('common.retry')} />
        ) : tasks.data && tasks.data.length > 0 ? (
          tasks.data.map((task) => (
            <TouchableOpacity
              key={task.id}
              style={styles.listCard}
              onPress={() => { router.push({ pathname: '/task/[id]', params: { id: task.id } }); }}
              accessibilityRole="button"
            >
              <View style={[styles.statusDot, { backgroundColor: task.status === 'done' ? TEAL : task.status === 'in_progress' ? '#f59e0b' : '#d1d5db' }]} />
              <View style={styles.listCardContent}>
                <Text style={styles.listCardTitle} numberOfLines={1}>{task.title}</Text>
                <Text style={styles.listCardSub}>{formatDueDate(task.due_date) || t('tasks.today')}</Text>
              </View>
              <ChevronRight size={16} color="#9ca3af" />
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.emptyText}>{t('tasks.noToday')}</Text>
        )}
      </View>

      {/* Recent contacts */}
      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionHeader}>{t('dashboard.recentContacts')}</Text>
          <TouchableOpacity onPress={() => { router.push('/(tabs)/contacts'); }} accessibilityRole="button">
            <Text style={styles.viewAllText}>{t('dashboard.viewAll')}</Text>
          </TouchableOpacity>
        </View>
        {contacts.isLoading ? (
          <>
            <View style={styles.rowSkeleton} />
            <View style={styles.rowSkeleton} />
          </>
        ) : contacts.error ? (
          <SectionError message={contacts.error} onRetry={() => { void fetchContacts(true); }} retryLabel={t('common.retry')} />
        ) : contacts.data && contacts.data.length > 0 ? (
          contacts.data.map((contact) => (
            <TouchableOpacity
              key={contact.id}
              style={styles.listCard}
              onPress={() => { router.push({ pathname: '/contact/[id]', params: { id: contact.id } }); }}
              accessibilityRole="button"
            >
              <View style={styles.contactAvatar}>
                <Text style={styles.contactAvatarText}>{getInitials(contactName(contact))}</Text>
              </View>
              <View style={styles.listCardContent}>
                <Text style={styles.listCardTitle} numberOfLines={1}>{contactName(contact)}</Text>
                <Text style={styles.listCardSub} numberOfLines={1}>{contact.company ?? contact.email ?? ''}</Text>
              </View>
              <ChevronRight size={16} color="#9ca3af" />
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.emptyText}>{t('contacts.noContacts')}</Text>
        )}
      </View>

      {/* Workflows + captures */}
      {(workflowCount.data !== null || captureCount > 0) && (
        <View style={styles.section}>
          <View style={styles.quickActionsRow}>
            <TouchableOpacity
              style={[styles.outlineButton, { flex: 1 }]}
              onPress={() => { router.push('/workflows' as never); }}
              accessibilityRole="button"
            >
              <Zap size={16} color={TEAL} />
              <Text style={styles.outlineButtonText}>
                {`${workflowCount.data ?? 0} ${t('dashboard.workflows')}`}
              </Text>
            </TouchableOpacity>
            {captureCount > 0 && (
              <TouchableOpacity
                style={[styles.outlineButton, { flex: 1, borderColor: '#f59e0b' }]}
                onPress={() => { router.push('/captures' as never); }}
                accessibilityRole="button"
              >
                <Text style={[styles.outlineButtonText, { color: '#f59e0b' }]}>
                  {`${captureCount} ${t('dashboard.pendingCaptures')}`}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  contentContainer: {
    paddingBottom: 40,
  },
  circle1: {
    position: 'absolute',
    width: 350,
    height: 350,
    borderRadius: 175,
    backgroundColor: 'rgba(6,95,70,0.04)',
    top: -80,
    right: -100,
  },
  circle2: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: 'rgba(6,95,70,0.03)',
    bottom: 100,
    left: -80,
  },
  circle3: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(6,95,70,0.03)',
    top: '40%',
    right: -60,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  headerLeft: {
    flex: 1,
  },
  greetingText: {
    fontSize: 26,
    fontWeight: '700',
    color: '#111827',
  },
  greetingSub: {
    fontSize: 14,
    color: '#6b7280',
    marginTop: 2,
  },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#065f46',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 12,
  },
  avatarInitials: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    marginTop: 16,
    marginBottom: 4,
  },
  fullWidth: {
    width: '100%',
  },
  metricCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  metricSkeleton: {
    flex: 1,
    height: 110,
    backgroundColor: '#e5e7eb',
    borderRadius: 16,
  },
  metricIconBox: {
    width: 36,
    height: 36,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  metricNumber: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
  },
  metricLabel: {
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '600',
    marginTop: 2,
  },
  metricSub: {
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 2,
  },
  section: {
    marginHorizontal: 16,
    marginTop: 24,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  viewAllText: {
    fontSize: 13,
    color: '#065f46',
    fontWeight: '500',
  },
  quickActionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  quickAction: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#065f46',
    paddingVertical: 14,
    alignItems: 'center',
    gap: 6,
  },
  quickActionIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: 'rgba(6,95,70,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickActionLabel: {
    fontSize: 11,
    color: '#065f46',
    fontWeight: '600',
    textAlign: 'center',
  },
  listCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
    gap: 12,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  listCardContent: {
    flex: 1,
  },
  listCardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  listCardSub: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 2,
  },
  contactAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(6,95,70,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  contactAvatarText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#065f46',
  },
  emptyText: {
    color: '#9ca3af',
    fontSize: 14,
    paddingVertical: 8,
  },
  rowSkeleton: {
    height: 60,
    backgroundColor: '#e5e7eb',
    borderRadius: 12,
    marginBottom: 8,
  },
  outlineButton: {
    borderWidth: 1.5,
    borderColor: '#065f46',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  outlineButtonText: {
    color: '#065f46',
    fontSize: 13,
    fontWeight: '600',
  },
  inlineError: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  inlineErrorText: {
    flex: 1,
    color: '#ef4444',
    fontSize: 13,
  },
  inlineRetryButton: {
    backgroundColor: '#065f46',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    minHeight: 36,
    justifyContent: 'center',
  },
  inlineRetryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
});
