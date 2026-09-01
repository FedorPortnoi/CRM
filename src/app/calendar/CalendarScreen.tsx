import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
import { StyleSheet } from 'react-native';
import { Stack, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Calendar as CalendarIcon } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { formatMarketDate, formatMarketTime } from '../../market/profile';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, type } from '../../theme';
import { Screen, Card, Button, Badge, EmptyState, Skeleton, SkeletonText } from '../../components/ui';
import type { BadgeVariant } from '../../components/ui';

type CalendarEventStatus = 'scheduled' | 'completed' | 'cancelled';

type CalendarContact = {
  id: string;
  first_name: string;
  last_name: string | null;
};

type CalendarDeal = {
  id: string;
  title: string;
};

type CalendarEvent = {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  location: string | null;
  status: CalendarEventStatus;
  notes: string | null;
  contact: CalendarContact | null;
  deal: CalendarDeal | null;
};

type CalendarResponse = {
  data: CalendarEvent[];
};

type CalendarSyncStatus = {
  connected: boolean;
  yandex_username: string | null;
  yandex_calendar_slug: string | null;
  expires_at: string | null;
};

type CalendarSyncStatusResponse = {
  data: CalendarSyncStatus;
};

type YandexAuthResponse = {
  data: {
    auth_url: string;
  };
};

type AgendaSection = {
  dateKey: string;
  label: string;
  events: CalendarEvent[];
};

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function startOfToday(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function localDateKey(dateString: string): string {
  const date = new Date(dateString);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDayLabel(dateKey: string): string {
  const date = new Date(dateKey + 'T00:00:00');
  return formatMarketDate(date, {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
  });
}

function formatTime(dateString: string): string {
  return formatMarketTime(dateString, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatTimeRange(event: CalendarEvent): string {
  return `${formatTime(event.start_time)} - ${formatTime(event.end_time)}`;
}

function contactName(contact: CalendarContact): string {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ');
}

function statusBadgeVariant(status: CalendarEventStatus): BadgeVariant {
  if (status === 'completed') return 'success';
  if (status === 'cancelled') return 'neutral';
  return 'accent';
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string }; message?: string };
    return body.error?.message ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

function buildSections(events: CalendarEvent[]): AgendaSection[] {
  const sectionsByDate = new Map<string, CalendarEvent[]>();
  events.forEach((event) => {
    const key = localDateKey(event.start_time);
    const existing = sectionsByDate.get(key) ?? [];
    existing.push(event);
    sectionsByDate.set(key, existing);
  });

  return Array.from(sectionsByDate.entries()).map(([dateKey, sectionEvents]) => ({
    dateKey,
    label: formatDayLabel(dateKey),
    events: sectionEvents,
  }));
}

function AgendaSkeleton(): JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  return (
    <View style={styles.loadingWrap}>
      {Array.from({ length: 4 }).map((_, index) => (
        <View key={index} style={styles.eventRow}>
          <View style={styles.timeColumn}>
            <Skeleton width={36} height={14} />
          </View>
          <Card style={styles.eventCard}>
            <SkeletonText lines={2} lastLineWidth="70%" />
          </Card>
        </View>
      ))}
    </View>
  );
}

export default function CalendarAgendaScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<CalendarSyncStatus | null>(null);
  const [isSyncLoading, setIsSyncLoading] = useState<boolean>(true);
  const [syncAction, setSyncAction] = useState<'connect' | 'disconnect' | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const fetchSyncStatus = useCallback(async (): Promise<void> => {
    if (!token) return;
    setIsSyncLoading(true);
    setSyncError(null);

    try {
      const res = await fetch(`${API_URL}/calendar/sync/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        throw new Error(await readApiError(res, `Sync status failed with status ${res.status}`));
      }

      const body = (await res.json()) as CalendarSyncStatusResponse;
      setSyncStatus(body.data);
    } catch (e: unknown) {
      setSyncError(e instanceof Error ? e.message : t('errors.serverError'));
    } finally {
      setIsSyncLoading(false);
    }
  }, [token, t]);

  const { data: events = [], isLoading, error: eventsError, refetch } = useQuery({
    queryKey: ['calendar-events', token],
    queryFn: async () => {
      const start = startOfToday().toISOString();
      const end = addDays(startOfToday(), 90).toISOString();
      const res = await fetch(
        `${API_URL}/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&per_page=100`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `Calendar failed with status ${res.status}`);
      }
      const body = (await res.json()) as CalendarResponse;
      return body.data;
    },
    enabled: !!token,
  });

  const error = eventsError instanceof Error ? eventsError.message : eventsError ? t('errors.serverError') : null;

  useEffect(() => {
    void fetchSyncStatus();
  }, [fetchSyncStatus]);

  const sections = useMemo(() => buildSections(events), [events]);

  const handleRetry = useCallback((): void => {
    void refetch();
  }, [refetch]);

  const handleRefresh = useCallback((): void => {
    setIsRefreshing(true);
    void Promise.all([refetch(), fetchSyncStatus()]).finally(() => setIsRefreshing(false));
  }, [refetch, fetchSyncStatus]);

  const handleConnectYandex = async (): Promise<void> => {
    if (!token) return;
    setSyncAction('connect');
    setSyncError(null);
    setSyncMessage(null);

    try {
      const res = await fetch(`${API_URL}/calendar/sync/yandex/auth`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        throw new Error(await readApiError(res, `Yandex connection failed with status ${res.status}`));
      }

      const body = (await res.json()) as YandexAuthResponse;
      await Linking.openURL(body.data.auth_url);
      setSyncMessage(t('calendar.yandexAuthOpened'));
    } catch (e: unknown) {
      setSyncError(e instanceof Error ? e.message : t('errors.serverError'));
    } finally {
      setSyncAction(null);
    }
  };

  const handleDisconnectYandex = async (): Promise<void> => {
    if (!token) return;
    setSyncAction('disconnect');
    setSyncError(null);
    setSyncMessage(null);

    try {
      const res = await fetch(`${API_URL}/calendar/sync/yandex`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        throw new Error(await readApiError(res, `Yandex disconnect failed with status ${res.status}`));
      }

      setSyncStatus({
        connected: false,
        yandex_username: null,
        yandex_calendar_slug: null,
        expires_at: null,
      });
      setSyncMessage(t('calendar.yandexDisconnected'));
    } catch (e: unknown) {
      setSyncError(e instanceof Error ? e.message : t('errors.serverError'));
    } finally {
      setSyncAction(null);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: t('calendar.title'),
          headerShown: true,
        }}
      />
      <Screen refreshing={isRefreshing} onRefresh={handleRefresh}>
        <View style={styles.pageHeader}>
          <View style={styles.rowMain}>
            <Text style={styles.pageTitle}>{t('calendar.agenda')}</Text>
            <Text style={styles.pageSubtitle}>{t('calendar.next90Days')}</Text>
          </View>
          <Button
            title={t('calendar.newEvent')}
            size="sm"
            onPress={() => router.push('/calendar/new')}
          />
        </View>

        <Card style={styles.syncCard}>
          <View style={styles.syncHeader}>
            <View style={styles.rowMain}>
              <Text style={styles.syncTitle}>{t('calendar.yandexCalendar')}</Text>
              <Text style={styles.syncSubtitle}>
                {syncStatus?.connected
                  ? syncStatus.yandex_username ? t('calendar.connectedAs', { name: syncStatus.yandex_username }) : t('calendar.connected')
                  : t('calendar.yandexConnectDesc')}
              </Text>
            </View>
            <Badge
              label={syncStatus?.connected ? t('calendar.connected') : t('calendar.off')}
              variant={syncStatus?.connected ? 'success' : 'neutral'}
            />
          </View>
          {isSyncLoading ? (
            <View style={styles.syncInline}>
              <ActivityIndicator color={colors.accent} size="small" />
              <Text style={styles.syncInlineText}>{t('calendar.checkingSync')}</Text>
            </View>
          ) : (
            <>
              {syncStatus?.connected && syncStatus.yandex_calendar_slug ? (
                <Text style={styles.syncMeta}>{t('calendar.calendarLabel', { name: syncStatus.yandex_calendar_slug })}</Text>
              ) : null}
              {syncMessage ? <Text style={styles.syncSuccess}>{syncMessage}</Text> : null}
              {syncError ? <Text style={styles.syncError}>{syncError}</Text> : null}
              <View style={styles.syncActions}>
                {syncStatus?.connected ? (
                  <Button
                    title={t('calendar.disconnect')}
                    variant="secondary"
                    size="sm"
                    style={styles.flexButton}
                    onPress={() => { void handleDisconnectYandex(); }}
                    loading={syncAction === 'disconnect'}
                    disabled={syncAction !== null}
                  />
                ) : (
                  <Button
                    title={t('calendar.connect')}
                    variant="primary"
                    size="sm"
                    style={styles.flexButton}
                    onPress={() => { void handleConnectYandex(); }}
                    loading={syncAction === 'connect'}
                    disabled={syncAction !== null}
                  />
                )}
                <Button
                  title={t('calendar.refresh')}
                  variant="ghost"
                  size="sm"
                  onPress={() => { void fetchSyncStatus(); }}
                  disabled={syncAction !== null}
                />
              </View>
            </>
          )}
        </Card>

        {isLoading ? (
          <AgendaSkeleton />
        ) : error ? (
          <EmptyState
            icon={<AlertCircle size={32} color={colors.danger} />}
            title={error}
            actionLabel={t('common.retry')}
            onAction={handleRetry}
          />
        ) : sections.length === 0 ? (
          <EmptyState
            icon={<CalendarIcon size={32} color={colors.textMuted} />}
            title={t('calendar.noUpcoming')}
            description={t('calendar.createPrompt')}
            actionLabel={t('calendar.createEvent')}
            onAction={() => router.push('/calendar/new')}
          />
        ) : (
          sections.map((section) => (
            <View key={section.dateKey} style={styles.section}>
              <Text style={styles.sectionTitle}>{section.label}</Text>
              {section.events.map((event) => (
                <View key={event.id} style={styles.eventRow}>
                  <View style={styles.timeColumn}>
                    <Text style={styles.timeText}>{formatTime(event.start_time)}</Text>
                    <View style={styles.timeLine} />
                  </View>
                  <Card
                    style={styles.eventCard}
                    onPress={() =>
                      router.push({
                        pathname: '/calendar/[id]',
                        params: { id: event.id },
                      })
                    }
                    accessibilityLabel={event.title}
                  >
                    <View style={styles.eventTitleRow}>
                      <Text style={styles.eventTitle} numberOfLines={2}>
                        {event.title}
                      </Text>
                      <Badge label={t(`calendar.${event.status}`)} variant={statusBadgeVariant(event.status)} />
                    </View>
                    <Text style={styles.eventMeta}>{formatTimeRange(event)}</Text>
                    {event.location ? (
                      <Text style={styles.eventSub} numberOfLines={1}>
                        {event.location}
                      </Text>
                    ) : null}
                    {event.contact ? (
                      <Text style={styles.eventSub} numberOfLines={1}>
                        {contactName(event.contact)}
                      </Text>
                    ) : null}
                    {event.status === 'completed' && !event.notes ? (
                      <Text style={styles.notesPrompt}>{t('calendar.notesNeeded')}</Text>
                    ) : null}
                  </Card>
                </View>
              ))}
            </View>
          ))
        )}
      </Screen>
    </>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  pageTitle: {
    ...type.title,
    color: c.text1,
  },
  pageSubtitle: {
    ...type.label,
    color: c.textMuted,
    marginTop: spacing.xs,
  },
  rowMain: {
    flex: 1,
  },
  flexButton: {
    flex: 1,
  },
  syncCard: {
    marginBottom: spacing.lg,
  },
  syncHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  syncTitle: {
    ...type.heading,
    color: c.text1,
  },
  syncSubtitle: {
    ...type.caption,
    color: c.textMuted,
    marginTop: spacing.xs,
  },
  syncInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  syncInlineText: {
    ...type.caption,
    color: c.textMuted,
  },
  syncMeta: {
    ...type.caption,
    color: c.textMuted,
    marginTop: spacing.sm,
  },
  syncSuccess: {
    ...type.caption,
    color: c.success,
    marginTop: spacing.sm,
  },
  syncError: {
    ...type.caption,
    color: c.danger,
    marginTop: spacing.sm,
  },
  syncActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  loadingWrap: {
    gap: spacing.sm,
  },
  section: {
    marginBottom: spacing.xl,
  },
  sectionTitle: {
    ...type.label,
    color: c.textMuted,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  eventRow: {
    flexDirection: 'row',
    marginBottom: spacing.sm,
  },
  timeColumn: {
    width: 58,
    alignItems: 'center',
    paddingTop: spacing.md,
  },
  timeText: {
    ...type.caption,
    color: c.textMuted,
    fontVariant: ['tabular-nums'],
  },
  timeLine: {
    width: 1,
    flex: 1,
    backgroundColor: c.border,
    marginTop: spacing.sm,
  },
  eventCard: {
    flex: 1,
    minHeight: 92,
  },
  eventTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  eventTitle: {
    flex: 1,
    ...type.heading,
    color: c.text1,
  },
  eventMeta: {
    ...type.caption,
    color: c.textMuted,
    marginTop: spacing.xs,
    fontVariant: ['tabular-nums'],
  },
  eventSub: {
    ...type.caption,
    color: c.textMuted,
    marginTop: spacing.xs,
  },
  notesPrompt: {
    color: c.danger,
    ...type.caption,
    marginTop: spacing.sm,
  },
});
