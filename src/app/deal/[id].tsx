import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
}  from 'react-native';
import type { DimensionValue } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { API_URL } from '../../utils/api';
import { useUserStore } from '../../store/userStore';
import { sendOrQueueMutation } from '../../utils/offlineMutation';
import { formatMarketDate, formatMoney } from '../../market/profile';
import AttachmentsSection from '../../components/AttachmentsSection';

const TEAL = '#C45A10';

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

interface SkeletonBoxProps {
  width: DimensionValue;
  height: number;
  borderRadius?: number;
  marginBottom?: number;
}

interface AuditEntry {
  id: string;
  action: string;
  created_at: string;
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

function dealActionColor(action: string): { bg: string; text: string } {
  if (action === 'created') return { bg: '#FEF0E8', text: '#C45A10' };
  if (action === 'won') return { bg: '#dcfce7', text: '#16a34a' };
  if (action === 'lost') return { bg: '#fee2e2', text: '#dc2626' };
  if (action === 'stage_changed') return { bg: '#dbeafe', text: '#1d4ed8' };
  return { bg: '#FAF6F3', text: '#383432' };
}

function SkeletonBox({ width, height, borderRadius = 4, marginBottom = 0 }: SkeletonBoxProps): JSX.Element {
  return <View style={{ width, height, backgroundColor: '#FEF0E8', borderRadius, marginBottom }} />;
}

function formatValue(value: number | null, _currency: string | null): string {
  return formatMoney(value, _currency, { empty: '—' });
}

function getStatusColor(status: Deal['status']): string {
  if (status === 'lost') return '#ef4444';
  if (status === 'archived') return '#CFADA3';
  return '#C4704F';
}

export default function DealDetailScreen(): JSX.Element {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);

  const [deal, setDeal] = useState<Deal | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);

  const fetchDeal = useCallback(
    (silent: boolean): void => {
      if (!silent) {
        setIsLoading(true);
        setError(null);
      }
      const url = API_URL + '/deals/' + id;
      fetch(url, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
      })
        .then((res) => {
          if (!res.ok) {
            return res.json().then((body: ErrorApiResponse) => {
              throw new Error(body.error?.message ?? t('deals.failedToLoad'));
            });
          }
          return res.json() as Promise<DealApiResponse>;
        })
        .then((json) => {
          setDeal(json.data);
          setIsLoading(false);
          setIsRefreshing(false);
        })
        .catch((err: Error) => {
          setError(err.message ?? t('deals.failedToLoad'));
          setIsLoading(false);
          setIsRefreshing(false);
        });
    },
    [id, token],
  );

  const fetchAuditLog = useCallback(async (): Promise<void> => {
    if (!token || !id) return;
    try {
      const res = await fetch(`${API_URL}/activities?entity_type=deal&entity_id=${id}`, {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { data: AuditEntry[] };
      setAuditLog(body.data);
    } catch { /* silent */ }
  }, [id, token]);

  useEffect(() => {
    fetchDeal(false);
    void fetchAuditLog();
  }, [fetchDeal, fetchAuditLog]);

  const onRefresh = (): void => {
    setIsRefreshing(true);
    fetchDeal(true);
    void fetchAuditLog();
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
      <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: 16 }}>
        <Stack.Screen options={{ title: t('deals.deal') }} />
        <View style={styles.skeletonCard}>
          <SkeletonBox width={'60%'} height={22} marginBottom={12} />
          <SkeletonBox width={'40%'} height={18} marginBottom={12} />
          <SkeletonBox width={'80%'} height={14} />
        </View>
        <View style={styles.skeletonCard}>
          <SkeletonBox width={'30%'} height={12} marginBottom={10} />
          <SkeletonBox width={'50%'} height={16} />
        </View>
        <View style={styles.skeletonCard}>
          <SkeletonBox width={'30%'} height={12} marginBottom={10} />
          <SkeletonBox width={'70%'} height={14} marginBottom={8} />
          <SkeletonBox width={'60%'} height={14} />
        </View>
      </ScrollView>
    );
  }

  if (error !== null || deal === null) {
    return (
      <View style={styles.errorContainer}>
        <Stack.Screen options={{ title: t('deals.deal') }} />
        <Text style={styles.errorText}>{error ?? t('deals.notFound')}</Text>
        <TouchableOpacity onPress={() => fetchDeal(false)}>
          <Text style={styles.retryText}>{t('common.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: 16, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />}
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
      <View style={styles.card}>
        <Text style={styles.title}>{deal.title}</Text>
        <Text style={styles.value}>{formatValue(deal.value, deal.currency)}</Text>
        <View style={styles.badgeRow}>
          {deal.stage !== null && (
            <View style={[styles.badge, { backgroundColor: '#C4704F' }]}>
              <Text style={styles.badgeText}>{deal.stage.name}</Text>
            </View>
          )}
          <View style={[styles.badge, { backgroundColor: getStatusColor(deal.status) }]}>
            <Text style={styles.badgeText}>
              {{ open: t('deals.statusOpen'), won: t('deals.statusWon'), lost: t('deals.statusLost'), archived: t('deals.statusArchived') }[deal.status] ?? deal.status}
            </Text>
          </View>
        </View>
        {deal.pipeline !== null && (
          <Text style={styles.mutedText}>{deal.pipeline.name}</Text>
        )}
      </View>

      {deal.next_action && (
        <View style={styles.card}>
          <Text style={styles.nextActionLabel}>{t('deals.nextAction')}</Text>
          <Text style={styles.nextActionText}>{deal.next_action}</Text>
          {deal.next_action_due && (
            <Text style={styles.nextActionDue}>{formatMarketDate(deal.next_action_due)}</Text>
          )}
        </View>
      )}

      {/* Contact card */}
      {deal.contact != null && (
        <View style={styles.card}>
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
        </View>
      )}

      {/* Details card */}
      <View style={styles.card}>
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
      </View>

      {/* Actions card - only when open */}
      {deal.status === 'open' && (
        <View style={styles.card}>
          {actionError !== null && (
            <Text style={styles.actionError}>{actionError}</Text>
          )}
          <TouchableOpacity
            style={[
              styles.button,
              styles.buttonPrimary,
              isActionLoading ? styles.buttonDisabled : null,
            ]}
            onPress={handleWon}
            disabled={isActionLoading}
          >
            {isActionLoading ? (
              <ActivityIndicator color={'#fff'} />
            ) : (
              <Text style={styles.buttonText}>{t('deals.markWon')}</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.button,
              styles.buttonDestructive,
              isActionLoading ? styles.buttonDisabled : null,
            ]}
            onPress={handleLost}
            disabled={isActionLoading}
          >
            {isActionLoading ? (
              <ActivityIndicator color={'#fff'} />
            ) : (
              <Text style={styles.buttonText}>{t('deals.markLost')}</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
      {/* Activity log */}
      <View style={styles.auditSection}>
        <Text style={styles.auditSectionTitle}>{t('contacts.activityLog')}</Text>
        {auditLog.length === 0 ? (
          <Text style={styles.auditEmpty}>{t('contacts.noActivity')}</Text>
        ) : (
          auditLog.map((entry) => {
            const colors = dealActionColor(entry.action);
            return (
              <View key={entry.id} style={styles.auditRow}>
                <View style={[styles.auditBadge, { backgroundColor: colors.bg }]}>
                  <Text style={[styles.auditBadgeText, { color: colors.text }]}>{dealActionLabel(entry.action)}</Text>
                </View>
                <Text style={styles.auditDate}>{new Date(entry.created_at).toLocaleDateString('ru-RU')}</Text>
              </View>
            );
          })
        )}
      </View>

      <AttachmentsSection entityType="deal" entityId={id as string} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FEF0E8',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  skeletonCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    height: 120,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#383432',
    marginBottom: 8,
  },
  value: {
    fontSize: 18,
    fontWeight: '600',
    color: '#383432',
    marginBottom: 12,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  mutedText: {
    fontSize: 13,
    color: '#B07868',
  },
  nextActionLabel: {
    color: TEAL,
    fontWeight: '600',
    fontSize: 13,
    marginBottom: 6,
  },
  nextActionText: {
    color: '#383432',
    fontSize: 15,
    fontWeight: '500',
  },
  nextActionDue: {
    color: '#B07868',
    fontSize: 13,
    marginTop: 6,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#B07868',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  linkText: {
    fontSize: 15,
    color: '#C4704F',
    fontWeight: '500',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  detailLabel: {
    fontSize: 14,
    color: '#B07868',
  },
  detailValue: {
    fontSize: 14,
    color: '#383432',
    fontWeight: '500',
    flexShrink: 1,
    textAlign: 'right',
  },
  button: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  buttonPrimary: {
    backgroundColor: '#C4704F',
  },
  buttonDestructive: {
    backgroundColor: '#ef4444',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  actionError: {
    color: '#ef4444',
    fontSize: 13,
    marginBottom: 10,
    textAlign: 'center',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FEF0E8',
    padding: 24,
  },
  errorText: {
    fontSize: 15,
    color: '#ef4444',
    textAlign: 'center',
    marginBottom: 16,
  },
  retryText: {
    fontSize: 15,
    color: '#C4704F',
    fontWeight: '600',
  },
  auditSection: {
    marginHorizontal: 16,
    marginBottom: 16,
  },
  auditSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#B07868',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  auditEmpty: {
    fontSize: 13,
    color: '#CFADA3',
  },
  auditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#FAF6F3',
  },
  auditBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  auditBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  auditDate: {
    fontSize: 12,
    color: '#CFADA3',
  },
  headerEditButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  headerEditText: {
    color: '#C4704F',
    fontSize: 16,
    fontWeight: '600',
  },
});
