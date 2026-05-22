import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

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
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function formatTime(dateString: string): string {
  return new Date(dateString).toLocaleTimeString('en-US', {
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

function statusColor(status: CalendarEventStatus): string {
  if (status === 'completed') return '#065f46';
  if (status === 'cancelled') return '#9ca3af';
  return '#6366f1';
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

function SkeletonRows(): JSX.Element {
  return (
    <View style={styles.loadingWrap}>
      {Array.from({ length: 6 }).map((_, index) => (
        <View key={index} style={styles.skeletonRow} />
      ))}
    </View>
  );
}

interface ErrorStateProps {
  message: string;
  onRetry: () => void;
  retryLabel: string;
}

function ErrorState({ message, onRetry, retryLabel }: ErrorStateProps): JSX.Element {
  return (
    <View style={styles.centerState}>
      <Text style={styles.errorText}>{message}</Text>
      <TouchableOpacity style={styles.retryButton} onPress={onRetry}>
        <Text style={styles.retryText}>{retryLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function CalendarAgendaScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
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

  const fetchEvents = useCallback(
    async (refreshing: boolean): Promise<void> => {
      if (!token) return;
      if (refreshing) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      try {
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
        setEvents(body.data);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : t('errors.serverError'));
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [token, t],
  );

  useEffect(() => {
    void fetchEvents(false);
  }, [fetchEvents]);

  useEffect(() => {
    void fetchSyncStatus();
  }, [fetchSyncStatus]);

  const sections = useMemo(() => buildSections(events), [events]);

  const handleRetry = useCallback((): void => {
    void fetchEvents(false);
  }, [fetchEvents]);

  const handleRefresh = useCallback((): void => {
    void fetchEvents(true);
    void fetchSyncStatus();
  }, [fetchEvents, fetchSyncStatus]);

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
      setSyncMessage('Yandex authorization opened. Refresh status after completing sign-in.');
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
      setSyncMessage('Yandex Calendar disconnected.');
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
          headerRight: (): JSX.Element => (
            <TouchableOpacity
              onPress={() => router.push('/calendar/new')}
              style={styles.headerButton}
              accessibilityRole="button"
              accessibilityLabel={t('calendar.newEvent')}
            >
              <Plus size={24} color="#065f46" />
            </TouchableOpacity>
          ),
        }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            colors={['#065f46']}
            tintColor="#065f46"
          />
        }
      >
        <View style={styles.pageHeader}>
          <View>
            <Text style={styles.pageTitle}>{t('calendar.agenda')}</Text>
            <Text style={styles.pageSubtitle}>{t('calendar.next90Days')}</Text>
          </View>
          <TouchableOpacity
            style={styles.newButton}
            onPress={() => router.push('/calendar/new')}
            accessibilityRole="button"
          >
            <Text style={styles.newButtonText}>{t('calendar.newEvent')}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.syncCard}>
          <View style={styles.syncHeader}>
            <View style={styles.rowMain}>
              <Text style={styles.syncTitle}>Yandex Calendar</Text>
              <Text style={styles.syncSubtitle}>
                {syncStatus?.connected
                  ? `Connected${syncStatus.yandex_username ? ` as ${syncStatus.yandex_username}` : ''}`
                  : 'Connect Yandex to sync new and updated CRM events.'}
              </Text>
            </View>
            <View
              style={[
                styles.syncBadge,
                syncStatus?.connected ? styles.syncBadgeConnected : styles.syncBadgeDisconnected,
              ]}
            >
              <Text
                style={[
                  styles.syncBadgeText,
                  syncStatus?.connected
                    ? styles.syncBadgeTextConnected
                    : styles.syncBadgeTextDisconnected,
                ]}
              >
                {syncStatus?.connected ? 'Connected' : 'Off'}
              </Text>
            </View>
          </View>
          {isSyncLoading ? (
            <View style={styles.syncInline}>
              <ActivityIndicator color="#065f46" size="small" />
              <Text style={styles.syncInlineText}>Checking sync...</Text>
            </View>
          ) : (
            <>
              {syncStatus?.connected && syncStatus.yandex_calendar_slug ? (
                <Text style={styles.syncMeta}>Calendar: {syncStatus.yandex_calendar_slug}</Text>
              ) : null}
              {syncMessage ? <Text style={styles.syncSuccess}>{syncMessage}</Text> : null}
              {syncError ? <Text style={styles.syncError}>{syncError}</Text> : null}
              <View style={styles.syncActions}>
                {syncStatus?.connected ? (
                  <TouchableOpacity
                    style={[styles.syncSecondaryButton, syncAction !== null && styles.syncButtonDisabled]}
                    onPress={() => { void handleDisconnectYandex(); }}
                    disabled={syncAction !== null}
                    accessibilityRole="button"
                  >
                    {syncAction === 'disconnect' ? (
                      <ActivityIndicator color="#065f46" size="small" />
                    ) : (
                      <Text style={styles.syncSecondaryText}>Disconnect</Text>
                    )}
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[styles.syncPrimaryButton, syncAction !== null && styles.syncButtonDisabled]}
                    onPress={() => { void handleConnectYandex(); }}
                    disabled={syncAction !== null}
                    accessibilityRole="button"
                  >
                    {syncAction === 'connect' ? (
                      <ActivityIndicator color="#FFFFFF" size="small" />
                    ) : (
                      <Text style={styles.syncPrimaryText}>Connect</Text>
                    )}
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={styles.syncGhostButton}
                  onPress={() => { void fetchSyncStatus(); }}
                  accessibilityRole="button"
                >
                  <Text style={styles.syncGhostText}>Refresh</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>

        {isLoading ? (
          <SkeletonRows />
        ) : error ? (
          <ErrorState message={error} onRetry={handleRetry} retryLabel={t('common.retry')} />
        ) : sections.length === 0 ? (
          <View style={styles.centerState}>
            <Text style={styles.emptyTitle}>{t('calendar.noUpcoming')}</Text>
            <Text style={styles.emptyText}>{t('calendar.createPrompt')}</Text>
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => router.push('/calendar/new')}
              accessibilityRole="button"
            >
              <Text style={styles.emptyButtonText}>{t('calendar.createEvent')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          sections.map((section) => (
            <View key={section.dateKey} style={styles.section}>
              <Text style={styles.sectionTitle}>{section.label}</Text>
              {section.events.map((event) => (
                <TouchableOpacity
                  key={event.id}
                  style={styles.eventRow}
                  onPress={() =>
                    router.push({
                      pathname: '/calendar/[id]',
                      params: { id: event.id },
                    })
                  }
                  accessibilityRole="button"
                >
                  <View style={styles.timeColumn}>
                    <Text style={styles.timeText}>{formatTime(event.start_time)}</Text>
                    <View style={styles.timeLine} />
                  </View>
                  <View style={styles.eventBody}>
                    <View style={styles.eventTitleRow}>
                      <Text style={styles.eventTitle} numberOfLines={2}>
                        {event.title}
                      </Text>
                      <View
                        style={[styles.statusBadge, { backgroundColor: statusColor(event.status) }]}
                      >
                        <Text style={styles.statusText}>{event.status.replace('_', ' ')}</Text>
                      </View>
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
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          ))
        )}

        {isRefreshing ? (
          <View style={styles.refreshIndicator}>
            <ActivityIndicator color="#065f46" />
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  headerButton: {
    marginRight: 16,
    padding: 4,
  },
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
  },
  pageSubtitle: {
    fontSize: 13,
    color: '#6b7280',
    marginTop: 2,
  },
  newButton: {
    backgroundColor: '#065f46',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 40,
    justifyContent: 'center',
  },
  newButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  rowMain: {
    flex: 1,
  },
  syncCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 14,
    marginBottom: 18,
  },
  syncHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  syncTitle: {
    fontSize: 15,
    color: '#111827',
    fontWeight: '700',
  },
  syncSubtitle: {
    fontSize: 12,
    color: '#6b7280',
    lineHeight: 17,
    marginTop: 3,
  },
  syncBadge: {
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  syncBadgeConnected: {
    backgroundColor: '#f0fdf4',
  },
  syncBadgeDisconnected: {
    backgroundColor: '#f3f4f6',
  },
  syncBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  syncBadgeTextConnected: {
    color: '#065f46',
  },
  syncBadgeTextDisconnected: {
    color: '#6b7280',
  },
  syncInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  syncInlineText: {
    color: '#6b7280',
    fontSize: 12,
  },
  syncMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 10,
  },
  syncSuccess: {
    fontSize: 12,
    color: '#065f46',
    marginTop: 10,
  },
  syncError: {
    fontSize: 12,
    color: '#ef4444',
    marginTop: 10,
  },
  syncActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  syncPrimaryButton: {
    flex: 1,
    backgroundColor: '#065f46',
    borderRadius: 10,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncPrimaryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  syncSecondaryButton: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#065f46',
  },
  syncSecondaryText: {
    color: '#065f46',
    fontSize: 13,
    fontWeight: '700',
  },
  syncGhostButton: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  syncGhostText: {
    color: '#065f46',
    fontSize: 13,
    fontWeight: '700',
  },
  syncButtonDisabled: {
    opacity: 0.65,
  },
  loadingWrap: {
    gap: 10,
  },
  skeletonRow: {
    height: 88,
    borderRadius: 12,
    backgroundColor: '#f3f4f6',
  },
  centerState: {
    minHeight: 360,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
  },
  emptyButton: {
    backgroundColor: '#065f46',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: 18,
    minHeight: 44,
    justifyContent: 'center',
  },
  emptyButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 14,
  },
  retryButton: {
    backgroundColor: '#065f46',
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  section: {
    marginBottom: 22,
  },
  sectionTitle: {
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  eventRow: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  timeColumn: {
    width: 58,
    alignItems: 'center',
    paddingTop: 14,
  },
  timeText: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '600',
  },
  timeLine: {
    width: 1,
    flex: 1,
    backgroundColor: '#f3f4f6',
    marginTop: 8,
  },
  eventBody: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 12,
    minHeight: 92,
  },
  eventTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  eventTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    lineHeight: 20,
  },
  eventMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
  },
  eventSub: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
  },
  statusBadge: {
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  statusText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  notesPrompt: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 8,
  },
  refreshIndicator: {
    paddingTop: 8,
  },
});
