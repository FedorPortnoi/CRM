// One email sequence — ordered steps, enrollments, and the launch/pause switch.
//
// Backend: GET/PATCH/DELETE /api/v1/sequences/:id
//          POST/DELETE      /api/v1/sequences/:id/steps[/:stepId], POST .../steps/reorder
//          GET/POST/DELETE  /api/v1/sequences/:id/enrollments[/:enrollmentId]
// i18n:    sequences.*
//
// Owner/admin only, enforced again on the server.
//
// The enrollment picker is where ФЗ-38 «О рекламе» ст. 18 becomes visible: a contact who
// never consented, or who unsubscribed, cannot be mailed. Rather than let the operator tap
// and collect a red 422, the picker marks those contacts up front, and either path — the
// local mark or the server's refusal — opens ConsentRefusalNotice, which explains the rule
// and links to the contact card where consent is recorded.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, UserPlus, X } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { formatMarketDate, formatMarketDateTime } from '../../market/profile';
import {
  ENROLLMENT_STATUSES,
  MAX_STEP_DELAY_DAYS,
  SequenceApiError,
  contactDisplayName,
  marketingBlockFor,
  useAddStep,
  useArchiveSequence,
  useEmailTemplateOptions,
  useEnrollContact,
  useMarketingContactSearch,
  useRemoveStep,
  useReorderSteps,
  useSequenceDetail,
  useSequenceEnrollments,
  useUnenroll,
  useUpdateSequence,
  type Enrollment,
  type EnrollmentStatus,
  type MarketingContact,
  type SequenceStatus,
  type SequenceStep,
} from '../../hooks/useSequences';
import ConsentRefusalNotice from '../../components/ConsentRefusalNotice';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

const STATUS_LABEL_KEYS: Record<SequenceStatus, string> = {
  draft: 'sequences.statusDraft',
  active: 'sequences.statusActive',
  paused: 'sequences.statusPaused',
  archived: 'sequences.statusArchived',
};

const STATUS_NOTE_KEYS: Record<SequenceStatus, string> = {
  draft: 'sequences.draftNote',
  active: 'sequences.activeNote',
  paused: 'sequences.pausedNote',
  archived: 'sequences.archivedNote',
};

const ENROLLMENT_LABEL_KEYS: Record<EnrollmentStatus, string> = {
  active: 'sequences.enrollmentStatusActive',
  completed: 'sequences.enrollmentStatusCompleted',
  unsubscribed: 'sequences.enrollmentStatusUnsubscribed',
  failed: 'sequences.enrollmentStatusFailed',
  cancelled: 'sequences.enrollmentStatusCancelled',
};

const ENROLLMENT_FILTERS: (EnrollmentStatus | 'all')[] = ['all', ...ENROLLMENT_STATUSES];

function sequenceStatusColor(status: SequenceStatus, c: ThemeColors): string {
  if (status === 'active') return c.orange;
  if (status === 'paused') return c.amber;
  if (status === 'draft') return c.textMuted;
  return c.textFaint;
}

function enrollmentStatusColor(status: EnrollmentStatus, c: ThemeColors): string {
  if (status === 'active') return c.orange;
  if (status === 'completed') return c.amber;
  if (status === 'failed' || status === 'unsubscribed') return c.red;
  return c.textMuted;
}

/** Enrollment refusals we can name; anything else falls back to the generic panel. */
function refusalCodeOf(error: unknown): string {
  return error instanceof SequenceApiError ? error.code : 'REQUEST_FAILED';
}

export default function SequenceDetailScreen(): JSX.Element {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ id: string }>();
  const sequenceId = typeof params.id === 'string' ? params.id : '';
  const role = useUserStore((s) => s.user?.role);
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const canManage = role === 'owner' || role === 'admin';

  const [enrollmentFilter, setEnrollmentFilter] = useState<EnrollmentStatus | 'all'>('all');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const detailQuery = useSequenceDetail(canManage && sequenceId ? sequenceId : null);
  const enrollmentsQuery = useSequenceEnrollments(
    canManage && sequenceId ? sequenceId : null,
    enrollmentFilter,
  );

  const updateSequence = useUpdateSequence(sequenceId);
  const archiveSequence = useArchiveSequence(sequenceId);
  const addStep = useAddStep(sequenceId);
  const removeStep = useRemoveStep(sequenceId);
  const reorderSteps = useReorderSteps(sequenceId);
  const enrollContact = useEnrollContact(sequenceId);
  const unenroll = useUnenroll(sequenceId);

  // ── Step editor ────────────────────────────────────────────────────────────
  const [stepModalOpen, setStepModalOpen] = useState<boolean>(false);
  const [stepMode, setStepMode] = useState<'inline' | 'template'>('inline');
  const [stepDelay, setStepDelay] = useState<string>('0');
  const [stepSubject, setStepSubject] = useState<string>('');
  const [stepBody, setStepBody] = useState<string>('');
  const [stepTemplateId, setStepTemplateId] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);

  const templatesQuery = useEmailTemplateOptions(canManage);
  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data]);
  const templateNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const template of templates) map[template.id] = template.name;
    return map;
  }, [templates]);

  // ── Enrollment picker ──────────────────────────────────────────────────────
  const [enrollOpen, setEnrollOpen] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [debouncedTerm, setDebouncedTerm] = useState<string>('');
  const [refusal, setRefusal] = useState<{ code: string; contactId: string | null; name: string } | null>(
    null,
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTerm(searchTerm.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const contactsQuery = useMarketingContactSearch(debouncedTerm, enrollOpen);

  const onRefresh = useCallback((): void => {
    setIsRefreshing(true);
    void queryClient
      .invalidateQueries({ queryKey: ['sequences'] })
      .finally(() => setIsRefreshing(false));
  }, [queryClient]);

  const sequence = detailQuery.data ?? null;
  const steps: SequenceStep[] = sequence?.steps ?? [];
  const enrollments: Enrollment[] = enrollmentsQuery.data?.data ?? [];
  const enrollmentTotal = enrollmentsQuery.data?.meta.total ?? 0;
  const isBusy =
    updateSequence.isPending ||
    archiveSequence.isPending ||
    reorderSteps.isPending ||
    removeStep.isPending;

  const changeStatus = useCallback(
    (status: SequenceStatus): void => {
      setActionError(null);
      updateSequence.mutate(
        { status },
        { onError: () => setActionError(t('sequences.failedToUpdate')) },
      );
    },
    [updateSequence, t],
  );

  const confirmArchive = useCallback((): void => {
    Alert.alert(t('sequences.archiveConfirmTitle'), t('sequences.archiveConfirmBody'), [
      { text: t('sequences.cancel'), style: 'cancel' },
      {
        text: t('sequences.archiveConfirmAction'),
        style: 'destructive',
        onPress: () => {
          setActionError(null);
          archiveSequence.mutate(undefined, {
            onError: () => setActionError(t('sequences.failedToUpdate')),
          });
        },
      },
    ]);
  }, [archiveSequence, t]);

  const moveStep = useCallback(
    (index: number, direction: -1 | 1): void => {
      const target = index + direction;
      if (target < 0 || target >= steps.length) return;

      const ordered = steps.map((step) => step.id);
      const moved = ordered[index];
      const displaced = ordered[target];
      if (moved === undefined || displaced === undefined) return;
      ordered[index] = displaced;
      ordered[target] = moved;

      setActionError(null);
      reorderSteps.mutate(ordered, { onError: () => setActionError(t('sequences.failedToReorder')) });
    },
    [steps, reorderSteps, t],
  );

  const confirmRemoveStep = useCallback(
    (step: SequenceStep): void => {
      Alert.alert(t('sequences.removeStepConfirmTitle'), t('sequences.removeStepConfirmBody'), [
        { text: t('sequences.cancel'), style: 'cancel' },
        {
          text: t('sequences.removeStepConfirmAction'),
          style: 'destructive',
          onPress: () => {
            setActionError(null);
            removeStep.mutate(step.id, {
              onError: () => setActionError(t('sequences.failedToRemoveStep')),
            });
          },
        },
      ]);
    },
    [removeStep, t],
  );

  const resetStepForm = useCallback((): void => {
    setStepMode('inline');
    setStepDelay('0');
    setStepSubject('');
    setStepBody('');
    setStepTemplateId(null);
    setStepError(null);
  }, []);

  const submitStep = useCallback((): void => {
    const delay = Number.parseInt(stepDelay.trim() === '' ? '0' : stepDelay.trim(), 10);
    if (!Number.isFinite(delay) || delay < 0 || delay > MAX_STEP_DELAY_DAYS) {
      setStepError(t('sequences.stepDelayInvalid', { max: MAX_STEP_DELAY_DAYS }));
      return;
    }

    if (stepMode === 'template') {
      if (!stepTemplateId) {
        setStepError(t('sequences.stepTemplateRequired'));
        return;
      }
    } else if (stepSubject.trim() === '' || stepBody.trim() === '') {
      setStepError(t('sequences.stepContentRequired'));
      return;
    }

    setStepError(null);
    addStep.mutate(
      stepMode === 'template'
        ? { delay_days: delay, template_id: stepTemplateId }
        : { delay_days: delay, subject: stepSubject.trim(), body: stepBody.trim() },
      {
        onSuccess: () => {
          setStepModalOpen(false);
          resetStepForm();
        },
        onError: () => setStepError(t('sequences.failedToSaveStep')),
      },
    );
  }, [stepDelay, stepMode, stepTemplateId, stepSubject, stepBody, addStep, resetStepForm, t]);

  const pickContact = useCallback(
    (contact: MarketingContact): void => {
      const name = contactDisplayName(contact);
      const blocked = marketingBlockFor(contact);
      if (blocked) {
        // Refused locally — the server would answer the same, this just skips the round trip.
        setRefusal({ code: blocked, contactId: contact.id, name });
        return;
      }

      enrollContact.mutate(contact.id, {
        onSuccess: () => {
          setEnrollOpen(false);
          setSearchTerm('');
        },
        onError: (error) =>
          setRefusal({ code: refusalCodeOf(error), contactId: contact.id, name }),
      });
    },
    [enrollContact],
  );

  const confirmUnenroll = useCallback(
    (enrollment: Enrollment): void => {
      Alert.alert(t('sequences.stopConfirmTitle'), t('sequences.stopConfirmBody'), [
        { text: t('sequences.cancel'), style: 'cancel' },
        {
          text: t('sequences.stopConfirmAction'),
          style: 'destructive',
          onPress: () => {
            setActionError(null);
            unenroll.mutate(enrollment.id, {
              onError: () => setActionError(t('sequences.failedToStop')),
            });
          },
        },
      ]);
    },
    [unenroll, t],
  );

  if (!canManage) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: t('sequences.title') }} />
        <ScrollView contentContainerStyle={styles.gate}>
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{t('sequences.adminOnly')}</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (detailQuery.isPending) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: t('sequences.title') }} />
        <ActivityIndicator style={styles.loader} color={colors.orange} />
      </View>
    );
  }

  if (detailQuery.isError || !sequence) {
    const notFound =
      detailQuery.error instanceof SequenceApiError &&
      detailQuery.error.code === 'SEQUENCE_NOT_FOUND';
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: t('sequences.title') }} />
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>
            {notFound ? t('sequences.notFound') : t('sequences.detailFailed')}
          </Text>
          {notFound ? null : (
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => { void detailQuery.refetch(); }}
              accessibilityRole="button"
            >
              <Text style={styles.retryText}>{t('sequences.retry')}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  const statusColor = sequenceStatusColor(sequence.status, colors);
  const canEnroll = sequence.status !== 'archived' && steps.length > 0;

  const header = (
    <View>
      <View style={styles.headerCard}>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>{sequence.name}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '22' }]}>
            <Text style={[styles.statusBadgeText, { color: statusColor }]}>
              {t(STATUS_LABEL_KEYS[sequence.status])}
            </Text>
          </View>
        </View>

        {sequence.description ? (
          <Text style={styles.headerDescription}>{sequence.description}</Text>
        ) : null}

        <Text style={styles.headerNote}>{t(STATUS_NOTE_KEYS[sequence.status])}</Text>
        <Text style={styles.legalNote}>{t('sequences.consentNote')}</Text>

        {isBusy ? <ActivityIndicator color={colors.orange} style={styles.inlineLoader} /> : null}
        {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}

        {sequence.status === 'archived' ? null : (
          <View style={styles.actionRow}>
            {sequence.status === 'active' ? (
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => changeStatus('paused')}
                disabled={isBusy}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryButtonText}>{t('sequences.pause')}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={() => changeStatus('active')}
                disabled={isBusy || steps.length === 0}
                accessibilityRole="button"
              >
                <Text style={styles.primaryButtonText}>
                  {sequence.status === 'paused' ? t('sequences.resume') : t('sequences.activate')}
                </Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.dangerButton}
              onPress={confirmArchive}
              disabled={isBusy}
              accessibilityRole="button"
            >
              <Text style={styles.dangerButtonText}>{t('sequences.archive')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {sequence.status !== 'active' && steps.length === 0 ? (
          <Text style={styles.hintText}>{t('sequences.activateNeedsSteps')}</Text>
        ) : null}
      </View>

      {/* ── Steps ─────────────────────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>{t('sequences.stepsTitle')}</Text>

      {steps.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyCardText}>{t('sequences.noSteps')}</Text>
          <Text style={styles.emptyCardHint}>{t('sequences.noStepsHint')}</Text>
        </View>
      ) : (
        steps.map((step, index) => (
          <View key={step.id} style={styles.stepCard}>
            <View style={styles.stepHeader}>
              <View style={styles.stepBadge}>
                <Text style={styles.stepBadgeText}>{index + 1}</Text>
              </View>
              <Text style={styles.stepDelay}>
                {index === 0
                  ? step.delay_days === 0
                    ? t('sequences.stepDelayImmediate')
                    : t('sequences.stepDelayDays', { count: step.delay_days })
                  : step.delay_days === 0
                    ? t('sequences.stepDelayImmediateAfterPrevious')
                    : t('sequences.stepDelayAfterPrevious', { count: step.delay_days })}
              </Text>
              <View style={styles.stepControls}>
                <TouchableOpacity
                  style={styles.iconButton}
                  onPress={() => moveStep(index, -1)}
                  disabled={index === 0 || isBusy}
                  accessibilityRole="button"
                  accessibilityLabel={t('sequences.moveUp')}
                >
                  <ArrowUp
                    size={16}
                    color={index === 0 ? colors.textFaint : colors.text1}
                    strokeWidth={2}
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.iconButton}
                  onPress={() => moveStep(index, 1)}
                  disabled={index === steps.length - 1 || isBusy}
                  accessibilityRole="button"
                  accessibilityLabel={t('sequences.moveDown')}
                >
                  <ArrowDown
                    size={16}
                    color={index === steps.length - 1 ? colors.textFaint : colors.text1}
                    strokeWidth={2}
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.iconButton}
                  onPress={() => confirmRemoveStep(step)}
                  disabled={isBusy}
                  accessibilityRole="button"
                  accessibilityLabel={t('sequences.removeStep')}
                >
                  <X size={16} color={colors.red} strokeWidth={2} />
                </TouchableOpacity>
              </View>
            </View>

            <Text style={styles.stepSubject} numberOfLines={2}>
              {step.subject ??
                (step.template_id
                  ? (templateNameById[step.template_id] ?? t('sequences.stepFromTemplate'))
                  : t('sequences.stepNoSubject'))}
            </Text>
            {step.template_id ? (
              <Text style={styles.stepSource}>{t('sequences.stepFromTemplate')}</Text>
            ) : step.body ? (
              <Text style={styles.stepBody} numberOfLines={3}>{step.body}</Text>
            ) : null}
          </View>
        ))
      )}

      {sequence.status === 'archived' ? null : (
        <TouchableOpacity
          style={styles.addStepButton}
          onPress={() => {
            resetStepForm();
            setStepModalOpen(true);
          }}
          accessibilityRole="button"
        >
          <Plus size={16} color={colors.orange} strokeWidth={2.5} />
          <Text style={styles.addStepText}>{t('sequences.addStep')}</Text>
        </TouchableOpacity>
      )}

      {/* ── Enrollments ───────────────────────────────────────────────────── */}
      <View style={styles.enrollHeader}>
        <Text style={styles.sectionTitle}>{t('sequences.enrollmentsTitle')}</Text>
        <Text style={styles.enrollCount}>{t('sequences.enrollmentsTotal', { count: enrollmentTotal })}</Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filters}
      >
        {ENROLLMENT_FILTERS.map((value) => {
          const active = enrollmentFilter === value;
          return (
            <TouchableOpacity
              key={value}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setEnrollmentFilter(value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {value === 'all' ? t('sequences.filterAll') : t(ENROLLMENT_LABEL_KEYS[value])}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {enrollmentsQuery.isPending ? (
        <ActivityIndicator color={colors.orange} style={styles.inlineLoader} />
      ) : enrollmentsQuery.isError ? (
        <Text style={styles.errorText}>{t('sequences.enrollmentsFailed')}</Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: sequence.name }} />

      <FlatList
        data={enrollments}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={colors.orange} />
        }
        ListHeaderComponent={header}
        ListEmptyComponent={
          enrollmentsQuery.isPending || enrollmentsQuery.isError ? null : (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyCardText}>{t('sequences.enrollmentsEmpty')}</Text>
              <Text style={styles.emptyCardHint}>{t('sequences.enrollmentsEmptyHint')}</Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const color = enrollmentStatusColor(item.status, colors);
          const name = item.contact ? contactDisplayName(item.contact) : t('sequences.unknownContact');
          return (
            <View style={styles.enrollCard}>
              <View style={styles.enrollRow}>
                <View style={styles.enrollInfo}>
                  <Text style={styles.enrollName} numberOfLines={1}>
                    {name}
                    {item.contact?.company ? ` · ${item.contact.company}` : ''}
                  </Text>
                  {item.contact?.email ? (
                    <Text style={styles.enrollEmail} numberOfLines={1}>{item.contact.email}</Text>
                  ) : null}
                </View>
                <View style={[styles.statusBadge, { backgroundColor: color + '22' }]}>
                  <Text style={[styles.statusBadgeText, { color }]}>
                    {t(ENROLLMENT_LABEL_KEYS[item.status])}
                  </Text>
                </View>
              </View>

              <Text style={styles.enrollMeta}>
                {t('sequences.enrollmentStep', {
                  position: item.current_step + 1,
                  total: steps.length,
                })}
              </Text>
              <Text style={styles.enrollMeta}>
                {item.status === 'active'
                  ? item.next_send_at
                    ? t('sequences.nextSend', { date: formatMarketDateTime(item.next_send_at) })
                    : t('sequences.nextSendUnknown')
                  : t('sequences.enrolledAt', { date: formatMarketDate(item.enrolled_at) })}
              </Text>

              {item.status === 'active' ? (
                <TouchableOpacity
                  style={styles.stopButton}
                  onPress={() => confirmUnenroll(item)}
                  disabled={unenroll.isPending}
                  accessibilityRole="button"
                >
                  <Text style={styles.stopButtonText}>{t('sequences.stop')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        }}
      />

      {canEnroll ? (
        <TouchableOpacity
          style={styles.enrollButton}
          onPress={() => {
            setRefusal(null);
            setEnrollOpen(true);
          }}
          accessibilityRole="button"
        >
          <UserPlus size={18} color="#FFFFFF" strokeWidth={2.5} />
          <Text style={styles.enrollButtonText}>{t('sequences.enroll')}</Text>
        </TouchableOpacity>
      ) : null}

      {/* ── Add-step modal ────────────────────────────────────────────────── */}
      <Modal
        visible={stepModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setStepModalOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('sequences.addStep')}</Text>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.fieldLabel}>{t('sequences.stepDelayLabel')}</Text>
              <TextInput
                style={styles.input}
                value={stepDelay}
                onChangeText={setStepDelay}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={colors.placeholder}
              />
              <Text style={styles.fieldHint}>{t('sequences.stepDelayHint')}</Text>

              <View style={styles.modeRow}>
                <TouchableOpacity
                  style={[styles.modePill, stepMode === 'inline' && styles.modePillActive]}
                  onPress={() => setStepMode('inline')}
                  accessibilityRole="button"
                  accessibilityState={{ selected: stepMode === 'inline' }}
                >
                  <Text
                    style={[styles.modePillText, stepMode === 'inline' && styles.modePillTextActive]}
                  >
                    {t('sequences.stepWriteInline')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modePill, stepMode === 'template' && styles.modePillActive]}
                  onPress={() => setStepMode('template')}
                  accessibilityRole="button"
                  accessibilityState={{ selected: stepMode === 'template' }}
                >
                  <Text
                    style={[styles.modePillText, stepMode === 'template' && styles.modePillTextActive]}
                  >
                    {t('sequences.stepUseTemplate')}
                  </Text>
                </TouchableOpacity>
              </View>

              {stepMode === 'template' ? (
                templatesQuery.isPending ? (
                  <ActivityIndicator color={colors.orange} style={styles.inlineLoader} />
                ) : templates.length === 0 ? (
                  <Text style={styles.fieldHint}>{t('sequences.noTemplates')}</Text>
                ) : (
                  templates.map((template) => (
                    <TouchableOpacity
                      key={template.id}
                      style={[
                        styles.templateRow,
                        stepTemplateId === template.id && styles.templateRowSelected,
                      ]}
                      onPress={() => setStepTemplateId(template.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: stepTemplateId === template.id }}
                    >
                      <Text style={styles.templateName}>{template.name}</Text>
                      <Text style={styles.templateSubject} numberOfLines={1}>{template.subject}</Text>
                    </TouchableOpacity>
                  ))
                )
              ) : (
                <>
                  <Text style={styles.fieldLabel}>{t('sequences.stepSubjectLabel')}</Text>
                  <TextInput
                    style={styles.input}
                    value={stepSubject}
                    onChangeText={setStepSubject}
                    placeholder={t('sequences.stepSubjectPlaceholder')}
                    placeholderTextColor={colors.placeholder}
                  />
                  <Text style={styles.fieldLabel}>{t('sequences.stepBodyLabel')}</Text>
                  <TextInput
                    style={[styles.input, styles.textArea]}
                    value={stepBody}
                    onChangeText={setStepBody}
                    placeholder={t('sequences.stepBodyPlaceholder')}
                    placeholderTextColor={colors.placeholder}
                    multiline
                    textAlignVertical="top"
                  />
                  <Text style={styles.fieldHint}>{t('sequences.stepBodyHint')}</Text>
                </>
              )}

              {stepError ? <Text style={styles.errorText}>{stepError}</Text> : null}

              <TouchableOpacity
                style={styles.primaryButtonWide}
                onPress={submitStep}
                disabled={addStep.isPending}
                accessibilityRole="button"
              >
                {addStep.isPending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryButtonText}>{t('sequences.saveStep')}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalClose}
                onPress={() => setStepModalOpen(false)}
                accessibilityRole="button"
              >
                <Text style={styles.modalCloseText}>{t('sequences.cancel')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── Enrollment picker / refusal ───────────────────────────────────── */}
      <Modal
        visible={enrollOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setEnrollOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            {refusal ? (
              <ConsentRefusalNotice
                code={refusal.code}
                contactName={refusal.name}
                onOpenContact={() => {
                  const contactId = refusal.contactId;
                  setRefusal(null);
                  setEnrollOpen(false);
                  if (contactId) router.push(`/contact/${contactId}` as never);
                }}
                onDismiss={() => setRefusal(null)}
              />
            ) : (
              <>
                <Text style={styles.modalTitle}>{t('sequences.enrollTitle')}</Text>
                <Text style={styles.modalSubtitle}>{t('sequences.enrollHint')}</Text>
                <TextInput
                  style={styles.input}
                  value={searchTerm}
                  onChangeText={setSearchTerm}
                  placeholder={t('sequences.enrollSearch')}
                  placeholderTextColor={colors.placeholder}
                  autoCorrect={false}
                  autoFocus
                />

                <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
                  {enrollContact.isPending ? (
                    <ActivityIndicator color={colors.orange} style={styles.inlineLoader} />
                  ) : debouncedTerm.length < 2 ? (
                    <Text style={styles.fieldHint}>{t('sequences.enrollSearchHint')}</Text>
                  ) : contactsQuery.isPending ? (
                    <ActivityIndicator color={colors.orange} style={styles.inlineLoader} />
                  ) : contactsQuery.isError ? (
                    <Text style={styles.errorText}>{t('sequences.enrollSearchFailed')}</Text>
                  ) : (contactsQuery.data ?? []).length === 0 ? (
                    <Text style={styles.fieldHint}>{t('sequences.enrollNoResults')}</Text>
                  ) : (
                    (contactsQuery.data ?? []).map((contact) => {
                      const blocked = marketingBlockFor(contact);
                      const badgeKey =
                        blocked === 'CONTACT_UNSUBSCRIBED'
                          ? 'sequences.consentBadgeUnsubscribed'
                          : blocked === 'MARKETING_CONSENT_REQUIRED'
                            ? 'sequences.consentBadgeMissing'
                            : blocked === 'CONTACT_NO_EMAIL'
                              ? 'sequences.consentBadgeNoEmail'
                              : 'sequences.consentBadgeOk';
                      const badgeColor = blocked ? colors.red : colors.orange;
                      return (
                        <TouchableOpacity
                          key={contact.id}
                          style={styles.contactRow}
                          onPress={() => pickContact(contact)}
                          accessibilityRole="button"
                        >
                          <View style={styles.enrollInfo}>
                            <Text style={styles.contactName} numberOfLines={1}>
                              {contactDisplayName(contact)}
                              {contact.company ? ` · ${contact.company}` : ''}
                            </Text>
                            {contact.email ? (
                              <Text style={styles.enrollEmail} numberOfLines={1}>{contact.email}</Text>
                            ) : null}
                          </View>
                          <View style={[styles.statusBadge, { backgroundColor: badgeColor + '22' }]}>
                            <Text style={[styles.statusBadgeText, { color: badgeColor }]}>
                              {t(badgeKey)}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })
                  )}
                </ScrollView>

                <TouchableOpacity
                  style={styles.modalClose}
                  onPress={() => setEnrollOpen(false)}
                  accessibilityRole="button"
                >
                  <Text style={styles.modalCloseText}>{t('sequences.cancel')}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  gate: { padding: 20, gap: 10 },
  notice: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
    padding: 14,
  },
  noticeText: { color: c.amber, fontSize: 14, lineHeight: 20 },
  loader: { marginTop: 32 },
  inlineLoader: { marginVertical: 12 },
  list: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 32 },
  headerCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 14,
    gap: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: c.text1 },
  headerDescription: { fontSize: 13, color: c.amber, lineHeight: 18 },
  headerNote: { fontSize: 13, color: c.text1, lineHeight: 18 },
  legalNote: { fontSize: 11, color: c.textMuted, lineHeight: 16 },
  hintText: { fontSize: 12, color: c.amber, lineHeight: 17 },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  primaryButton: {
    flex: 1,
    backgroundColor: c.orange,
    borderRadius: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  primaryButtonWide: {
    backgroundColor: c.orange,
    borderRadius: 10,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  secondaryButton: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.borderStrong,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  secondaryButtonText: { color: c.text1, fontSize: 14, fontWeight: '700' },
  dangerButton: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.red,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  dangerButtonText: { color: c.red, fontSize: 14, fontWeight: '700' },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: c.text1, marginTop: 20, marginBottom: 8 },
  emptyCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 14,
    gap: 4,
  },
  emptyCardText: { fontSize: 14, color: c.text1 },
  emptyCardHint: { fontSize: 12, color: c.amber, lineHeight: 17 },
  stepCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 12,
    marginBottom: 8,
  },
  stepHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(204,120,92,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBadgeText: { fontSize: 12, fontWeight: '700', color: c.orange },
  stepDelay: { flex: 1, fontSize: 12, color: c.amber },
  stepControls: { flexDirection: 'row', gap: 4 },
  iconButton: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepSubject: { fontSize: 14, fontWeight: '600', color: c.text1, marginTop: 8 },
  stepSource: { fontSize: 12, color: c.textMuted, marginTop: 4 },
  stepBody: { fontSize: 12, color: c.textMuted, marginTop: 4, lineHeight: 17 },
  addStepButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.orange,
    paddingVertical: 12,
    marginTop: 4,
  },
  addStepText: { color: c.orange, fontSize: 14, fontWeight: '700' },
  enrollHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  enrollCount: { fontSize: 12, color: c.amber, marginBottom: 10 },
  filters: { paddingVertical: 4, gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
  },
  chipActive: { backgroundColor: c.orange, borderColor: c.orange },
  chipText: { color: c.amber, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: '#FFFFFF' },
  enrollCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 12,
    marginTop: 8,
  },
  enrollRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  enrollInfo: { flex: 1 },
  enrollName: { fontSize: 14, fontWeight: '600', color: c.text1 },
  enrollEmail: { fontSize: 12, color: c.amber, marginTop: 2 },
  enrollMeta: { fontSize: 12, color: c.textMuted, marginTop: 6 },
  stopButton: {
    alignSelf: 'flex-start',
    marginTop: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.red,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  stopButtonText: { color: c.red, fontSize: 12, fontWeight: '700' },
  statusBadge: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  statusBadgeText: { fontSize: 11, fontWeight: '700' },
  enrollButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    margin: 16,
    backgroundColor: c.orange,
    borderRadius: 12,
    paddingVertical: 14,
  },
  enrollButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  errorBox: { padding: 24, alignItems: 'center', gap: 12 },
  errorText: { color: c.red, fontSize: 13, marginTop: 8, lineHeight: 18 },
  retryButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryText: { color: c.text1, fontSize: 14, fontWeight: '600' },
  modalBackdrop: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: c.bgPanel,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '85%',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: c.text1 },
  modalSubtitle: { fontSize: 12, color: c.amber, marginTop: 4, marginBottom: 10, lineHeight: 17 },
  // React Native defaults flexShrink to 0 — without this the list overflows the sheet.
  modalScroll: { marginTop: 10, flexShrink: 1 },
  modalClose: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 20 },
  modalCloseText: { color: c.amber, fontSize: 15 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: c.text1, marginTop: 12, marginBottom: 6 },
  fieldHint: { fontSize: 12, color: c.textMuted, marginTop: 6, lineHeight: 17 },
  input: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: c.text1,
  },
  textArea: { minHeight: 120 },
  modeRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  modePill: {
    flex: 1,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 8,
    alignItems: 'center',
  },
  modePillActive: { backgroundColor: c.orange, borderColor: c.orange },
  modePillText: { fontSize: 13, color: c.text1 },
  modePillTextActive: { color: '#FFFFFF', fontWeight: '700' },
  templateRow: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    padding: 12,
    marginTop: 8,
  },
  templateRowSelected: { borderColor: c.orange, backgroundColor: 'rgba(204,120,92,0.08)' },
  templateName: { fontSize: 14, fontWeight: '600', color: c.text1 },
  templateSubject: { fontSize: 12, color: c.amber, marginTop: 2 },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  contactName: { fontSize: 15, color: c.text1 },
});
