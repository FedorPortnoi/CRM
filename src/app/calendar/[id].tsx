import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { enqueue } from '../../utils/offlineQueue';
import { sendOrQueueMutation } from '../../utils/offlineMutation';
import { formatMarketDateTime, formatMarketTime } from '../../market/profile';
import AttachmentsSection from '../../components/AttachmentsSection';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
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
  completed_at: string | null;
  contact: CalendarContact | null;
  deal: CalendarDeal | null;
};

type ErrorResponse = {
  error?: { message?: string };
};

type ActionName = 'complete' | 'cancel' | 'notes';
type MutationResult = { queued: true } | { queued: false; response: Response };

function formatDateTime(dateString: string): string {
  return formatMarketDateTime(dateString, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    weekday: 'short',
    year: 'numeric',
  });
}

function formatTime(dateString: string): string {
  return formatMarketTime(dateString, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusBadgeVariant(status: CalendarEventStatus): BadgeVariant {
  if (status === 'completed') return 'success';
  if (status === 'cancelled') return 'neutral';
  return 'accent';
}

function contactName(contact: CalendarContact): string {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ');
}

async function parseEventResponse(res: Response, fallbackMessage: string): Promise<CalendarEvent> {
  if (!res.ok) {
    const body = (await res.json()) as ErrorResponse;
    throw new Error(body.error?.message ?? `${fallbackMessage} with status ${res.status}`);
  }

  const body = (await res.json()) as { data: CalendarEvent };
  return body.data;
}

export default function CalendarEventDetailScreen(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const token = useUserStore((s) => s.token);
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<ActionName | null>(null);
  const [postMeetingNotes, setPostMeetingNotes] = useState<string>('');
  const [notesFieldError, setNotesFieldError] = useState<string | null>(null);
  const [isCompletionNotesPromptVisible, setIsCompletionNotesPromptVisible] =
    useState<boolean>(false);
  const [completionNotesDraft, setCompletionNotesDraft] = useState<string>('');

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
        setFetchError(e instanceof Error ? e.message : 'Не удалось загрузить событие');
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
    request: () => Promise<MutationResult>,
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

      const updated = await parseEventResponse(result.response, 'Action failed');
      onSuccess(updated);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Action failed. Please try again.');
    } finally {
      setActiveAction(null);
    }
  }

  async function completeEventWithOptionalNotes(notes: string): Promise<void> {
    if (activeAction) return;
    setActiveAction('complete');
    setActionError(null);

    const trimmedNotes = notes.trim();

    try {
      const completionResult = await sendOrQueueMutation({
        url: `${API_URL}/calendar/${id}/complete`,
        method: 'POST',
        token: token ?? '',
      });

      if (completionResult.queued) {
        if (trimmedNotes !== '') {
          await enqueue({
            url: `${API_URL}/calendar/${id}/notes`,
            method: 'POST',
            body: JSON.stringify({ notes: trimmedNotes }),
          });
        }
        router.back();
        return;
      }

      const completed = await parseEventResponse(
        completionResult.response,
        'Complete event failed',
      );
      setEvent(completed);
      setPostMeetingNotes(completed.notes ?? '');

      if (trimmedNotes === '') {
        return;
      }

      const notesResult = await sendOrQueueMutation({
        url: `${API_URL}/calendar/${id}/notes`,
        method: 'POST',
        token: token ?? '',
        body: { notes: trimmedNotes },
      });

      if (notesResult.queued) {
        router.back();
        return;
      }

      const updated = await parseEventResponse(notesResult.response, 'Save notes failed');
      setEvent(updated);
      setPostMeetingNotes(updated.notes ?? '');
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Action failed. Please try again.');
    } finally {
      setActiveAction(null);
    }
  }

  function handleCompletionNotesPromptSave(notes: string): void {
    setIsCompletionNotesPromptVisible(false);
    setCompletionNotesDraft('');
    void completeEventWithOptionalNotes(notes);
  }

  function handleCompletionNotesPromptSkip(): void {
    handleCompletionNotesPromptSave('');
  }

  function showCompletionNotesPrompt(): void {
    if (activeAction) return;

    setActionError(null);

    if (Platform.OS === 'ios' && typeof Alert.prompt === 'function') {
      Alert.prompt(
        t('calendar.completeNotesPromptTitle'),
        t('calendar.completeNotesPromptMessage'),
        [
          {
            text: t('calendar.completeNotesPromptSkip'),
            onPress: (): void => {
              void completeEventWithOptionalNotes('');
            },
          },
          {
            text: t('calendar.completeNotesPromptSave'),
            onPress: (text?: string): void => {
              void completeEventWithOptionalNotes(text ?? '');
            },
          },
        ],
        'plain-text',
      );
      return;
    }

    setCompletionNotesDraft('');
    setIsCompletionNotesPromptVisible(true);
  }

  async function handleToggleComplete(): Promise<void> {
    if (event?.status === 'scheduled') {
      showCompletionNotesPrompt();
      return;
    }

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
        <Screen contentContainerStyle={styles.content}>
          <Card>
            <Skeleton width={240} height={22} style={styles.skeletonGap} />
            <Skeleton width={180} height={14} style={styles.skeletonGap} />
            <Skeleton width={92} height={20} rounded={radius.pill} />
          </Card>
          <Card>
            <SkeletonText lines={2} lastLineWidth="75%" />
          </Card>
          <Card>
            <Skeleton height={80} />
          </Card>
        </Screen>
      </>
    );
  }

  if (fetchError) {
    return (
      <>
        <Stack.Screen options={{ title: 'Event', headerShown: true }} />
        <Screen>
          <EmptyState
            icon={<AlertCircle size={32} color={colors.danger} />}
            title={fetchError}
            actionLabel={t('common.retry')}
            onAction={() => { void fetchEvent(false); }}
          />
        </Screen>
      </>
    );
  }

  if (!event) return <></>;

  const isCompleted = event.status === 'completed';
  const isCancelled = event.status === 'cancelled';
  const completeLabel = isCompleted ? t('calendar.markScheduled') : t('calendar.markComplete');
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
              <Text style={styles.headerEditText}>{t('common.edit')}</Text>
            </TouchableOpacity>
          ),
        }}
      />
      <Screen
        contentContainerStyle={styles.content}
        refreshing={isRefreshing}
        onRefresh={() => { void fetchEvent(true); }}
      >
        <Card>
          <Text style={styles.title}>{event.title}</Text>
          <Text style={styles.timeRange}>
            {formatDateTime(event.start_time)} - {formatTime(event.end_time)}
          </Text>
          <Badge label={t(`calendar.${event.status}`)} variant={statusBadgeVariant(event.status)} />
        </Card>

        {isCancelled ? (
          <View style={styles.cancelledBanner}>
            <Text style={styles.cancelledText}>{t('calendar.cancelledBanner')}</Text>
          </View>
        ) : null}

        <Card>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('calendar.locationLabel')}</Text>
            <Text style={event.location ? styles.detailValue : styles.emptyValue}>
              {event.location ?? t('calendar.none')}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('calendar.contactLabel')}</Text>
            {event.contact ? (
              <TouchableOpacity
                onPress={() =>
                  router.push({
                    pathname: '/contact/[id]',
                    params: { id: event.contact!.id },
                  })
                }
                activeOpacity={0.7}
                accessibilityRole="button"
              >
                <Text style={styles.linkText}>{contactName(event.contact)}</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.emptyValue}>{t('calendar.none')}</Text>
            )}
          </View>
          <View style={[styles.detailRow, styles.detailRowLast]}>
            <Text style={styles.detailLabel}>{t('calendar.dealLabel')}</Text>
            {event.deal ? (
              <TouchableOpacity
                onPress={() =>
                  router.push({
                    pathname: '/deal/[id]',
                    params: { id: event.deal!.id },
                  })
                }
                activeOpacity={0.7}
                accessibilityRole="button"
              >
                <Text style={styles.linkText}>{event.deal.title}</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.emptyValue}>{t('calendar.none')}</Text>
            )}
          </View>
        </Card>

        <Card>
          <Text style={styles.sectionLabel}>{t('calendar.agendaNotes')}</Text>
          <Text style={event.description ? styles.bodyText : styles.emptyValue}>
            {event.description ?? t('calendar.noAgendaNotes')}
          </Text>
        </Card>

        {isCompleted ? (
          <Card>
            <Text style={styles.sectionLabel}>{t('calendar.postMeetingNotes')}</Text>
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
              placeholder={t('calendar.outcomesPlaceholder')}
              placeholderTextColor={colors.placeholder}
            />
            {notesFieldError ? <Text style={styles.fieldError}>{notesFieldError}</Text> : null}
            <Button
              title={event.notes ? t('calendar.updateNotes') : t('calendar.saveNotes')}
              onPress={() => { void handleSaveNotes(); }}
              loading={activeAction === 'notes'}
              disabled={isActionDisabled}
              block
              style={styles.actionSpacing}
            />
          </Card>
        ) : (
          <View style={styles.infoBox}>
            <Text style={styles.infoText}>{t('calendar.completeToAddNotes')}</Text>
          </View>
        )}

        {!isCancelled ? (
          <Card>
            {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
            <Button
              title={completeLabel}
              onPress={() => { void handleToggleComplete(); }}
              loading={activeAction === 'complete'}
              disabled={isActionDisabled}
              block
            />

            {!isCompleted ? (
              <Button
                title={t('calendar.cancelEvent')}
                variant="danger"
                onPress={() => { void handleCancel(); }}
                loading={activeAction === 'cancel'}
                disabled={isActionDisabled}
                block
                style={styles.secondaryAction}
              />
            ) : null}
          </Card>
        ) : null}
        <AttachmentsSection entityType="calendar_event" entityId={id as string} />
      </Screen>

      <Modal
        visible={isCompletionNotesPromptVisible}
        transparent
        animationType="fade"
        onRequestClose={handleCompletionNotesPromptSkip}
      >
        <KeyboardAvoidingView
          style={styles.promptOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.promptCard}>
            <Text style={styles.promptTitle}>{t('calendar.completeNotesPromptTitle')}</Text>
            <Text style={styles.promptMessage}>{t('calendar.completeNotesPromptMessage')}</Text>
            <TextInput
              style={styles.promptInput}
              value={completionNotesDraft}
              onChangeText={setCompletionNotesDraft}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              placeholder={t('calendar.completeNotesPromptPlaceholder')}
              placeholderTextColor={colors.placeholder}
              editable={!isActionDisabled}
              autoFocus
            />
            <View style={styles.promptActions}>
              <Button
                title={t('calendar.completeNotesPromptSkip')}
                variant="secondary"
                onPress={handleCompletionNotesPromptSkip}
                disabled={isActionDisabled}
                style={styles.flexButton}
              />
              <Button
                title={t('calendar.completeNotesPromptSave')}
                onPress={() => { handleCompletionNotesPromptSave(completionNotesDraft); }}
                loading={activeAction === 'complete'}
                disabled={isActionDisabled}
                style={styles.flexButton}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  content: {
    gap: spacing.md,
  },
  skeletonGap: {
    marginBottom: spacing.sm,
  },
  title: {
    color: c.text1,
    ...type.title,
    marginBottom: spacing.sm,
  },
  timeRange: {
    color: c.textMuted,
    ...type.label,
    marginBottom: spacing.md,
    fontVariant: ['tabular-nums'],
  },
  cancelledBanner: {
    backgroundColor: c.dangerSoft,
    borderLeftColor: c.danger,
    borderLeftWidth: 3,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  cancelledText: {
    color: c.danger,
    ...type.label,
  },
  detailRow: {
    alignItems: 'center',
    borderBottomColor: c.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  detailRowLast: {
    borderBottomWidth: 0,
  },
  detailLabel: {
    color: c.textMuted,
    ...type.label,
    width: 82,
  },
  detailValue: {
    color: c.text1,
    flex: 1,
    ...type.body,
    textAlign: 'right',
  },
  emptyValue: {
    color: c.textMuted,
    flex: 1,
    ...type.body,
    textAlign: 'right',
  },
  linkText: {
    color: c.accent,
    ...type.body,
    fontWeight: '600',
    maxWidth: 220,
    textAlign: 'right',
  },
  sectionLabel: {
    color: c.textMuted,
    ...type.caption,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  bodyText: {
    color: c.text1,
    ...type.body,
  },
  notesInput: {
    backgroundColor: c.inputBg,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    borderWidth: 1,
    color: c.text1,
    ...type.body,
    minHeight: 116,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  fieldError: {
    color: c.danger,
    ...type.caption,
    marginTop: spacing.sm,
  },
  infoBox: {
    backgroundColor: c.accentSoft,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  infoText: {
    color: c.accent,
    ...type.label,
  },
  actionSpacing: {
    marginTop: spacing.md,
  },
  secondaryAction: {
    marginTop: spacing.sm,
  },
  flexButton: {
    flex: 1,
  },
  actionError: {
    color: c.danger,
    ...type.label,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  headerEditButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  headerEditText: {
    color: c.accent,
    ...type.heading,
  },
  promptOverlay: {
    alignItems: 'center',
    backgroundColor: c.overlay,
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  promptCard: {
    backgroundColor: c.bgPanel,
    borderRadius: radius.lg,
    maxWidth: 420,
    padding: spacing.lg,
    width: '100%',
  },
  promptTitle: {
    color: c.text1,
    ...type.subtitle,
    marginBottom: spacing.sm,
  },
  promptMessage: {
    color: c.textMuted,
    ...type.body,
    marginBottom: spacing.md,
  },
  promptInput: {
    backgroundColor: c.inputBg,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    borderWidth: 1,
    color: c.text1,
    ...type.body,
    minHeight: 104,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  promptActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
});
