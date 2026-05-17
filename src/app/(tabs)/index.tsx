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
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { notifyPendingCaptureCount } from '../../utils/notifications';

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
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const [summary, setSummary] = useState<SectionState<DashboardData>>(initialSection<DashboardData>);
  const [tasks, setTasks] = useState<SectionState<TodayTask[]>>(initialSection<TodayTask[]>);
  const [contacts, setContacts] = useState<SectionState<RecentContact[]>>(initialSection<RecentContact[]>);
  const [captureCount, setCaptureCount] = useState<number>(0);
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
      ]);
    },
    [fetchSummary, fetchTasks, fetchContacts, fetchCaptureCount],
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

    return () => {
      clearInterval(interval);
    };
  }, [token, fetchCaptureCount]);

  const onRefresh = useCallback((): void => {
    setRefreshing(true);
    void fetchAll(false).finally(() => setRefreshing(false));
  }, [fetchAll]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.pageTitle}>{t('dashboard.title')}</Text>

      <View style={styles.summaryGrid}>
        {summary.isLoading ? (
          <>
            <View style={styles.summarySkeleton} />
            <View style={styles.summarySkeleton} />
            <View style={styles.summarySkeleton} />
          </>
        ) : summary.error ? (
          <View style={styles.fullWidth}>
            <SectionError message={summary.error} onRetry={() => { void fetchSummary(true); }} retryLabel={t('common.retry')} />
          </View>
        ) : summary.data ? (
          <>
            <View style={styles.summaryCard}>
              <Text style={styles.cardLabel}>{t('dashboard.openDeals')}</Text>
              <Text style={styles.cardValue}>{summary.data.open_deals.count}</Text>
              <Text style={styles.cardSub}>{formatCurrency(summary.data.open_deals.total_value)}</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.cardLabel}>{t('dashboard.dueToday')}</Text>
              <Text style={styles.cardValue}>{summary.data.tasks_due_today}</Text>
              <Text style={styles.cardSub}>{t('tabs.tasks')}</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.cardLabel}>{t('dashboard.pipelineHealth')}</Text>
              <Text style={styles.cardValue}>{formatPipelineHealth(summary.data.pipeline_health_score)}</Text>
              <Text style={styles.cardSub}>{t('dashboard.score')}</Text>
            </View>
          </>
        ) : null}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t('calendar.title')}</Text>
        </View>
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => router.push('/calendar')}
            accessibilityRole="button"
          >
            <Text style={styles.actionButtonText}>{t('calendar.agenda')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonSecondary]}
            onPress={() => router.push('/calendar/new')}
            accessibilityRole="button"
          >
            <Text style={styles.actionButtonSecondaryText}>{t('calendar.newEvent')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonSecondary]}
            onPress={() => router.push('/workflows' as never)}
            accessibilityRole="button"
          >
            <Text style={styles.actionButtonSecondaryText}>{t('dashboard.workflows')}</Text>
          </TouchableOpacity>
          {captureCount > 0 ? (
            <TouchableOpacity
              style={[styles.actionButton, styles.actionButtonAlert]}
              onPress={() => router.push('/captures' as never)}
              accessibilityRole="button"
            >
              <Text style={styles.actionButtonText}>{captureCount} {t('dashboard.pendingCaptures')}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t('dashboard.todayTasks')}</Text>
        </View>
        {tasks.isLoading ? (
          <>
            <View style={styles.rowSkeleton} />
            <View style={styles.rowSkeleton} />
            <View style={styles.rowSkeleton} />
          </>
        ) : tasks.error ? (
          <SectionError message={tasks.error} onRetry={() => { void fetchTasks(true); }} retryLabel={t('common.retry')} />
        ) : tasks.data && tasks.data.length > 0 ? (
          tasks.data.map((task) => (
            <TouchableOpacity
              key={task.id}
              style={styles.row}
              onPress={() => router.push({ pathname: '/task/[id]', params: { id: task.id } })}
              accessibilityRole="button"
            >
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={1}>{task.title}</Text>
                <Text style={styles.rowSub}>{formatDueDate(task.due_date) || t('tasks.today')}</Text>
              </View>
              <Text style={styles.rowMeta}>{task.status.replace('_', ' ')}</Text>
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.emptyText}>{t('tasks.noToday')}</Text>
        )}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t('dashboard.recentContacts')}</Text>
        </View>
        {contacts.isLoading ? (
          <>
            <View style={styles.rowSkeleton} />
            <View style={styles.rowSkeleton} />
            <View style={styles.rowSkeleton} />
          </>
        ) : contacts.error ? (
          <SectionError message={contacts.error} onRetry={() => { void fetchContacts(true); }} retryLabel={t('common.retry')} />
        ) : contacts.data && contacts.data.length > 0 ? (
          contacts.data.map((contact) => (
            <TouchableOpacity
              key={contact.id}
              style={styles.row}
              onPress={() => router.push({ pathname: '/contact/[id]', params: { id: contact.id } })}
              accessibilityRole="button"
            >
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={1}>{contactName(contact)}</Text>
                {contact.company ? (
                  <Text style={styles.rowSub} numberOfLines={1}>{contact.company}</Text>
                ) : contact.email ? (
                  <Text style={styles.rowSub} numberOfLines={1}>{contact.email}</Text>
                ) : (
                  <Text style={styles.rowSub}>{t('contacts.company')}</Text>
                )}
              </View>
              {contact.phone ? <Text style={styles.rowMeta}>{contact.phone}</Text> : null}
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.emptyText}>{t('contacts.noContacts')}</Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  contentContainer: {
    paddingBottom: 24,
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1A1A1A',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 12,
    marginTop: 4,
  },
  fullWidth: {
    width: '100%',
  },
  summaryCard: {
    flex: 1,
    minWidth: 105,
    backgroundColor: '#FFFFFF',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ECECEC',
    minHeight: 104,
  },
  cardLabel: {
    fontSize: 12,
    color: '#6B6B6B',
    fontWeight: '600',
    marginBottom: 6,
  },
  cardValue: {
    fontSize: 26,
    fontWeight: '700',
    color: '#1A1A1A',
  },
  cardSub: {
    fontSize: 12,
    color: '#6B6B6B',
    marginTop: 4,
  },
  section: {
    marginHorizontal: 12,
    marginTop: 20,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  row: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#ECECEC',
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
  },
  rowMain: {
    flex: 1,
    paddingRight: 12,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  rowSub: {
    fontSize: 12,
    color: '#6B6B6B',
    marginTop: 3,
  },
  rowMeta: {
    fontSize: 12,
    color: '#6B6B6B',
    maxWidth: 120,
  },
  emptyText: {
    color: '#9B9B9B',
    fontSize: 14,
    paddingVertical: 12,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  actionButton: {
    flex: 1,
    minWidth: 120,
    backgroundColor: '#1A73E8',
    borderRadius: 8,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  actionButtonSecondary: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#1A73E8',
  },
  actionButtonAlert: {
    backgroundColor: '#E37400',
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  actionButtonSecondaryText: {
    color: '#1A73E8',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  inlineError: {
    backgroundColor: '#FFF4F2',
    borderWidth: 1,
    borderColor: '#F5C3BD',
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  inlineErrorText: {
    flex: 1,
    color: '#D93025',
    fontSize: 13,
  },
  inlineRetryButton: {
    backgroundColor: '#1A73E8',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    minHeight: 36,
    justifyContent: 'center',
  },
  inlineRetryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  summarySkeleton: {
    flex: 1,
    minWidth: 105,
    height: 104,
    backgroundColor: '#E8E8E8',
    borderRadius: 8,
  },
  rowSkeleton: {
    height: 64,
    backgroundColor: '#E8E8E8',
    borderRadius: 8,
    marginBottom: 8,
  },
});
