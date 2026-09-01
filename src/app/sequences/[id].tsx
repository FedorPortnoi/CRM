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
import { AlertCircle, ArrowDown, ArrowUp, Inbox, Layers, Plus, UserPlus, X } from 'lucide-react-native';
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
import { ThemeColors, spacing, radius, type } from '../../theme';
import { Screen, Card, Button, Badge, EmptyState, Skeleton, SkeletonText } from '../../components/ui';
import type { BadgeVariant } from '../../components/ui';

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

function sequenceStatusBadgeVariant(status: SequenceStatus): BadgeVariant {
  if (status === 'active') return 'accent';
  if (status === 'paused') return 'warning';
  return 'neutral';
}

function enrollmentStatusBadgeVariant(status: EnrollmentStatus): BadgeVariant {
  if (status === 'active') return 'accent';
  if (status === 'completed') return 'success';
  if (status === 'failed' || status === 'unsubscribed') return 'danger';
  return 'neutral';
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
      <>
        <Stack.Screen options={{ title: t('sequences.title') }} />
        <Screen>
          <Card>
            <Text style={styles.noticeText}>{t('sequences.adminOnly')}</Text>
          </Card>
        </Screen>
      </>
    );
  }

  if (detailQuery.isPending) {
    return (
      <>
        <Stack.Screen options={{ title: t('sequences.title') }} />
        <Screen contentContainerStyle={styles.content}>
          <Card>
            <Skeleton width={200} height={20} style={styles.skeletonGap} />
            <Skeleton width={140} height={14} style={styles.skeletonGap} />
            <Skeleton width={90} height={18} rounded={radius.pill} />
          </Card>
          <Card>
            <SkeletonText lines={3} lastLineWidth="65%" />
          </Card>
        </Screen>
      </>
    );
  }

  if (detailQuery.isError || !sequence) {
    const notFound =
      detailQuery.error instanceof SequenceApiError &&
      detailQuery.error.code === 'SEQUENCE_NOT_FOUND';
    return (
      <>
        <Stack.Screen options={{ title: t('sequences.title') }} />
        <Screen>
          <EmptyState
            icon={<AlertCircle size={32} color={colors.danger} />}
            title={notFound ? t('sequences.notFound') : t('sequences.detailFailed')}
            actionLabel={notFound ? undefined : t('sequences.retry')}
            onAction={notFound ? undefined : () => { void detailQuery.refetch(); }}
          />
        </Screen>
      </>
    );
  }

  const canEnroll = sequence.status !== 'archived' && steps.length > 0;
  const openEnroll = (): void => {
    setRefusal(null);
    setEnrollOpen(true);
  };

  const header = (
    <View>
      <Card>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>{sequence.name}</Text>
          <Badge label={t(STATUS_LABEL_KEYS[sequence.status])} variant={sequenceStatusBadgeVariant(sequence.status)} />
        </View>

        {sequence.description ? (
          <Text style={styles.headerDescription}>{sequence.description}</Text>
        ) : null}

        <Text style={styles.headerNote}>{t(STATUS_NOTE_KEYS[sequence.status])}</Text>
        <Text style={styles.legalNote}>{t('sequences.consentNote')}</Text>

        {isBusy ? <ActivityIndicator color={colors.accent} style={styles.inlineLoader} /> : null}
        {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}

        {sequence.status === 'archived' ? null : (
          <View style={styles.actionRow}>
            {sequence.status === 'active' ? (
              <Button
                title={t('sequences.pause')}
                variant="secondary"
                onPress={() => changeStatus('paused')}
                disabled={isBusy}
                style={styles.flexButton}
              />
            ) : (
              <Button
                title={sequence.status === 'paused' ? t('sequences.resume') : t('sequences.activate')}
                onPress={() => changeStatus('active')}
                disabled={isBusy || steps.length === 0}
                style={styles.flexButton}
              />
            )}

            <Button
              title={t('sequences.archive')}
              variant="danger"
              onPress={confirmArchive}
              disabled={isBusy}
              style={styles.flexButton}
            />
          </View>
        )}

        {sequence.status !== 'active' && steps.length === 0 ? (
          <Text style={styles.hintText}>{t('sequences.activateNeedsSteps')}</Text>
        ) : null}
      </Card>

      {/* ── Steps ─────────────────────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>{t('sequences.stepsTitle')}</Text>

      {steps.length === 0 ? (
        <EmptyState
          icon={<Layers size={28} color={colors.textMuted} />}
          title={t('sequences.noSteps')}
          description={t('sequences.noStepsHint')}
        />
      ) : (
        steps.map((step, index) => (
          <Card key={step.id} style={styles.stepCard}>
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
                  activeOpacity={0.7}
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
                  activeOpacity={0.7}
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
                  activeOpacity={0.7}
                >
                  <X size={16} color={colors.danger} strokeWidth={2} />
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
          </Card>
        ))
      )}

      {sequence.status === 'archived' ? null : (
        <Button
          title={t('sequences.addStep')}
          variant="ghost"
          icon={<Plus size={16} color={colors.accent} strokeWidth={2.5} />}
          onPress={() => {
            resetStepForm();
            setStepModalOpen(true);
          }}
          block
          style={styles.addStepButton}
        />
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
              activeOpacity={0.7}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {value === 'all' ? t('sequences.filterAll') : t(ENROLLMENT_LABEL_KEYS[value])}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {enrollmentsQuery.isPending ? (
        <View style={styles.enrollSkeletonWrap}>
          {Array.from({ length: 2 }).map((_, index) => (
            <Card key={index} style={styles.enrollCard}>
              <SkeletonText lines={2} lastLineWidth="50%" />
            </Card>
          ))}
        </View>
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
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
        ListHeaderComponent={header}
        ListEmptyComponent={
          enrollmentsQuery.isPending || enrollmentsQuery.isError ? null : (
            <EmptyState
              icon={<Inbox size={28} color={colors.textMuted} />}
              title={t('sequences.enrollmentsEmpty')}
              description={t('sequences.enrollmentsEmptyHint')}
              actionLabel={canEnroll ? t('sequences.enroll') : undefined}
              onAction={canEnroll ? openEnroll : undefined}
            />
          )
        }
        renderItem={({ item }) => {
          const name = item.contact ? contactDisplayName(item.contact) : t('sequences.unknownContact');
          return (
            <Card style={styles.enrollCard}>
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
                <Badge label={t(ENROLLMENT_LABEL_KEYS[item.status])} variant={enrollmentStatusBadgeVariant(item.status)} />
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
                <Button
                  title={t('sequences.stop')}
                  variant="danger"
                  size="sm"
                  onPress={() => confirmUnenroll(item)}
                  disabled={unenroll.isPending}
                  style={styles.stopButton}
                />
              ) : null}
            </Card>
          );
        }}
      />

      {canEnroll ? (
        <Button
          title={t('sequences.enroll')}
          icon={<UserPlus size={18} color={colors.onAccent} strokeWidth={2.5} />}
          onPress={openEnroll}
          block
          style={styles.enrollButton}
        />
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
                  activeOpacity={0.7}
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
                  activeOpacity={0.7}
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
                  <View style={styles.skeletonGap}>
                    <SkeletonText lines={2} lastLineWidth="60%" />
                  </View>
                ) : templates.length === 0 ? (
                  <Text style={styles.fieldHint}>{t('sequences.noTemplates')}</Text>
                ) : (
                  templates.map((template) => (
                    <Card
                      key={template.id}
                      style={[
                        styles.templateRow,
                        stepTemplateId === template.id && styles.templateRowSelected,
                      ]}
                      onPress={() => setStepTemplateId(template.id)}
                      accessibilityLabel={template.name}
                    >
                      <Text style={styles.templateName}>{template.name}</Text>
                      <Text style={styles.templateSubject} numberOfLines={1}>{template.subject}</Text>
                    </Card>
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

              <Button
                title={t('sequences.saveStep')}
                onPress={submitStep}
                loading={addStep.isPending}
                block
                style={styles.primaryButtonWide}
              />
              <TouchableOpacity
                style={styles.modalClose}
                onPress={() => setStepModalOpen(false)}
                accessibilityRole="button"
                activeOpacity={0.7}
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
                    <ActivityIndicator color={colors.accent} style={styles.inlineLoader} />
                  ) : debouncedTerm.length < 2 ? (
                    <Text style={styles.fieldHint}>{t('sequences.enrollSearchHint')}</Text>
                  ) : contactsQuery.isPending ? (
                    <View style={styles.skeletonGap}>
                      <SkeletonText lines={3} lastLineWidth="55%" />
                    </View>
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
                      return (
                        <TouchableOpacity
                          key={contact.id}
                          style={styles.contactRow}
                          onPress={() => pickContact(contact)}
                          accessibilityRole="button"
                          activeOpacity={0.7}
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
                          <Badge label={t(badgeKey)} variant={blocked ? 'danger' : 'success'} />
                        </TouchableOpacity>
                      );
                    })
                  )}
                </ScrollView>

                <TouchableOpacity
                  style={styles.modalClose}
                  onPress={() => setEnrollOpen(false)}
                  accessibilityRole="button"
                  activeOpacity={0.7}
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
  content: { gap: spacing.md },
  skeletonGap: { marginTop: spacing.sm },
  noticeText: { color: c.textMuted, ...type.body, lineHeight: 20 },
  inlineLoader: { marginVertical: spacing.md },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xl },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headerTitle: { flex: 1, ...type.subtitle, color: c.text1 },
  headerDescription: { ...type.label, color: c.textMuted, lineHeight: 18, marginTop: spacing.sm },
  headerNote: { ...type.label, color: c.text1, lineHeight: 18, marginTop: spacing.sm },
  legalNote: { ...type.micro, color: c.textMuted, lineHeight: 16, marginTop: spacing.sm },
  hintText: { ...type.caption, color: c.textMuted, lineHeight: 17, marginTop: spacing.sm },
  actionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  flexButton: { flex: 1 },
  primaryButtonWide: { marginTop: spacing.lg },
  sectionTitle: { ...type.heading, color: c.text1, marginTop: spacing.xl, marginBottom: spacing.sm },
  stepCard: {
    marginBottom: spacing.sm,
  },
  stepHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: c.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBadgeText: { ...type.caption, color: c.accent },
  stepDelay: { flex: 1, ...type.caption, color: c.textMuted },
  stepControls: { flexDirection: 'row', gap: spacing.xs },
  iconButton: {
    width: 30,
    height: 30,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepSubject: { ...type.body, fontWeight: '600', color: c.text1, marginTop: spacing.sm },
  stepSource: { ...type.caption, color: c.textMuted, marginTop: spacing.xs },
  stepBody: { ...type.caption, color: c.textMuted, marginTop: spacing.xs, lineHeight: 17 },
  addStepButton: {
    borderWidth: 1,
    borderColor: c.accent,
    marginTop: spacing.xs,
  },
  enrollHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  enrollCount: { ...type.caption, color: c.textMuted, marginBottom: spacing.sm },
  enrollSkeletonWrap: { gap: spacing.sm },
  filters: { paddingVertical: spacing.xs, gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 1,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
  },
  chipActive: { backgroundColor: c.accent, borderColor: c.accent },
  chipText: { color: c.textMuted, ...type.caption },
  chipTextActive: { color: c.onAccent },
  enrollCard: {
    marginTop: spacing.sm,
  },
  enrollRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  enrollInfo: { flex: 1 },
  enrollName: { ...type.body, fontWeight: '600', color: c.text1 },
  enrollEmail: { ...type.caption, color: c.textMuted, marginTop: spacing.xs },
  enrollMeta: { ...type.caption, color: c.textMuted, marginTop: spacing.sm },
  stopButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
  },
  enrollButton: {
    margin: spacing.lg,
  },
  modalBackdrop: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: c.bgPanel,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: spacing.xl,
    maxHeight: '85%',
  },
  modalTitle: { ...type.subtitle, color: c.text1 },
  modalSubtitle: { ...type.caption, color: c.textMuted, marginTop: spacing.xs, marginBottom: spacing.sm, lineHeight: 17 },
  // React Native defaults flexShrink to 0 — without this the list overflows the sheet.
  modalScroll: { marginTop: spacing.sm, flexShrink: 1 },
  modalClose: { alignSelf: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.xl },
  modalCloseText: { color: c.textMuted, ...type.body },
  fieldLabel: { ...type.label, color: c.text1, marginTop: spacing.md, marginBottom: spacing.sm },
  fieldHint: { ...type.caption, color: c.textMuted, marginTop: spacing.sm, lineHeight: 17 },
  input: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...type.body,
    color: c.text1,
  },
  textArea: { minHeight: 120 },
  modeRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  modePill: {
    flex: 1,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  modePillActive: { backgroundColor: c.accent, borderColor: c.accent },
  modePillText: { ...type.label, color: c.text1 },
  modePillTextActive: { color: c.onAccent, fontWeight: '700' },
  templateRow: {
    marginTop: spacing.sm,
  },
  templateRowSelected: { borderColor: c.accent, backgroundColor: c.accentSoft },
  templateName: { ...type.body, fontWeight: '600', color: c.text1 },
  templateSubject: { ...type.caption, color: c.textMuted, marginTop: spacing.xs },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  contactName: { ...type.body, color: c.text1 },
  errorText: { color: c.danger, ...type.label, marginTop: spacing.sm, lineHeight: 18 },
});
