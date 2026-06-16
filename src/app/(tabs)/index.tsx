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
import { TrendingUp, CheckSquare, AlertCircle, AlertTriangle, MessageCircle, Calendar, Zap, UserPlus, PlusCircle, ListChecks, ChevronRight } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { notifyPendingCaptureCount } from '../../utils/notifications';
import { formatMarketDate, formatMarketNumber, formatMoney, formatMarketTime } from '../../market/profile';

const TEAL = '#C45A10';
const CAPTURE_COUNT_POLL_INTERVAL_MS = 60000;

type TodayEvent = {
  id: string;
  title: string;
  start_time: string;
  contact: { first_name: string; last_name: string | null } | null;
};

type DashboardData = {
  open_deals: { count: number; total_value: number };
  tasks_due_today: number;
  overdue_tasks_count: number;
  deals_without_tasks_count: number;
  todays_events: TodayEvent[];
  stale_contacts: StaleContact[];
  stale_contacts_count: number;
  recent_activity: Array<{ type: string; id: string; summary: string; created_at: string }>;
  pipeline_health_score: number;
};

type TodayTask = {
  id: string;
  title: string;
  due_date: string | null;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
};

type StaleContact = {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  updated_at: string;
};

type ClosingDeal = {
  id: string;
  title: string;
  expected_close: string | null;
  value: number | null;
  currency: string | null;
  contact: { first_name: string; last_name: string | null } | null;
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
  return formatMoney(value, undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPipelineHealth(score: number): string {
  const percent = score <= 1 ? score * 100 : score;
  return formatMarketNumber(percent, { maximumFractionDigits: 1 }) + '%';
}

function formatDueDate(date: string | null): string {
  if (!date) return '';
  return formatMarketDate(date, { month: 'short', day: 'numeric' });
}

function contactName(contact: StaleContact): string {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ');
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
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
  const [closingDeals, setClosingDeals] = useState<SectionState<ClosingDeal[]>>(initialSection<ClosingDeal[]>);
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
          error: errorMessage(e, t('errors.failedToLoadDashboard')),
        }));
      }
    },
    [token, t],
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
          error: errorMessage(e, t('errors.failedToLoadTasks')),
        }));
      }
    },
    [token, t],
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
        error: errorMessage(e, t('errors.failedToLoadWorkflows')),
      }));
    }
  }, [token, t]);

  const fetchClosingDeals = useCallback(async (showSkeleton: boolean): Promise<void> => {
    if (!token) return;
    if (showSkeleton) setClosingDeals((prev) => ({ ...prev, isLoading: true }));
    try {
      setClosingDeals((prev) => ({ ...prev, error: null }));
      const dealsRes = await fetch(`${API_URL}/deals?status=open&sort=expected_close&order=asc&per_page=50`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!dealsRes.ok) throw new Error(`Deals failed with status ${dealsRes.status}`);
      const dealsJson = await dealsRes.json() as { data: ClosingDeal[] };
      const now = Date.now();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const closing = dealsJson.data.filter(d => {
        if (!d.expected_close) return false;
        const diff = new Date(d.expected_close).getTime() - now;
        return diff >= 0 && diff <= sevenDays;
      });
      setClosingDeals({ data: closing, isLoading: false, error: null });
    } catch (e: unknown) {
      setClosingDeals((prev) => ({
        data: prev.data,
        isLoading: false,
        error: errorMessage(e, t('errors.failedToLoadDashboard')),
      }));
    }
  }, [token, t]);

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
          nextCount,
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
        fetchClosingDeals(showSkeleton),
        fetchCaptureCount(),
        fetchWorkflowCount(showSkeleton),
      ]);
    },
    [fetchSummary, fetchTasks, fetchClosingDeals, fetchCaptureCount, fetchWorkflowCount],
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
              <View style={[styles.metricIconBox, { backgroundColor: summary.data.overdue_tasks_count > 0 ? 'rgba(220,38,38,0.1)' : 'rgba(6,95,70,0.08)' }]}>
                <AlertCircle size={18} color={summary.data.overdue_tasks_count > 0 ? '#dc2626' : TEAL} />
              </View>
              <Text style={[styles.metricNumber, summary.data.overdue_tasks_count > 0 && { color: '#dc2626' }]}>
                {summary.data.overdue_tasks_count}
              </Text>
              <Text style={styles.metricLabel}>{t('dashboard.overdueTasks')}</Text>
              <Text style={styles.metricSub}>{t('tabs.tasks')}</Text>
            </View>
          </>
        ) : null}
      </View>

      {/* Pending captures banner */}
      {captureCount > 0 && (
        <TouchableOpacity
          style={styles.captureBanner}
          onPress={() => { router.push('/captures' as never); }}
          accessibilityRole="button"
        >
          <View style={styles.captureBannerIcon}>
            <MessageCircle size={18} color="#ea580c" />
          </View>
          <View style={styles.alertBannerContent}>
            <Text style={styles.captureBannerCount}>{captureCount}</Text>
            <Text style={styles.captureBannerLabel}>{t('dashboard.pendingCaptures')}</Text>
            <Text style={styles.captureBannerSub}>{t('dashboard.pendingCapturesBannerSub', { count: captureCount })}</Text>
          </View>
          <ChevronRight size={16} color="#ea580c" />
        </TouchableOpacity>
      )}

      {/* Deals without tasks banner */}
      {summary.data && summary.data.deals_without_tasks_count > 0 && (
        <TouchableOpacity
          style={styles.alertBanner}
          onPress={() => { router.push('/(tabs)/kanban'); }}
          accessibilityRole="button"
        >
          <View style={styles.alertBannerIcon}>
            <AlertTriangle size={18} color="#d97706" />
          </View>
          <View style={styles.alertBannerContent}>
            <Text style={styles.alertBannerCount}>{summary.data.deals_without_tasks_count}</Text>
            <Text style={styles.alertBannerLabel}>{t('dashboard.dealsWithoutTasks')}</Text>
            <Text style={styles.alertBannerSub}>{t('dashboard.dealsWithoutTasksSub')}</Text>
          </View>
          <ChevronRight size={16} color="#d97706" />
        </TouchableOpacity>
      )}

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
              <View style={[styles.statusDot, { backgroundColor: task.status === 'done' ? TEAL : task.status === 'in_progress' ? '#f59e0b' : '#E8DDD6' }]} />
              <View style={styles.listCardContent}>
                <Text style={styles.listCardTitle} numberOfLines={1}>{task.title}</Text>
                <Text style={styles.listCardSub}>{formatDueDate(task.due_date) || t('tasks.today')}</Text>
              </View>
              <ChevronRight size={16} color="#CFADA3" />
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.emptyText}>{t('tasks.noToday')}</Text>
        )}
      </View>

      {/* Today's schedule */}
      {summary.data && (summary.data.todays_events?.length ?? 0) > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionHeader}>{t('dashboard.todaysSchedule')}</Text>
            <TouchableOpacity onPress={() => { router.push('/(tabs)/calendar'); }} accessibilityRole="button">
              <Text style={styles.viewAllText}>{t('dashboard.viewAll')}</Text>
            </TouchableOpacity>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.closingScroll}>
            {(summary.data.todays_events ?? []).map((event) => {
              const contactName = event.contact
                ? [event.contact.first_name, event.contact.last_name].filter(Boolean).join(' ')
                : null;
              return (
                <TouchableOpacity
                  key={event.id}
                  style={styles.eventCard}
                  onPress={() => { router.push({ pathname: '/calendar/[id]', params: { id: event.id } }); }}
                  accessibilityRole="button"
                >
                  <View style={styles.eventTimeBadge}>
                    <Calendar size={12} color={TEAL} />
                    <Text style={styles.eventTime}>{formatMarketTime(event.start_time)}</Text>
                  </View>
                  <Text style={styles.eventTitle} numberOfLines={2}>{event.title}</Text>
                  {contactName ? (
                    <Text style={styles.eventContact} numberOfLines={1}>{contactName}</Text>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Closing this week */}
      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionHeader}>{t('dashboard.closingThisWeek')}</Text>
          <TouchableOpacity onPress={() => { router.push('/(tabs)/kanban'); }} accessibilityRole="button">
            <Text style={styles.viewAllText}>{t('dashboard.viewAll')}</Text>
          </TouchableOpacity>
        </View>
        {closingDeals.isLoading ? (
          <View style={styles.closingSkeleton} />
        ) : closingDeals.error ? (
          <SectionError message={closingDeals.error} onRetry={() => { void fetchClosingDeals(true); }} retryLabel={t('common.retry')} />
        ) : closingDeals.data && closingDeals.data.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.closingScroll}>
            {closingDeals.data.map((deal) => {
              const daysRemaining = Math.ceil((new Date(deal.expected_close ?? '').getTime() - Date.now()) / 86400000);
              const badgeColor = daysRemaining <= 2 ? '#dc2626' : daysRemaining <= 5 ? '#d97706' : TEAL;
              const contact = deal.contact
                ? [deal.contact.first_name, deal.contact.last_name].filter(Boolean).join(' ')
                : '';
              return (
                <TouchableOpacity
                  key={deal.id}
                  style={styles.closingCard}
                  onPress={() => { router.push({ pathname: '/deal/[id]', params: { id: deal.id } }); }}
                  accessibilityRole="button"
                >
                  <View style={[styles.closingBadge, { backgroundColor: badgeColor }]}>
                    <Text style={styles.closingBadgeText}>{daysRemaining}d</Text>
                  </View>
                  <Text style={styles.closingTitle} numberOfLines={2}>{deal.title}</Text>
                  <Text style={styles.closingContact} numberOfLines={1}>{contact}</Text>
                  {deal.value != null ? (
                    <Text style={styles.closingValue}>{formatCurrency(Number(deal.value))}</Text>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        ) : (
          <Text style={styles.emptyText}>{t('dashboard.noDealsClosingThisWeek')}</Text>
        )}
      </View>

      {/* Зависшие клиенты */}
      {summary.data && (summary.data.stale_contacts?.length ?? 0) > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionHeader}>{t('dashboard.staleContacts')}</Text>
            <TouchableOpacity onPress={() => { router.push('/(tabs)/contacts'); }} accessibilityRole="button">
              <Text style={styles.viewAllText}>{t('dashboard.viewAll')}</Text>
            </TouchableOpacity>
          </View>
          {(summary.data.stale_contacts ?? []).map((contact) => {
            const days = daysSince(contact.updated_at);
            const urgentColor = days >= 30 ? '#dc2626' : '#d97706';
            return (
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
                  <Text style={styles.listCardSub} numberOfLines={1}>{contact.company ?? ''}</Text>
                </View>
                <Text style={[styles.staleDaysLabel, { color: urgentColor }]}>
                  {t('dashboard.daysWithoutActivity', { count: days })}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Workflows */}
      {workflowCount.data !== null && (
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.outlineButton}
            onPress={() => { router.push('/workflows' as never); }}
            accessibilityRole="button"
          >
            <Zap size={16} color={TEAL} />
            <Text style={styles.outlineButtonText}>
              {`${workflowCount.data ?? 0} ${t('dashboard.workflows')}`}
            </Text>
          </TouchableOpacity>
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
    color: '#383432',
  },
  greetingSub: {
    fontSize: 14,
    color: '#B07868',
    marginTop: 2,
  },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#C45A10',
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
    backgroundColor: '#E8DDD6',
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
    color: '#383432',
  },
  metricLabel: {
    fontSize: 11,
    color: '#B07868',
    fontWeight: '600',
    marginTop: 2,
  },
  metricSub: {
    fontSize: 11,
    color: '#CFADA3',
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
    color: '#B07868',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  viewAllText: {
    fontSize: 13,
    color: '#C45A10',
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
    borderColor: '#C45A10',
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
    color: '#C45A10',
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
    color: '#383432',
  },
  listCardSub: {
    fontSize: 12,
    color: '#CFADA3',
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
    color: '#C45A10',
  },
  emptyText: {
    color: '#CFADA3',
    fontSize: 14,
    paddingVertical: 8,
  },
  rowSkeleton: {
    height: 60,
    backgroundColor: '#E8DDD6',
    borderRadius: 12,
    marginBottom: 8,
  },
  closingSkeleton: {
    height: 116,
    backgroundColor: '#E8DDD6',
    borderRadius: 12,
  },
  closingScroll: {
    gap: 10,
    paddingRight: 16,
  },
  closingCard: {
    width: 180,
    minHeight: 116,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#FEF0E8',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  closingBadge: {
    alignSelf: 'flex-start',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 8,
  },
  closingBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  closingTitle: {
    color: '#C45A10',
    fontSize: 14,
    fontWeight: '700',
  },
  closingContact: {
    color: '#B07868',
    fontSize: 12,
    marginTop: 4,
  },
  closingValue: {
    color: '#383432',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
  },
  outlineButton: {
    borderWidth: 1.5,
    borderColor: '#C45A10',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  outlineButtonText: {
    color: '#C45A10',
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
    backgroundColor: '#C45A10',
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
  staleDaysLabel: {
    fontSize: 11,
    fontWeight: '600',
    flexShrink: 0,
  },
  captureBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 16,
    backgroundColor: '#fff7ed',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#fed7aa',
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  captureBannerIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(234,88,12,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  captureBannerCount: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ea580c',
    lineHeight: 24,
  },
  captureBannerLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#7c2d12',
    marginTop: 1,
  },
  captureBannerSub: {
    fontSize: 11,
    color: '#9a3412',
    marginTop: 1,
  },
  alertBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 16,
    backgroundColor: '#fffbeb',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#fcd34d',
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  alertBannerIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(217,119,6,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  alertBannerContent: {
    flex: 1,
  },
  alertBannerCount: {
    fontSize: 20,
    fontWeight: '700',
    color: '#d97706',
    lineHeight: 24,
  },
  alertBannerLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#92400e',
    marginTop: 1,
  },
  alertBannerSub: {
    fontSize: 11,
    color: '#b45309',
    marginTop: 1,
  },
  eventCard: {
    width: 152,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#EDE8E5',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  eventTimeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 8,
  },
  eventTime: {
    fontSize: 12,
    fontWeight: '700',
    color: TEAL,
  },
  eventTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#383432',
    lineHeight: 19,
  },
  eventContact: {
    fontSize: 12,
    color: '#B07868',
    marginTop: 6,
  },
});
