import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Text,
  TouchableOpacity,
  View,
}  from 'react-native';
import { StyleSheet } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react-native';
import { API_URL } from '../../utils/api';
import { useUserStore } from '../../store/userStore';
import { sendOrQueueMutation } from '../../utils/offlineMutation';
import { formatMarketDate, formatMoney } from '../../market/profile';
import AttachmentsSection from '../../components/AttachmentsSection';
import { useAuditLog } from '../../hooks/useAuditLog';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { Screen, Card, Button, Badge, EmptyState, Skeleton, SkeletonText } from '../../components/ui';
import type { BadgeVariant } from '../../components/ui';

interface Deal {
  id: string;
  title: string;
  value: number | null;
  currency: string | null;
  status: 'open' | 'won' | 'lost' | 'archived';
  source: string | null;
  lost_reason: string | null;
  contact: { id: string; first_name: string; last_name: string | null } | null;
  pipeline: { id: string; name: string } | null;
  stage: { id: string; name: string; position: number } | null;
  next_action: string | null;
  next_action_due: string | null;
}

interface DealApiResponse {
  data: Deal;
  meta: Record<string, unknown>;
}

interface ErrorApiResponse {
  error: { code: string; message: string };
}

function dealActionLabel(action: string): string {
  const map: Record<string, string> = {
    created: 'Создана',
    updated: 'Обновлена',
    archived: 'Архивирована',
    stage_changed: 'Этап изменён',
    won: 'Выиграна',
    lost: 'Проиграна',
  };
  return map[action] ?? action;
}

function dealActionVariant(action: string): BadgeVariant {
  if (action === 'created') return 'accent';
  if (action === 'won') return 'success';
  if (action === 'lost') return 'danger';
  return 'neutral';
}

function formatValue(value: number | null, _currency: string | null): string {
  return formatMoney(value, _currency, { empty: '—' });
}

function statusVariant(status: Deal['status']): BadgeVariant {
  if (status === 'won') return 'success';
  if (status === 'lost') return 'danger';
  if (status === 'archived') return 'neutral';
  return 'accent';
}

export default function DealDetailScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);

  const [deal, setDeal] = useState<Deal | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data: auditLog = [] } = useAuditLog('deal', id);

  const fetchDeal = useCallback(
    async (silent: boolean, signal?: AbortSignal): Promise<void> => {
      if (!silent) { setIsLoading(true); setError(null); }
      try {
        const res = await fetch(API_URL + '/deals/' + id, {
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          signal,
        });
        if (signal?.aborted) return;
        if (!res.ok) {
          const body = (await res.json()) as ErrorApiResponse;
          throw new Error(body.error?.message ?? t('deals.failedToLoad'));
        }
        const json = (await res.json()) as DealApiResponse;
        if (!signal?.aborted) { setDeal(json.data); setIsLoading(false); setIsRefreshing(false); }
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError') return;
        setError((err instanceof Error ? err.message : null) ?? t('deals.failedToLoad'));
        setIsLoading(false); setIsRefreshing(false);
      }
    },
    [id, token], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchDeal(false, controller.signal);
    return () => controller.abort();
  }, [fetchDeal]);

  const onRefresh = (): void => {
    setIsRefreshing(true);
    void fetchDeal(true);
  };

  const doMarkWon = async (): Promise<void> => {
    setIsActionLoading(true);
    setActionError(null);
    try {
      const result = await sendOrQueueMutation({
        url: API_URL + '/deals/' + id + '/won',
        method: 'POST',
        token: token ?? '',
        body: {},
      });
      if (result.queued) {
        router.back();
        return;
      }
      const res = result.response;
      if (!res.ok) {
        const body = (await res.json()) as ErrorApiResponse;
        throw new Error(body.error?.message ?? t('deals.failedToMarkWon'));
      }
      router.back();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('deals.failedToMarkWon');
      setActionError(message);
    } finally {
      setIsActionLoading(false);
    }
  };

  const doMarkLost = async (reason: string): Promise<void> => {
    setIsActionLoading(true);
    setActionError(null);
    try {
      const bodyPayload: { reason?: string } = reason ? { reason } : {};
      const result = await sendOrQueueMutation({
        url: API_URL + '/deals/' + id + '/lost',
        method: 'POST',
        token: token ?? '',
        body: bodyPayload,
      });
      if (result.queued) {
        router.back();
        return;
      }
      const res = result.response;
      if (!res.ok) {
        const resBody = (await res.json()) as ErrorApiResponse;
        throw new Error(resBody.error?.message ?? t('deals.failedToMarkLost'));
      }
      router.back();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('deals.failedToMarkLost');
      setActionError(message);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleWon = (): void => {
    doMarkWon().catch(() => undefined);
  };

  const handleLost = (): void => {
    if (typeof Alert.prompt === 'function') {
      Alert.prompt(
        t('deals.markLost'),
        t('deals.markLostPromptMessage'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('deals.markLost'),
            onPress: (text?: string): void => {
              doMarkLost(text ?? '').catch(() => undefined);
            },
          },
        ],
        'plain-text',
      );
    } else {
      doMarkLost('').catch(() => undefined);
    }
  };

  const screenTitle = isLoading || error !== null ? t('deals.deal') : (deal?.title ?? t('deals.deal'));

  if (isLoading) {
    return (
      <Screen contentContainerStyle={styles.contentPad}>
        <Stack.Screen options={{ title: t('deals.deal') }} />
        <Card style={styles.cardSpacing}>
          <Skeleton width="60%" height={26} style={styles.skeletonGapMd} />
          <Skeleton width="40%" height={22} style={styles.skeletonGapLg} />
          <View style={styles.badgeRow}>
            <Skeleton width={72} height={24} rounded={radius.pill} />
            <Skeleton width={64} height={24} rounded={radius.pill} />
          </View>
        </Card>
        <Card style={styles.cardSpacing}>
          <SkeletonText lines={2} lastLineWidth="70%" />
        </Card>
        <Card>
          <SkeletonText lines={3} lastLineWidth="50%" />
        </Card>
      </Screen>
    );
  }

  if (error !== null || deal === null) {
    return (
      <View style={styles.errorContainer}>
        <Stack.Screen options={{ title: t('deals.deal') }} />
        <EmptyState
          icon={<AlertCircle size={32} color={colors.danger} strokeWidth={2} />}
          title={error ?? t('deals.notFound')}
          actionLabel={t('common.retry')}
          onAction={() => fetchDeal(false)}
        />
      </View>
    );
  }

  return (
    <Screen
      refreshing={isRefreshing}
      onRefresh={onRefresh}
      contentContainerStyle={styles.contentPad}
    >
      <Stack.Screen
        options={{
          title: screenTitle,
          headerRight: () => (
            <TouchableOpacity
              style={styles.headerEditButton}
              onPress={() => router.push({ pathname: '/deal/edit/[id]', params: { id } })}
              activeOpacity={0.7}
            >
              <Text style={styles.headerEditText}>{t('common.edit')}</Text>
            </TouchableOpacity>
          ),
        }}
      />

      {/* Header card */}
      <Card style={styles.cardSpacing}>
        <Text style={styles.title}>{deal.title}</Text>
        <Text style={[styles.value, styles.tabular]}>{formatValue(deal.value, deal.currency)}</Text>
        <View style={styles.badgeRow}>
          {deal.stage !== null && (
            <Badge label={deal.stage.name} variant="neutral" />
          )}
          <Badge
            variant={statusVariant(deal.status)}
            label={{ open: t('deals.statusOpen'), won: t('deals.statusWon'), lost: t('deals.statusLost'), archived: t('deals.statusArchived') }[deal.status] ?? deal.status}
          />
        </View>
        {deal.pipeline !== null && (
          <Text style={styles.mutedText}>{deal.pipeline.name}</Text>
        )}
      </Card>

      {deal.next_action && (
        <Card style={styles.cardSpacing}>
          <Text style={styles.nextActionLabel}>{t('deals.nextAction')}</Text>
          <Text style={styles.nextActionText}>{deal.next_action}</Text>
          {deal.next_action_due && (
            <Text style={[styles.nextActionDue, styles.tabular]}>{formatMarketDate(deal.next_action_due)}</Text>
          )}
        </Card>
      )}

      {/* Contact card */}
      {deal.contact != null && (
        <Card style={styles.cardSpacing}>
          <Text style={styles.sectionLabel}>{t('deals.contact')}</Text>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() =>
              router.push({ pathname: '/contact/[id]', params: { id: deal.contact!.id } })
            }
          >
            <Text style={styles.linkText}>
              {deal.contact.first_name +
                (deal.contact.last_name !== null ? ' ' + deal.contact.last_name : '')}
            </Text>
          </TouchableOpacity>
        </Card>
      )}

      {/* Details card */}
      <Card style={styles.cardSpacing}>
        <Text style={styles.sectionLabel}>{t('deals.details')}</Text>
        {deal.source !== null && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('deals.source')}</Text>
            <Text style={styles.detailValue}>{deal.source}</Text>
          </View>
        )}
        {deal.lost_reason !== null && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('deals.lostReason')}</Text>
            <Text style={styles.detailValue}>{deal.lost_reason}</Text>
          </View>
        )}
        {deal.source === null && deal.lost_reason === null && (
          <Text style={styles.mutedText}>{t('deals.noDetails')}</Text>
        )}
      </Card>

      {/* Actions card - only when open */}
      {deal.status === 'open' && (
        <Card style={styles.cardSpacing}>
          {actionError !== null && (
            <Text style={styles.actionError}>{actionError}</Text>
          )}
          <View style={styles.actionStack}>
            <Button
              title={t('deals.markWon')}
              onPress={handleWon}
              loading={isActionLoading}
              disabled={isActionLoading}
              block
            />
            <Button
              title={t('deals.markLost')}
              onPress={handleLost}
              loading={isActionLoading}
              disabled={isActionLoading}
              variant="danger"
              block
            />
          </View>
        </Card>
      )}

      {/* Activity log */}
      <Card>
        <Text style={styles.sectionLabel}>{t('contacts.activityLog')}</Text>
        {auditLog.length === 0 ? (
          <EmptyState title={t('contacts.noActivity')} style={styles.auditEmpty} />
        ) : (
          auditLog.map((entry) => (
            <View key={entry.id} style={styles.auditRow}>
              <Badge label={dealActionLabel(entry.action)} variant={dealActionVariant(entry.action)} />
              <Text style={[styles.auditDate, styles.tabular]}>{new Date(entry.created_at).toLocaleDateString('ru-RU')}</Text>
            </View>
          ))
        )}
      </Card>

      <AttachmentsSection entityType="deal" entityId={id as string} />
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  contentPad: {
    paddingTop: spacing.lg,
  },
  cardSpacing: {
    marginBottom: spacing.lg,
  },
  skeletonGapMd: {
    marginBottom: spacing.sm,
  },
  skeletonGapLg: {
    marginBottom: spacing.md,
  },
  title: {
    ...type.title,
    color: c.text1,
    marginBottom: spacing.sm,
  },
  value: {
    ...type.subtitle,
    color: c.text1,
    marginBottom: spacing.md,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  mutedText: {
    ...type.body,
    color: c.textMuted,
  },
  nextActionLabel: {
    ...type.label,
    color: c.accent,
    marginBottom: spacing.sm,
  },
  nextActionText: {
    ...type.body,
    color: c.text1,
  },
  nextActionDue: {
    ...type.caption,
    color: c.textMuted,
    marginTop: spacing.sm,
  },
  sectionLabel: {
    ...type.micro,
    color: c.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },
  linkText: {
    ...type.body,
    color: c.accent,
    fontWeight: '600',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  detailLabel: {
    ...type.body,
    color: c.textMuted,
  },
  detailValue: {
    ...type.body,
    color: c.text1,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
  actionStack: {
    gap: spacing.sm,
  },
  actionError: {
    ...type.caption,
    color: c.danger,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: c.bg,
  },
  auditEmpty: {
    paddingVertical: spacing.md,
    paddingHorizontal: 0,
  },
  auditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  auditDate: {
    ...type.caption,
    color: c.textMuted,
  },
  headerEditButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  headerEditText: {
    color: c.accent,
    ...type.heading,
  },
});
