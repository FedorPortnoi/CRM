import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
  if (status === 'completed') return '#34A853';
  if (status === 'cancelled') return '#9B9B9B';
  return '#1A73E8';
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

  const sections = useMemo(() => buildSections(events), [events]);

  const handleRetry = useCallback((): void => {
    void fetchEvents(false);
  }, [fetchEvents]);

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
              <Plus size={24} color="#007AFF" />
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
            onRefresh={() => {
              void fetchEvents(true);
            }}
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
            <ActivityIndicator color="#1A73E8" />
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
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
    color: '#1A1A1A',
  },
  pageSubtitle: {
    fontSize: 13,
    color: '#6B6B6B',
    marginTop: 2,
  },
  newButton: {
    backgroundColor: '#1A73E8',
    borderRadius: 8,
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
  loadingWrap: {
    gap: 10,
  },
  skeletonRow: {
    height: 88,
    borderRadius: 8,
    backgroundColor: '#E8E8E8',
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
    color: '#1A1A1A',
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 14,
    color: '#6B6B6B',
    textAlign: 'center',
  },
  emptyButton: {
    backgroundColor: '#1A73E8',
    borderRadius: 8,
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
    color: '#D93025',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 14,
  },
  retryButton: {
    backgroundColor: '#1A73E8',
    borderRadius: 8,
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
    color: '#6B6B6B',
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
    color: '#6B6B6B',
    fontWeight: '600',
  },
  timeLine: {
    width: 1,
    flex: 1,
    backgroundColor: '#DADCE0',
    marginTop: 8,
  },
  eventBody: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ECECEC',
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
    color: '#1A1A1A',
    lineHeight: 20,
  },
  eventMeta: {
    fontSize: 12,
    color: '#6B6B6B',
    marginTop: 4,
  },
  eventSub: {
    fontSize: 12,
    color: '#6B6B6B',
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
    color: '#D93025',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 8,
  },
  refreshIndicator: {
    paddingTop: 8,
  },
});
