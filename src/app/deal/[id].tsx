﻿
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
import { API_URL } from '../../utils/api';
import { useUserStore } from '../../store/userStore';
import { sendOrQueueMutation } from '../../utils/offlineMutation';

const TEAL = '#065f46';

interface Deal {
  id: string;
  title: string;
  value: number | null;
  currency: string | null;
  status: 'open' | 'won' | 'lost' | 'archived';
  source: string | null;
  lost_reason: string | null;
  contact: { id: string; first_name: string; last_name: string | null };
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

interface DealApiResponse {
  data: Deal;
  meta: Record<string, unknown>;
}

interface ErrorApiResponse {
  error: { code: string; message: string };
}

function SkeletonBox({ width, height, borderRadius = 4, marginBottom = 0 }: SkeletonBoxProps): JSX.Element {
  return <View style={{ width, height, backgroundColor: '#d1fae5', borderRadius, marginBottom }} />;
}

function formatValue(value: number | null, _currency: string | null): string {
  if (value === null) return '—';
  return '$' + value.toLocaleString('en-US');
}

function getStatusColor(status: Deal['status']): string {
  if (status === 'lost') return '#ef4444';
  if (status === 'archived') return '#9ca3af';
  return '#34A853';
}

export default function DealDetailScreen(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);

  const [deal, setDeal] = useState<Deal | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

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
              throw new Error(body.error?.message ?? 'Failed to load deal');
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
          setError(err.message ?? 'An error occurred');
          setIsLoading(false);
          setIsRefreshing(false);
        });
    },
    [id, token],
  );

  useEffect(() => {
    fetchDeal(false);
  }, [fetchDeal]);

  const onRefresh = (): void => {
    setIsRefreshing(true);
    fetchDeal(true);
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
        throw new Error(body.error?.message ?? 'Failed to mark deal as won');
      }
      router.back();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An error occurred';
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
        throw new Error(resBody.error?.message ?? 'Failed to mark deal as lost');
      }
      router.back();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An error occurred';
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
        'Mark Lost',
        'Enter reason (optional):',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Mark Lost',
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

  const screenTitle = isLoading || error !== null ? 'Deal' : (deal?.title ?? 'Deal');

  if (isLoading) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: 16 }}>
        <Stack.Screen options={{ title: 'Deal', headerBackTitle: 'Deals' }} />
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
        <Stack.Screen options={{ title: 'Deal', headerBackTitle: 'Deals' }} />
        <Text style={styles.errorText}>{error ?? 'Deal not found'}</Text>
        <TouchableOpacity onPress={() => fetchDeal(false)}>
          <Text style={styles.retryText}>Retry</Text>
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
          headerBackTitle: 'Deals',
          headerRight: () => (
            <TouchableOpacity
              style={styles.headerEditButton}
              onPress={() => router.push({ pathname: '/deal/edit/[id]', params: { id } })}
              activeOpacity={0.7}
            >
              <Text style={styles.headerEditText}>Edit</Text>
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
            <View style={[styles.badge, { backgroundColor: '#10b981' }]}>
              <Text style={styles.badgeText}>{deal.stage.name}</Text>
            </View>
          )}
          <View style={[styles.badge, { backgroundColor: getStatusColor(deal.status) }]}>
            <Text style={styles.badgeText}>{deal.status}</Text>
          </View>
        </View>
        {deal.pipeline !== null && (
          <Text style={styles.mutedText}>{deal.pipeline.name}</Text>
        )}
      </View>

      {deal.next_action && (
        <View style={styles.card}>
          <Text style={styles.nextActionLabel}>Next Action</Text>
          <Text style={styles.nextActionText}>{deal.next_action}</Text>
          {deal.next_action_due && (
            <Text style={styles.nextActionDue}>{new Date(deal.next_action_due).toLocaleDateString()}</Text>
          )}
        </View>
      )}

      {/* Contact card */}
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>CONTACT</Text>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() =>
            router.push({ pathname: '/contact/[id]', params: { id: deal.contact.id } })
          }
        >
          <Text style={styles.linkText}>
            {deal.contact.first_name +
              (deal.contact.last_name !== null ? ' ' + deal.contact.last_name : '')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Details card */}
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>DETAILS</Text>
        {deal.source !== null && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Source</Text>
            <Text style={styles.detailValue}>{deal.source}</Text>
          </View>
        )}
        {deal.lost_reason !== null && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Lost reason</Text>
            <Text style={styles.detailValue}>{deal.lost_reason}</Text>
          </View>
        )}
        {deal.source === null && deal.lost_reason === null && (
          <Text style={styles.mutedText}>No additional details</Text>
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
              <Text style={styles.buttonText}>Mark Won</Text>
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
              <Text style={styles.buttonText}>Mark Lost</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0fdf8',
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
    color: '#111827',
    marginBottom: 8,
  },
  value: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
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
    color: '#6b7280',
  },
  nextActionLabel: {
    color: TEAL,
    fontWeight: '600',
    fontSize: 13,
    marginBottom: 6,
  },
  nextActionText: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '500',
  },
  nextActionDue: {
    color: '#6b7280',
    fontSize: 13,
    marginTop: 6,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6b7280',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  linkText: {
    fontSize: 15,
    color: '#10b981',
    fontWeight: '500',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  detailLabel: {
    fontSize: 14,
    color: '#6b7280',
  },
  detailValue: {
    fontSize: 14,
    color: '#111827',
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
    backgroundColor: '#10b981',
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
    backgroundColor: '#f0fdf8',
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
    color: '#10b981',
    fontWeight: '600',
  },
  headerEditButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  headerEditText: {
    color: '#10b981',
    fontSize: 16,
    fontWeight: '600',
  },
});
