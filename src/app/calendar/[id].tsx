import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { sendOrQueueMutation } from '../../utils/offlineMutation';

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
  completed_at: string | null;
  contact: CalendarContact | null;
  deal: CalendarDeal | null;
};

type ErrorResponse = {
  error?: { message?: string };
};

type ActionName = 'complete' | 'cancel' | 'notes';

function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatTime(dateString: string): string {
  return new Date(dateString).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusColor(status: CalendarEventStatus): string {
  if (status === 'completed') return '#34A853';
  if (status === 'cancelled') return '#9B9B9B';
  return '#1A73E8';
}

function contactName(contact: CalendarContact): string {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ');
}

interface SkeletonBoxProps {
  height: number;
  width?: number | '75%' | '100%';
  marginBottom?: number;
}

function SkeletonBox({ height, width = '100%', marginBottom = 0 }: SkeletonBoxProps): JSX.Element {
  return (
    <View
      style={{
        height,
        width,
        marginBottom,
        borderRadius: 8,
        backgroundColor: '#E8E8E8',
      }}
    />
  );
}

export default function CalendarEventDetailScreen(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<ActionName | null>(null);
  const [postMeetingNotes, setPostMeetingNotes] = useState<string>('');
  const [notesFieldError, setNotesFieldError] = useState<string | null>(null);

  const fetchEvent = useCallback(
    async (refreshing: boolean): Promise<void> => {
      if (!token) return;
      if (refreshing) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setFetchError(null);

      try {
        const res = await fetch(`${API_URL}/calendar/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          const body = (await res.json()) as ErrorResponse;
          throw new Error(body.error?.message ?? `Calendar event failed with status ${res.status}`);
        }

        const body = (await res.json()) as { data: CalendarEvent };
        setEvent(body.data);
        setPostMeetingNotes(body.data.notes ?? '');
      } catch (e: unknown) {
        setFetchError(e instanceof Error ? e.message : 'Failed to load event');
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [id, token],
  );

  useEffect(() => {
    void fetchEvent(false);
  }, [fetchEvent]);

  async function runAction(
    action: ActionName,
    request: () => Promise<{ queued: true } | { queued: false; response: Response }>,
    onSuccess: (updated: CalendarEvent) => void,
  ): Promise<void> {
    if (activeAction) return;
    setActiveAction(action);
    setActionError(null);

    try {
      const result = await request();
      if (result.queued) {
        router.back();
        return;
      }

      const res = result.response;
      if (!res.ok) {
        const body = (await res.json()) as ErrorResponse;
        throw new Error(body.error?.message ?? `Action failed with status ${res.status}`);
      }

      const body = (await res.json()) as { data: CalendarEvent };
      onSuccess(body.data);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Action failed. Please try again.');
    } finally {
      setActiveAction(null);
    }
  }

  async function handleToggleComplete(): Promise<void> {
    await runAction(
      'complete',
      () =>
        sendOrQueueMutation({
          url: `${API_URL}/calendar/${id}/complete`,
          method: 'POST',
          token: token ?? '',
        }),
      (updated) => {
        setEvent(updated);
        setPostMeetingNotes(updated.notes ?? '');
      },
    );
  }

  async function handleCancel(): Promise<void> {
    await runAction(
      'cancel',
      () =>
        sendOrQueueMutation({
          url: `${API_URL}/calendar/${id}`,
          method: 'DELETE',
          token: token ?? '',
        }),
      (updated) => {
        setEvent(updated);
      },
    );
  }

  async function handleSaveNotes(): Promise<void> {
    if (postMeetingNotes.trim() === '') {
      setNotesFieldError('Notes are required');
      return;
    }
    setNotesFieldError(null);

    await runAction(
      'notes',
      () =>
        sendOrQueueMutation({
          url: `${API_URL}/calendar/${id}/notes`,
          method: 'POST',
          token: token ?? '',
          body: { notes: postMeetingNotes.trim() },
        }),
      (updated) => {
        setEvent(updated);
        setPostMeetingNotes(updated.notes ?? '');
      },
    );
  }

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Event', headerShown: true }} />
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
          <View style={styles.card}>
            <SkeletonBox height={24} width={240} marginBottom={12} />
            <SkeletonBox height={14} width={180} marginBottom={10} />
            <SkeletonBox height={22} width={92} />
          </View>
          <View style={styles.card}>
            <SkeletonBox height={16} marginBottom={12} />
            <SkeletonBox height={16} width="75%" />
          </View>
          <View style={styles.card}>
            <SkeletonBox height={80} />
          </View>
        </ScrollView>
      </>
    );
  }

  if (fetchError) {
    return (
      <>
        <Stack.Screen options={{ title: 'Event', headerShown: true }} />
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{fetchError}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => {
              void fetchEvent(false);
            }}
          >
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  }

  if (!event) return <></>;

  const isCompleted = event.status === 'completed';
  const isCancelled = event.status === 'cancelled';
  const completeLabel = isCompleted ? 'Mark Scheduled' : 'Mark Complete';
  const isActionDisabled = activeAction !== null;

  return (
    <>
      <Stack.Screen
        options={{
          title: event.title,
          headerShown: true,
          headerBackTitle: 'Calendar',
          headerRight: () => (
            <TouchableOpacity
              style={styles.headerEditButton}
              onPress={() => router.push({ pathname: '/calendar/edit/[id]', params: { id } })}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              <Text style={styles.headerEditText}>Edit</Text>
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
              void fetchEvent(true);
            }}
          />
        }
      >
        <View style={styles.card}>
          <Text style={styles.title}>{event.title}</Text>
          <Text style={styles.timeRange}>
            {formatDateTime(event.start_time)} - {formatTime(event.end_time)}
          </Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor(event.status) }]}>
            <Text style={styles.statusText}>{event.status.replace('_', ' ')}</Text>
          </View>
        </View>

        {isCancelled ? (
          <View style={styles.cancelledBanner}>
            <Text style={styles.cancelledText}>This event has been cancelled.</Text>
          </View>
        ) : null}

        <View style={styles.card}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Location</Text>
            <Text style={event.location ? styles.detailValue : styles.emptyValue}>
              {event.location ?? 'None'}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Contact</Text>
            {event.contact ? (
              <TouchableOpacity
                onPress={() =>
                  router.push({
                    pathname: '/contact/[id]',
                    params: { id: event.contact!.id },
                  })
                }
                accessibilityRole="button"
              >
                <Text style={styles.linkText}>{contactName(event.contact)}</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.emptyValue}>None</Text>
            )}
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Deal</Text>
            {event.deal ? (
              <TouchableOpacity
                onPress={() =>
                  router.push({
                    pathname: '/deal/[id]',
                    params: { id: event.deal!.id },
                  })
                }
                accessibilityRole="button"
              >
                <Text style={styles.linkText}>{event.deal.title}</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.emptyValue}>None</Text>
            )}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Agenda Notes</Text>
          <Text style={event.description ? styles.bodyText : styles.emptyValue}>
            {event.description ?? 'No agenda notes'}
          </Text>
        </View>

        {isCompleted ? (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>Post-meeting Notes</Text>
            <TextInput
              style={styles.notesInput}
              value={postMeetingNotes}
              onChangeText={(value) => {
                setPostMeetingNotes(value);
                setNotesFieldError(null);
              }}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
              placeholder="Add outcomes, follow-ups, and context"
              placeholderTextColor="#6B6B6B"
            />
            {notesFieldError ? <Text style={styles.fieldError}>{notesFieldError}</Text> : null}
            <TouchableOpacity
              style={[
                styles.button,
                styles.buttonPrimary,
                isActionDisabled && styles.buttonDisabled,
              ]}
              onPress={() => {
                void handleSaveNotes();
              }}
              disabled={isActionDisabled}
              accessibilityRole="button"
            >
              {activeAction === 'notes' ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.buttonText}>{event.notes ? 'Update Notes' : 'Save Notes'}</Text>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.infoBox}>
            <Text style={styles.infoText}>Mark the event complete to add post-meeting notes.</Text>
          </View>
        )}

        {!isCancelled ? (
          <View style={styles.card}>
            {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
            <TouchableOpacity
              style={[
                styles.button,
                styles.buttonPrimary,
                isActionDisabled && styles.buttonDisabled,
              ]}
              onPress={() => {
                void handleToggleComplete();
              }}
              disabled={isActionDisabled}
              accessibilityRole="button"
            >
              {activeAction === 'complete' ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.buttonText}>{completeLabel}</Text>
              )}
            </TouchableOpacity>

            {!isCompleted ? (
              <TouchableOpacity
                style={[
                  styles.button,
                  styles.buttonDestructive,
                  styles.secondaryAction,
                  isActionDisabled && styles.buttonDisabled,
                ]}
                onPress={() => {
                  void handleCancel();
                }}
                disabled={isActionDisabled}
                accessibilityRole="button"
              >
                {activeAction === 'cancel' ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Cancel Event</Text>
                )}
              </TouchableOpacity>
            ) : null}
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
    paddingBottom: 40,
    gap: 14,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ECECEC',
    padding: 16,
  },
  title: {
    color: '#1A1A1A',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  timeRange: {
    color: '#6B6B6B',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  cancelledBanner: {
    backgroundColor: '#FEE8E6',
    borderLeftColor: '#D93025',
    borderLeftWidth: 3,
    borderRadius: 8,
    padding: 12,
  },
  cancelledText: {
    color: '#D93025',
    fontSize: 13,
    fontWeight: '600',
  },
  detailRow: {
    alignItems: 'center',
    borderBottomColor: '#F1F1F1',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  detailLabel: {
    color: '#6B6B6B',
    fontSize: 13,
    fontWeight: '600',
    width: 82,
  },
  detailValue: {
    color: '#1A1A1A',
    flex: 1,
    fontSize: 14,
    textAlign: 'right',
  },
  emptyValue: {
    color: '#9B9B9B',
    flex: 1,
    fontSize: 14,
    textAlign: 'right',
  },
  linkText: {
    color: '#1A73E8',
    fontSize: 14,
    fontWeight: '600',
    maxWidth: 220,
    textAlign: 'right',
  },
  sectionLabel: {
    color: '#6B6B6B',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  bodyText: {
    color: '#1A1A1A',
    fontSize: 14,
    lineHeight: 20,
  },
  notesInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E0E0E0',
    borderRadius: 8,
    borderWidth: 1,
    color: '#1A1A1A',
    fontSize: 15,
    minHeight: 116,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  fieldError: {
    color: '#D93025',
    fontSize: 12,
    marginTop: 6,
  },
  infoBox: {
    backgroundColor: '#E8F0FE',
    borderRadius: 8,
    padding: 12,
  },
  infoText: {
    color: '#1A73E8',
    fontSize: 13,
    fontWeight: '600',
  },
  button: {
    alignItems: 'center',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 46,
    paddingVertical: 12,
  },
  buttonPrimary: {
    backgroundColor: '#1A73E8',
  },
  buttonDestructive: {
    backgroundColor: '#D93025',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryAction: {
    marginTop: 10,
  },
  actionError: {
    color: '#D93025',
    fontSize: 13,
    marginBottom: 12,
    textAlign: 'center',
  },
  errorContainer: {
    alignItems: 'center',
    backgroundColor: '#F5F5F5',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  errorText: {
    color: '#D93025',
    fontSize: 14,
    marginBottom: 14,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#1A73E8',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  headerEditButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  headerEditText: {
    color: '#1A73E8',
    fontSize: 16,
    fontWeight: '600',
  },
});
