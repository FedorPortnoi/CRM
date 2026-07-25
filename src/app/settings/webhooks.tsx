// Webhooks settings screen — owner/admin only.
// Backend: /api/v1/webhooks (list/create/update/pause/resume/rotate-secret/delete/deliveries)
//          GET /api/v1/webhooks/events for the event catalogue.
// i18n:    webhooks.* (+ common.*)
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '../../store/userStore';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';
import { API_URL } from '../../utils/api';
import { formatMarketDateTime, formatMarketNumber } from '../../market/profile';

type WebhookStatus = 'active' | 'paused';
type DeliveryStatus = 'pending' | 'success' | 'failed';

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  status: WebhookStatus;
  failure_count: number;
  last_delivery_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface CreatedWebhookEndpoint extends WebhookEndpoint {
  secret: string;
}

interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event_type: string;
  status: DeliveryStatus;
  attempts: number;
  response_status: number | null;
  error_message: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

interface Envelope<T> {
  data?: T;
  meta?: { total?: number; page?: number; per_page?: number };
  error?: { code?: string; message?: string };
}

// The backend's messages are English server strings; the screen renders i18n copy keyed
// off the error CODE instead, so nothing user-visible bypasses the locale files.
class ApiError extends Error {
  readonly code: string | null;

  constructor(code: string | null, status: number) {
    super(code ?? `status ${status}`);
    this.name = 'ApiError';
    this.code = code;
  }
}

// Mirrors backend/services/webhooks.ts WEBHOOK_EVENTS. Only a fallback: the live
// catalogue comes from GET /webhooks/events.
const FALLBACK_EVENTS = [
  'contact.created',
  'contact.updated',
  'deal.created',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'task.created',
  'task.completed',
] as const;

const DELIVERY_PAGE_SIZE = 25;
const MAX_DELIVERY_LIMIT = 100; // backend caps per_page at 100
const MAX_URL_LENGTH = 2000;

const DELIVERY_FILTERS: readonly (DeliveryStatus | 'all')[] = ['all', 'pending', 'success', 'failed'];

const DELIVERY_STATUS_KEY: Record<DeliveryStatus, string> = {
  pending: 'webhooks.deliveryPending',
  success: 'webhooks.deliverySuccess',
  failed: 'webhooks.deliveryFailed',
};

// `secret` comes back only from POST / and POST /:id/rotate-secret.
function hasSecret(endpoint: WebhookEndpoint): endpoint is CreatedWebhookEndpoint {
  return typeof (endpoint as CreatedWebhookEndpoint).secret === 'string';
}

type UrlCheck = 'ok' | 'required' | 'unsafe';

// React Native's global URL is a stub with no protocol/hostname getters, so parsing is
// done by hand. This is a fail-fast convenience only — backend/services/webhook-ssrf.ts
// is the real gate (DNS resolution, every answer checked, address pinned).
const HTTPS_URL_RE = /^https:\/\/(?:[^\s/?#@]*@)?([^\s/?#@:]+)(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv4(host: string): boolean {
  const match = IPV4_RE.exec(host);
  if (!match) return false;

  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) return true;

  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function checkWebhookUrl(raw: string): UrlCheck {
  const value = raw.trim();
  if (value.length === 0) return 'required';
  if (value.length > MAX_URL_LENGTH) return 'unsafe';

  const match = HTTPS_URL_RE.exec(value);
  if (!match) return 'unsafe';

  const host = match[1].toLowerCase();
  if (isPrivateIpv4(host)) return 'unsafe';
  if (!host.includes('.')) return 'unsafe';
  if (host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal')) return 'unsafe';
  return 'ok';
}

export default function WebhooksScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const role = useUserStore((s) => s.user?.role);
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const canManage = role === 'owner' || role === 'admin';

  const [formVisible, setFormVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formUrl, setFormUrl] = useState('');
  const [formEvents, setFormEvents] = useState<string[]>([]);
  const [formActive, setFormActive] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  const [revealedSecret, setRevealedSecret] = useState<{ url: string; secret: string } | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  const [logEndpoint, setLogEndpoint] = useState<WebhookEndpoint | null>(null);
  const [logFilter, setLogFilter] = useState<DeliveryStatus | 'all'>('all');
  const [logLimit, setLogLimit] = useState(DELIVERY_PAGE_SIZE);

  // The token is part of every key so the persisted plaintext query cache drops these
  // rows (see the JWT_SHAPE guard in src/utils/queryClient.ts).
  const request = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${API_URL}/webhooks${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token ?? ''}`,
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });

    let body: Envelope<T> | null = null;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch {
      body = null;
    }

    if (!res.ok) throw new ApiError(body?.error?.code ?? null, res.status);
    if (!body || body.data === undefined) throw new ApiError(null, res.status);
    return body.data;
  }, [token]);

  const endpointsQuery = useQuery<WebhookEndpoint[], Error>({
    queryKey: ['webhooks', token],
    queryFn: () => request<WebhookEndpoint[]>('/'),
    enabled: !!token && canManage,
  });

  const eventsQuery = useQuery<string[], Error>({
    queryKey: ['webhook-events', token],
    queryFn: () => request<string[]>('/events'),
    enabled: !!token && canManage,
    staleTime: Infinity,
  });

  const deliveriesQuery = useQuery<{ items: WebhookDelivery[]; total: number }, Error>({
    queryKey: ['webhook-deliveries', logEndpoint?.id ?? null, logFilter, logLimit, token],
    queryFn: async () => {
      const params = new URLSearchParams({ page: '1', per_page: String(logLimit) });
      if (logFilter !== 'all') params.append('status', logFilter);
      const res = await fetch(
        `${API_URL}/webhooks/${logEndpoint?.id ?? ''}/deliveries?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token ?? ''}` } },
      );

      let body: Envelope<WebhookDelivery[]> | null = null;
      try {
        body = (await res.json()) as Envelope<WebhookDelivery[]>;
      } catch {
        body = null;
      }

      if (!res.ok) throw new ApiError(body?.error?.code ?? null, res.status);
      if (!body || body.data === undefined) throw new ApiError(null, res.status);
      return { items: body.data, total: body.meta?.total ?? body.data.length };
    },
    enabled: !!token && canManage && logEndpoint !== null,
    staleTime: 0,
  });

  const availableEvents = useMemo<string[]>(
    () => (eventsQuery.data && eventsQuery.data.length > 0 ? eventsQuery.data : [...FALLBACK_EVENTS]),
    [eventsQuery.data],
  );

  const eventLabel = useCallback((event: string): string => {
    const key = `webhooks.event_${event.replace(/\./g, '_')}`;
    const label = t(key);
    return label === key ? event : label;
  }, [t]);

  const messageFor = useCallback((error: unknown, fallbackKey: string): string => {
    if (error instanceof ApiError) {
      if (error.code === 'UNSAFE_WEBHOOK_URL') return t('webhooks.urlUnsafe');
      if (error.code === 'WEBHOOK_ENDPOINT_LIMIT_REACHED') return t('webhooks.limitReached');
      if (error.code === 'FORBIDDEN') return t('webhooks.adminOnly');
      if (error.code === 'UNAUTHORIZED') return t('errors.unauthorized');
    }
    return t(fallbackKey);
  }, [t]);

  const invalidateEndpoints = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['webhooks'] });
  }, [queryClient]);

  const closeForm = useCallback((): void => {
    setFormVisible(false);
    setEditingId(null);
    setFormUrl('');
    setFormEvents([]);
    setFormActive(true);
    setFormError(null);
  }, []);

  const saveMutation = useMutation({
    mutationFn: async (input: { id: string | null; url: string; events: string[]; status: WebhookStatus }) => {
      const payload = JSON.stringify({ url: input.url, events: input.events, status: input.status });
      return input.id === null
        ? request<CreatedWebhookEndpoint>('/', { method: 'POST', body: payload })
        : request<WebhookEndpoint>(`/${input.id}`, { method: 'PATCH', body: payload });
    },
    onSuccess: (endpoint, input) => {
      invalidateEndpoints();
      closeForm();
      if (input.id === null && hasSecret(endpoint)) {
        setSecretCopied(false);
        setRevealedSecret({ url: endpoint.url, secret: endpoint.secret });
      }
    },
    onError: (error: unknown) => setFormError(messageFor(error, 'webhooks.failedToSave')),
  });

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; next: WebhookStatus }) =>
      request<WebhookEndpoint>(`/${input.id}/${input.next === 'active' ? 'resume' : 'pause'}`, { method: 'POST' }),
    onSuccess: invalidateEndpoints,
    onError: (error: unknown) => Alert.alert(messageFor(error, 'webhooks.failedToSave')),
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => request<CreatedWebhookEndpoint>(`/${id}/rotate-secret`, { method: 'POST' }),
    onSuccess: (endpoint) => {
      invalidateEndpoints();
      setSecretCopied(false);
      setRevealedSecret({ url: endpoint.url, secret: endpoint.secret });
    },
    onError: (error: unknown) => Alert.alert(messageFor(error, 'webhooks.failedToRotate')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => request<{ id: string }>(`/${id}`, { method: 'DELETE' }),
    onSuccess: (_deleted, id) => {
      invalidateEndpoints();
      setLogEndpoint((current) => (current?.id === id ? null : current));
    },
    onError: (error: unknown) => Alert.alert(messageFor(error, 'webhooks.failedToDelete')),
  });

  const openCreate = useCallback((): void => {
    setEditingId(null);
    setFormUrl('');
    setFormEvents([]);
    setFormActive(true);
    setFormError(null);
    setFormVisible(true);
  }, []);

  const openEdit = useCallback((endpoint: WebhookEndpoint): void => {
    setEditingId(endpoint.id);
    setFormUrl(endpoint.url);
    setFormEvents([...endpoint.events]);
    setFormActive(endpoint.status === 'active');
    setFormError(null);
    setFormVisible(true);
  }, []);

  const toggleFormEvent = useCallback((event: string): void => {
    setFormEvents((current) =>
      current.includes(event) ? current.filter((name) => name !== event) : [...current, event],
    );
    setFormError(null);
  }, []);

  const submitForm = useCallback((): void => {
    const url = formUrl.trim();
    const check = checkWebhookUrl(url);
    if (check === 'required') {
      setFormError(t('webhooks.urlRequired'));
      return;
    }
    if (check === 'unsafe') {
      setFormError(t('webhooks.urlUnsafe'));
      return;
    }
    if (formEvents.length === 0) {
      setFormError(t('webhooks.eventsRequired'));
      return;
    }

    saveMutation.mutate({
      id: editingId,
      url,
      events: formEvents,
      status: formActive ? 'active' : 'paused',
    });
  }, [editingId, formActive, formEvents, formUrl, saveMutation, t]);

  const confirmDelete = useCallback((endpoint: WebhookEndpoint): void => {
    Alert.alert(
      t('webhooks.deleteConfirmTitle'),
      t('webhooks.deleteConfirmBody', { url: endpoint.url }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('webhooks.delete'), style: 'destructive', onPress: () => deleteMutation.mutate(endpoint.id) },
      ],
    );
  }, [deleteMutation, t]);

  const confirmRotate = useCallback((endpoint: WebhookEndpoint): void => {
    Alert.alert(
      t('webhooks.rotateConfirmTitle'),
      t('webhooks.rotateConfirmBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('webhooks.rotateSecret'), onPress: () => rotateMutation.mutate(endpoint.id) },
      ],
    );
  }, [rotateMutation, t]);

  const openLog = useCallback((endpoint: WebhookEndpoint): void => {
    setLogFilter('all');
    setLogLimit(DELIVERY_PAGE_SIZE);
    setLogEndpoint(endpoint);
  }, []);

  const copySecret = useCallback((): void => {
    if (!revealedSecret) return;
    Clipboard.setString(revealedSecret.secret);
    setSecretCopied(true);
  }, [revealedSecret]);

  if (!canManage) {
    return (
      <View style={styles.wrapper}>
        <Stack.Screen options={{ title: t('webhooks.title') }} />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.pageTitle}>{t('webhooks.title')}</Text>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('webhooks.adminOnly')}</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  const endpoints = endpointsQuery.data ?? [];
  const limitReached = endpoints.length >= 10;
  const deliveries = deliveriesQuery.data?.items ?? [];
  const deliveriesTotal = deliveriesQuery.data?.total ?? 0;
  const canLoadMoreDeliveries = logLimit < MAX_DELIVERY_LIMIT && deliveries.length < deliveriesTotal;

  return (
    <View style={styles.wrapper}>
      <Stack.Screen options={{ title: t('webhooks.title') }} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={endpointsQuery.isFetching && !endpointsQuery.isLoading}
            onRefresh={() => { void endpointsQuery.refetch(); }}
            tintColor={colors.orange}
          />
        }
      >
        <Text style={styles.pageTitle}>{t('webhooks.title')}</Text>
        <Text style={styles.pageSubtitle}>{t('webhooks.subtitle')}</Text>

        {endpointsQuery.isLoading ? (
          <View style={styles.stateCard}>
            <ActivityIndicator color={colors.orange} />
          </View>
        ) : endpointsQuery.error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{messageFor(endpointsQuery.error, 'webhooks.failedToLoad')}</Text>
            <TouchableOpacity onPress={() => { void endpointsQuery.refetch(); }} accessibilityRole="button">
              <Text style={styles.linkText}>{t('common.retry')}</Text>
            </TouchableOpacity>
          </View>
        ) : endpoints.length === 0 ? (
          <View style={styles.stateCard}>
            <Text style={styles.cardTitle}>{t('webhooks.empty')}</Text>
            <Text style={styles.cardText}>{t('webhooks.emptyHint')}</Text>
          </View>
        ) : (
          endpoints.map((endpoint) => {
            const isBusy =
              (statusMutation.isPending && statusMutation.variables?.id === endpoint.id)
              || (rotateMutation.isPending && rotateMutation.variables === endpoint.id)
              || (deleteMutation.isPending && deleteMutation.variables === endpoint.id);
            const isActive = endpoint.status === 'active';

            return (
              <View key={endpoint.id} style={[styles.card, isBusy && styles.cardBusy]}>
                <View style={styles.cardHeader}>
                  <Text style={styles.endpointUrl} numberOfLines={2} selectable>{endpoint.url}</Text>
                  <View style={[styles.badge, isActive ? styles.badgeActive : styles.badgePaused]}>
                    <Text style={[styles.badgeText, isActive ? styles.badgeTextActive : styles.badgeTextPaused]}>
                      {isActive ? t('webhooks.statusActive') : t('webhooks.statusPaused')}
                    </Text>
                  </View>
                </View>

                <View style={styles.chipWrap}>
                  {endpoint.events.map((event) => (
                    <View key={event} style={styles.chip}>
                      <Text style={styles.chipText}>{eventLabel(event)}</Text>
                    </View>
                  ))}
                </View>
                <Text style={styles.metaText}>{t('webhooks.eventsCount', { count: endpoint.events.length })}</Text>

                <Text style={styles.metaText}>
                  {endpoint.last_delivery_at
                    ? `${t('webhooks.lastDelivery')}: ${formatMarketDateTime(endpoint.last_delivery_at)}`
                    : t('webhooks.neverDelivered')}
                </Text>

                {endpoint.failure_count > 0 ? (
                  <Text style={styles.failureText}>
                    {t('webhooks.failureCount', { count: endpoint.failure_count })}
                  </Text>
                ) : null}
                {!isActive && endpoint.failure_count > 0 ? (
                  <Text style={styles.failureText}>{t('webhooks.pausedAfterFailures')}</Text>
                ) : null}

                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.outlineBtn}
                    onPress={() => openLog(endpoint)}
                    disabled={isBusy}
                    accessibilityRole="button"
                  >
                    <Text style={styles.outlineBtnText}>{t('webhooks.deliveries')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.outlineBtn}
                    onPress={() => openEdit(endpoint)}
                    disabled={isBusy}
                    accessibilityRole="button"
                  >
                    <Text style={styles.outlineBtnText}>{t('common.edit')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.outlineBtn}
                    onPress={() => statusMutation.mutate({ id: endpoint.id, next: isActive ? 'paused' : 'active' })}
                    disabled={isBusy}
                    accessibilityRole="button"
                  >
                    <Text style={styles.outlineBtnText}>
                      {isActive ? t('webhooks.pause') : t('webhooks.resume')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.outlineBtn}
                    onPress={() => confirmRotate(endpoint)}
                    disabled={isBusy}
                    accessibilityRole="button"
                  >
                    <Text style={styles.outlineBtnText}>{t('webhooks.rotateSecret')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.outlineBtn, styles.dangerBtn]}
                    onPress={() => confirmDelete(endpoint)}
                    disabled={isBusy}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.outlineBtnText, styles.dangerBtnText]}>{t('webhooks.delete')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}

        <TouchableOpacity
          style={[styles.primaryBtn, limitReached && styles.btnDisabled]}
          onPress={openCreate}
          disabled={limitReached}
          accessibilityRole="button"
          accessibilityState={{ disabled: limitReached }}
        >
          <Text style={styles.primaryBtnText}>{t('webhooks.add')}</Text>
        </TouchableOpacity>
        {limitReached ? <Text style={styles.hintText}>{t('webhooks.limitReached')}</Text> : null}

        <Text style={styles.hintText}>{t('webhooks.signatureHint')}</Text>
        <Text style={styles.hintText}>{t('webhooks.retryHint')}</Text>
      </ScrollView>

      {/* Create / edit */}
      <Modal visible={formVisible} transparent animationType="fade" onRequestClose={closeForm}>
        <View style={styles.overlay}>
          <View style={[styles.modalCard, styles.modalCardTall]}>
            <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>
                {editingId === null ? t('webhooks.add') : t('webhooks.edit')}
              </Text>

              <Text style={styles.label}>{t('webhooks.url')}</Text>
              <TextInput
                style={styles.input}
                value={formUrl}
                onChangeText={(value) => { setFormUrl(value); setFormError(null); }}
                placeholder={t('webhooks.urlPlaceholder')}
                placeholderTextColor={colors.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                maxLength={MAX_URL_LENGTH}
                editable={!saveMutation.isPending}
                accessibilityLabel={t('webhooks.url')}
              />

              <View style={styles.switchRow}>
                <Text style={styles.labelInline}>{t('webhooks.status')}</Text>
                <View style={styles.switchRight}>
                  <Text style={styles.metaText}>
                    {formActive ? t('webhooks.statusActive') : t('webhooks.statusPaused')}
                  </Text>
                  <Switch
                    value={formActive}
                    onValueChange={setFormActive}
                    disabled={saveMutation.isPending}
                    trackColor={{ false: colors.borderStrong, true: colors.orange }}
                    thumbColor="#FFFFFF"
                    accessibilityLabel={t('webhooks.status')}
                  />
                </View>
              </View>

              <Text style={styles.label}>{t('webhooks.events')}</Text>
              {eventsQuery.isLoading ? (
                <ActivityIndicator color={colors.orange} style={styles.inlineLoader} />
              ) : (
                <View style={styles.eventList}>
                  {availableEvents.map((event) => {
                    const selected = formEvents.includes(event);
                    return (
                      <TouchableOpacity
                        key={event}
                        style={[styles.eventRow, selected && styles.eventRowSelected]}
                        onPress={() => toggleFormEvent(event)}
                        disabled={saveMutation.isPending}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selected }}
                      >
                        <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                          {selected ? <Text style={styles.checkboxMark}>✓</Text> : null}
                        </View>
                        <View style={styles.eventRowMain}>
                          <Text style={[styles.eventRowText, selected && styles.eventRowTextSelected]}>
                            {eventLabel(event)}
                          </Text>
                          <Text style={styles.monoSmall}>{event}</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              {formError !== null ? <Text style={styles.formError}>{formError}</Text> : null}

              <TouchableOpacity
                style={[styles.primaryBtn, saveMutation.isPending && styles.btnDisabled]}
                onPress={submitForm}
                disabled={saveMutation.isPending}
                accessibilityRole="button"
              >
                {saveMutation.isPending ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.primaryBtnText}>{t('webhooks.save')}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={closeForm}
                disabled={saveMutation.isPending}
                accessibilityRole="button"
              >
                <Text style={styles.cancelBtnText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Signing secret — shown once */}
      <Modal
        visible={revealedSecret !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRevealedSecret(null)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('webhooks.secret')}</Text>
            <Text style={styles.secretUrl} numberOfLines={2}>{revealedSecret?.url ?? ''}</Text>
            <Text style={styles.warningText}>{t('webhooks.secretWarning')}</Text>
            <View style={styles.secretBox}>
              <Text style={styles.secretValue} selectable>{revealedSecret?.secret ?? ''}</Text>
            </View>
            <Text style={styles.hintText}>{t('webhooks.signatureHint')}</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={copySecret} accessibilityRole="button">
              <Text style={styles.primaryBtnText}>
                {secretCopied ? t('webhooks.copied') : t('webhooks.copy')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => setRevealedSecret(null)}
              accessibilityRole="button"
            >
              <Text style={styles.cancelBtnText}>{t('common.done')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Delivery log */}
      <Modal
        visible={logEndpoint !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setLogEndpoint(null)}
      >
        <View style={styles.overlay}>
          <View style={[styles.modalCard, styles.modalCardTall]}>
            <ScrollView contentContainerStyle={styles.modalScroll}>
              <Text style={styles.modalTitle}>{t('webhooks.deliveries')}</Text>
              <Text style={styles.secretUrl} numberOfLines={2}>{logEndpoint?.url ?? ''}</Text>

              <View style={styles.filterRow}>
                {DELIVERY_FILTERS.map((filter) => {
                  const selected = filter === logFilter;
                  return (
                    <TouchableOpacity
                      key={filter}
                      style={[styles.filterPill, selected && styles.filterPillSelected]}
                      onPress={() => { setLogFilter(filter); setLogLimit(DELIVERY_PAGE_SIZE); }}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                    >
                      <Text style={[styles.filterPillText, selected && styles.filterPillTextSelected]}>
                        {filter === 'all' ? t('webhooks.filterAll') : t(DELIVERY_STATUS_KEY[filter])}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {deliveriesQuery.isLoading ? (
                <ActivityIndicator color={colors.orange} style={styles.inlineLoader} />
              ) : deliveriesQuery.error ? (
                <View style={styles.errorCard}>
                  <Text style={styles.errorText}>{messageFor(deliveriesQuery.error, 'webhooks.failedToLoad')}</Text>
                  <TouchableOpacity onPress={() => { void deliveriesQuery.refetch(); }} accessibilityRole="button">
                    <Text style={styles.linkText}>{t('common.retry')}</Text>
                  </TouchableOpacity>
                </View>
              ) : deliveries.length === 0 ? (
                <Text style={styles.cardText}>{t('webhooks.deliveriesEmpty')}</Text>
              ) : (
                deliveries.map((delivery) => (
                  <View key={delivery.id} style={styles.deliveryRow}>
                    <View style={styles.deliveryMain}>
                      <Text style={styles.deliveryEvent} numberOfLines={1}>{eventLabel(delivery.event_type)}</Text>
                      <Text style={styles.deliveryMeta}>{formatMarketDateTime(delivery.created_at)}</Text>
                      <Text style={styles.deliveryMeta}>
                        {t('webhooks.deliveryAttempts', { count: delivery.attempts })}
                        {delivery.response_status !== null
                          ? ` · ${t('webhooks.deliveryResponse')}: ${formatMarketNumber(delivery.response_status)}`
                          : ''}
                      </Text>
                      {delivery.delivered_at !== null ? (
                        <Text style={styles.deliveryMeta}>
                          {t('webhooks.deliveredAt', { date: formatMarketDateTime(delivery.delivered_at) })}
                        </Text>
                      ) : null}
                      {delivery.status === 'pending' && delivery.next_attempt_at !== null ? (
                        <Text style={styles.deliveryMeta}>
                          {t('webhooks.deliveryNextAttempt', { date: formatMarketDateTime(delivery.next_attempt_at) })}
                        </Text>
                      ) : null}
                      {delivery.error_message !== null ? (
                        <Text style={styles.deliveryError} numberOfLines={3} selectable>
                          {t('webhooks.deliveryError')}: {delivery.error_message}
                        </Text>
                      ) : null}
                    </View>
                    <View
                      style={[
                        styles.badge,
                        delivery.status === 'success' && styles.badgeActive,
                        delivery.status === 'failed' && styles.badgeFailed,
                        delivery.status === 'pending' && styles.badgePaused,
                      ]}
                    >
                      <Text
                        style={[
                          styles.badgeText,
                          delivery.status === 'success' && styles.badgeTextActive,
                          delivery.status === 'failed' && styles.badgeTextFailed,
                          delivery.status === 'pending' && styles.badgeTextPaused,
                        ]}
                      >
                        {t(DELIVERY_STATUS_KEY[delivery.status])}
                      </Text>
                    </View>
                  </View>
                ))
              )}

              {canLoadMoreDeliveries ? (
                <TouchableOpacity
                  style={styles.outlineBtn}
                  onPress={() => setLogLimit((current) => Math.min(current + DELIVERY_PAGE_SIZE, MAX_DELIVERY_LIMIT))}
                  accessibilityRole="button"
                >
                  <Text style={styles.outlineBtnText}>{t('webhooks.loadMore')}</Text>
                </TouchableOpacity>
              ) : null}

              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setLogEndpoint(null)}
                accessibilityRole="button"
              >
                <Text style={styles.cancelBtnText}>{t('webhooks.close')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  wrapper: { flex: 1, backgroundColor: c.bg },
  content: { padding: 16, paddingBottom: 40, gap: 10 },
  pageTitle: { fontSize: 24, fontWeight: '700', color: c.text1 },
  pageSubtitle: { fontSize: 13, color: c.amber, marginBottom: 4 },
  card: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 14,
    gap: 6,
  },
  cardBusy: { opacity: 0.6 },
  stateCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 20,
    gap: 6,
    alignItems: 'center',
  },
  cardTitle: { fontSize: 15, fontWeight: '600', color: c.text1 },
  cardText: { fontSize: 13, color: c.textMuted, lineHeight: 18 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  endpointUrl: { flex: 1, fontSize: 15, fontWeight: '600', color: c.text1, lineHeight: 20 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeActive: { backgroundColor: 'rgba(204,120,92,0.12)' },
  badgePaused: { backgroundColor: c.skeleton },
  badgeFailed: { backgroundColor: 'rgba(204,82,71,0.12)' },
  badgeText: { fontSize: 11, fontWeight: '700' },
  badgeTextActive: { color: c.orange },
  badgeTextPaused: { color: c.amber },
  badgeTextFailed: { color: c.red },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip: { borderRadius: 6, backgroundColor: c.skeleton, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontSize: 11, fontWeight: '600', color: c.amber },
  metaText: { fontSize: 12, color: c.textMuted },
  failureText: { fontSize: 12, color: c.red, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  outlineBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 10,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineBtnText: { fontSize: 12, fontWeight: '600', color: c.text1 },
  dangerBtn: { borderColor: 'rgba(204,82,71,0.35)' },
  dangerBtnText: { color: c.red },
  primaryBtn: {
    backgroundColor: c.orange,
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  btnDisabled: { opacity: 0.5 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  cancelBtnText: { color: c.amber, fontSize: 15 },
  hintText: { fontSize: 12, color: c.textMuted, lineHeight: 17, marginTop: 4 },
  errorCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.red,
    backgroundColor: 'rgba(204,82,71,0.08)',
    padding: 14,
    gap: 8,
  },
  errorText: { color: c.red, fontSize: 13, lineHeight: 18 },
  linkText: { color: c.orange, fontSize: 13, fontWeight: '700' },
  overlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'center', padding: 18 },
  modalCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.borderStrong,
    padding: 20,
  },
  modalCardTall: { maxHeight: '90%', padding: 0 },
  modalScroll: { padding: 20 },
  modalTitle: { fontSize: 20, fontWeight: '700', color: c.text1 },
  label: { fontSize: 13, fontWeight: '600', color: c.text1, marginTop: 16, marginBottom: 6 },
  labelInline: { fontSize: 13, fontWeight: '600', color: c.text1 },
  input: {
    backgroundColor: c.inputBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.inputBorder,
    padding: 12,
    fontSize: 15,
    color: c.text1,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 },
  switchRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inlineLoader: { marginVertical: 16 },
  eventList: { gap: 7 },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  eventRowSelected: { borderColor: c.orange, backgroundColor: 'rgba(204,120,92,0.08)' },
  eventRowMain: { flex: 1 },
  eventRowText: { fontSize: 13, color: c.textMuted },
  eventRowTextSelected: { color: c.text1, fontWeight: '600' },
  monoSmall: { fontSize: 10, color: c.textFaint, fontFamily: monoFont, marginTop: 2 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: c.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: { borderColor: c.orange, backgroundColor: c.orange },
  checkboxMark: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  formError: { color: c.red, fontSize: 12, lineHeight: 17, marginTop: 12 },
  secretUrl: { fontSize: 13, color: c.amber, fontWeight: '600', marginTop: 6 },
  warningText: { fontSize: 13, color: c.red, lineHeight: 18, marginTop: 12 },
  secretBox: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.orange,
    backgroundColor: c.bg,
    padding: 14,
    marginTop: 10,
  },
  secretValue: { fontSize: 13, lineHeight: 19, color: c.text1, fontFamily: monoFont },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14, marginBottom: 6 },
  filterPill: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  filterPillSelected: { backgroundColor: c.orange, borderColor: c.orange },
  filterPillText: { fontSize: 12, color: c.text1 },
  filterPillTextSelected: { color: '#FFFFFF', fontWeight: '600' },
  deliveryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  deliveryMain: { flex: 1 },
  deliveryEvent: { fontSize: 13, fontWeight: '600', color: c.text1 },
  deliveryMeta: { fontSize: 11, color: c.textMuted, lineHeight: 16, marginTop: 2 },
  deliveryError: { fontSize: 11, color: c.red, lineHeight: 15, marginTop: 4 },
});
