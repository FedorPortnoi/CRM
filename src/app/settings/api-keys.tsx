// API keys settings screen — owner/admin only.
// Backend: GET/POST /api/v1/api-keys, DELETE /api/v1/api-keys/:id
// i18n:    apiKeys.*
//
// The plaintext key exists in this app exactly once: in the body of the POST
// response. It is held in component state only while the reveal modal is open
// and is never written to the react-query cache (which is persisted to
// plaintext AsyncStorage), never logged, and never re-fetchable.
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  FlatList,
  ListRenderItemInfo,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { formatMarketDate, formatMarketDateTime } from '../../market/profile';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

// Mirrors API_KEY_SCOPES in backend/services/api-keys.ts.
const SCOPES = [
  'contacts:read',
  'contacts:write',
  'deals:read',
  'deals:write',
  'tasks:read',
  'tasks:write',
] as const;

type ApiKeyScope = (typeof SCOPES)[number];

// Mirrors MAX_API_KEYS_PER_ORG in backend/services/api-keys.ts. Counts
// non-revoked keys, so an expired-but-not-revoked key still occupies a slot.
const MAX_KEYS = 20;

const SCOPE_LABEL_KEYS: Record<ApiKeyScope, string> = {
  'contacts:read': 'apiKeys.scopeContactsRead',
  'contacts:write': 'apiKeys.scopeContactsWrite',
  'deals:read': 'apiKeys.scopeDealsRead',
  'deals:write': 'apiKeys.scopeDealsWrite',
  'tasks:read': 'apiKeys.scopeTasksRead',
  'tasks:write': 'apiKeys.scopeTasksWrite',
};

interface ApiKeySummary {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  created_by: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

type CreatedApiKey = ApiKeySummary & { key: string };

interface OrgMemberName {
  id: string;
  name: string;
}

type KeyStatus = 'active' | 'revoked' | 'expired';

const STATUS_LABEL_KEYS: Record<KeyStatus, string> = {
  active: 'apiKeys.statusActive',
  revoked: 'apiKeys.statusRevoked',
  expired: 'apiKeys.statusExpired',
};

function keyStatus(item: ApiKeySummary, now: number): KeyStatus {
  if (item.revoked_at !== null) return 'revoked';
  if (item.expires_at !== null && new Date(item.expires_at).getTime() <= now) return 'expired';
  return 'active';
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The backend takes a full ISO datetime; the field asks for ГГГГ-ММ-ДД. A date
 * the user types means "valid through the end of that day", so it is widened to
 * 23:59:59.999 UTC rather than midnight, which would expire the key a day early.
 */
function expiryToIso(value: string): string | null {
  if (!DATE_ONLY.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const stamp = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  const date = new Date(stamp);
  if (Number.isNaN(stamp) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  if (stamp <= Date.now()) return null;
  return date.toISOString();
}

// External integrators call /public/v1; the app's own API_URL ends in /api/v1.
function publicApiBaseUrl(): string {
  return API_URL.replace(/\/api\/v1\/?$/, '/public/v1');
}

async function readEnvelope<T>(res: Response, fallbackMessage: string): Promise<T> {
  let body: { data?: T; error?: { message?: string } } | null = null;
  try {
    body = (await res.json()) as { data?: T; error?: { message?: string } };
  } catch {
    // Fall through to the status-based message below.
  }
  if (!res.ok) throw new Error(body?.error?.message ?? fallbackMessage);
  if (!body || body.data === undefined) throw new Error(fallbackMessage);
  return body.data;
}

export default function ApiKeysScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const role = useUserStore((s) => s.user?.role);
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const canManage = role === 'owner' || role === 'admin';

  const [createVisible, setCreateVisible] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>([]);
  const [expires, setExpires] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);

  // Plaintext key, shown once. Cleared when the reveal modal closes.
  const [revealed, setRevealed] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  const [revokingId, setRevokingId] = useState<string | null>(null);

  // The token is part of the key on purpose: utils/queryClient.ts refuses to
  // dehydrate any query whose key carries a JWT, keeping key metadata out of
  // plaintext AsyncStorage.
  const keysQuery = useQuery<ApiKeySummary[], Error>({
    queryKey: ['api-keys', token],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api-keys`, {
        headers: { Authorization: `Bearer ${token ?? ''}` },
      });
      return readEnvelope<ApiKeySummary[]>(res, t('apiKeys.failedToLoad'));
    },
    enabled: !!token && canManage,
    // The global retry rule only recognises 401 when the message carries the
    // status text, which the server envelope does not. Credential administration
    // is a deliberate, manually refreshed screen — surface the failure instead of
    // hammering the endpoint three times.
    retry: false,
  });

  // Only used to name the creator of a key; a failure here must not break the
  // screen, so the row is simply omitted when the lookup is unavailable.
  const { data: members } = useQuery<OrgMemberName[]>({
    queryKey: ['org-users', token],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/auth/users`, {
        headers: { Authorization: `Bearer ${token ?? ''}` },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data: OrgMemberName[] };
      return json.data;
    },
    enabled: !!token && canManage,
  });

  const creatorName = useCallback(
    (id: string | null): string | null => {
      if (id === null) return null;
      return members?.find((m) => m.id === id)?.name ?? null;
    },
    [members],
  );

  const keys = useMemo(() => keysQuery.data ?? [], [keysQuery.data]);
  const liveCount = useMemo(() => keys.filter((k) => k.revoked_at === null).length, [keys]);
  const limitReached = liveCount >= MAX_KEYS;

  const resetForm = useCallback((): void => {
    setName('');
    setScopes([]);
    setExpires('');
    setFormError(null);
  }, []);

  const createMutation = useMutation({
    mutationFn: async (payload: { name: string; scopes: ApiKeyScope[]; expires_at?: string }) => {
      const res = await fetch(`${API_URL}/api-keys`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return readEnvelope<CreatedApiKey>(res, t('apiKeys.failedToCreate'));
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      setCreateVisible(false);
      resetForm();
      setCopied(false);
      // `key` is deliberately destructured away from anything long-lived.
      setRevealed({ name: created.name, key: created.key });
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${API_URL}/api-keys/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token ?? ''}` },
      });
      await readEnvelope<ApiKeySummary>(res, t('apiKeys.failedToRevoke'));
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
    onError: (e: Error) => Alert.alert(t('apiKeys.failedToRevoke'), e.message),
    onSettled: () => setRevokingId(null),
  });

  const toggleScope = useCallback((scope: ApiKeyScope): void => {
    setFormError(null);
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }, []);

  const submitCreate = useCallback((): void => {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError(t('apiKeys.nameRequired'));
      return;
    }
    if (scopes.length === 0) {
      setFormError(t('apiKeys.scopesRequired'));
      return;
    }
    const typedExpiry = expires.trim();
    let expiresAt: string | undefined;
    if (typedExpiry) {
      const iso = expiryToIso(typedExpiry);
      if (iso === null) {
        setFormError(t('apiKeys.expiresInvalid'));
        return;
      }
      expiresAt = iso;
    }
    setFormError(null);
    createMutation.mutate({
      name: trimmed,
      // Keep the backend's canonical order so the created row reads the same.
      scopes: SCOPES.filter((s) => scopes.includes(s)),
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    });
  }, [name, scopes, expires, createMutation, t]);

  const confirmRevoke = useCallback(
    (item: ApiKeySummary): void => {
      Alert.alert(t('apiKeys.revokeConfirmTitle'), t('apiKeys.revokeConfirmBody', { name: item.name }), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('apiKeys.revokeConfirmAction'),
          style: 'destructive',
          onPress: () => {
            setRevokingId(item.id);
            revokeMutation.mutate(item.id);
          },
        },
      ]);
    },
    [revokeMutation, t],
  );

  const copyKey = useCallback((): void => {
    if (revealed === null) return;
    Clipboard.setString(revealed.key);
    setCopied(true);
  }, [revealed]);

  const closeReveal = useCallback((): void => {
    setRevealed(null);
    setCopied(false);
    // react-query keeps the last mutation response — including the plaintext
    // key — in memory until gc. Reset drops it as soon as the modal closes.
    createMutation.reset();
  }, [createMutation]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ApiKeySummary>) => {
      const status = keyStatus(item, Date.now());
      const isRevoking = revokingId === item.id;
      const creator = creatorName(item.created_by);
      const statusStyle =
        status === 'active' ? styles.badgeActive : status === 'revoked' ? styles.badgeRevoked : styles.badgeExpired;
      const statusTextStyle =
        status === 'active'
          ? styles.badgeTextActive
          : status === 'revoked'
            ? styles.badgeTextRevoked
            : styles.badgeTextExpired;

      return (
        <View style={[styles.card, status !== 'active' && styles.cardMuted]}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderMain}>
              <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
              {/* Only the prefix ever reaches the client after creation. */}
              <Text style={styles.prefix} selectable>{item.key_prefix}…</Text>
            </View>
            <View style={[styles.badge, statusStyle]}>
              <Text style={[styles.badgeText, statusTextStyle]}>{t(STATUS_LABEL_KEYS[status])}</Text>
            </View>
          </View>

          <View style={styles.chipWrap}>
            {item.scopes.map((scope) => (
              <View key={scope} style={styles.chip}>
                <Text style={styles.chipText}>{t(SCOPE_LABEL_KEYS[scope])}</Text>
              </View>
            ))}
          </View>

          <View style={styles.metaWrap}>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>{t('apiKeys.createdAt')}</Text>
              <Text style={styles.metaValue}>
                {formatMarketDate(item.created_at, { day: 'numeric', month: 'short', year: 'numeric' })}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>{t('apiKeys.lastUsed')}</Text>
              <Text style={styles.metaValue}>
                {item.last_used_at ? formatMarketDateTime(item.last_used_at) : t('apiKeys.neverUsed')}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>{t('apiKeys.expiresAt')}</Text>
              <Text style={styles.metaValue}>
                {item.expires_at
                  ? formatMarketDate(item.expires_at, { day: 'numeric', month: 'short', year: 'numeric' })
                  : t('apiKeys.expiresNever')}
              </Text>
            </View>
            {creator !== null ? (
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>{t('apiKeys.createdBy')}</Text>
                <Text style={styles.metaValue}>{creator}</Text>
              </View>
            ) : null}
          </View>

          {status !== 'revoked' ? (
            <TouchableOpacity
              style={[styles.revokeBtn, isRevoking && styles.disabled]}
              onPress={() => confirmRevoke(item)}
              disabled={isRevoking}
              accessibilityRole="button"
              accessibilityLabel={`${t('apiKeys.revoke')}: ${item.name}`}
            >
              {isRevoking ? (
                <ActivityIndicator size="small" color={colors.red} />
              ) : (
                <Text style={styles.revokeBtnText}>{t('apiKeys.revoke')}</Text>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      );
    },
    [confirmRevoke, creatorName, revokingId, styles, colors.red, t],
  );

  if (!canManage) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: t('apiKeys.title') }} />
        <ScrollView contentContainerStyle={styles.gateContent}>
          <Text style={styles.pageTitle}>{t('apiKeys.title')}</Text>
          <Text style={styles.pageSubtitle}>{t('apiKeys.subtitle')}</Text>
          <View style={styles.noticeCard}>
            <Text style={styles.noticeTitle}>{t('apiKeys.adminOnly')}</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('apiKeys.title') }} />

      {keysQuery.isLoading ? (
        <ActivityIndicator style={styles.loader} color={colors.orange} />
      ) : keysQuery.error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>{keysQuery.error.message}</Text>
          <TouchableOpacity onPress={() => { void keysQuery.refetch(); }} accessibilityRole="button">
            <Text style={styles.retryText}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={keys}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshing={keysQuery.isFetching}
          onRefresh={() => { void keysQuery.refetch(); }}
          ListHeaderComponent={
            <View style={styles.header}>
              <Text style={styles.pageTitle}>{t('apiKeys.title')}</Text>
              <Text style={styles.pageSubtitle}>{t('apiKeys.subtitle')}</Text>
              <Text style={styles.scopesHint}>{t('apiKeys.scopesHint')}</Text>
              {limitReached ? (
                <View style={styles.limitCard}>
                  <Text style={styles.limitText}>{t('apiKeys.limitReached')}</Text>
                </View>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            <View style={styles.noticeCard}>
              <Text style={styles.noticeTitle}>{t('apiKeys.empty')}</Text>
              <Text style={styles.noticeText}>{t('apiKeys.emptyHint')}</Text>
            </View>
          }
        />
      )}

      <TouchableOpacity
        style={[styles.primaryBtn, limitReached && styles.disabled]}
        onPress={() => { resetForm(); setCreateVisible(true); }}
        disabled={limitReached}
        accessibilityRole="button"
        accessibilityLabel={t('apiKeys.create')}
        accessibilityState={{ disabled: limitReached }}
      >
        <Text style={styles.primaryBtnText}>{t('apiKeys.create')}</Text>
      </TouchableOpacity>

      {/* ── Create ─────────────────────────────────────────────────────────── */}
      <Modal
        visible={createVisible}
        animationType="slide"
        onRequestClose={() => { if (!createMutation.isPending) setCreateVisible(false); }}
      >
        <View style={styles.modal}>
          <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{t('apiKeys.createTitle')}</Text>

            <Text style={styles.label}>{t('apiKeys.name')}</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={(value) => { setName(value); setFormError(null); }}
              placeholder={t('apiKeys.namePlaceholder')}
              placeholderTextColor={colors.placeholder}
              maxLength={100}
              autoCapitalize="sentences"
            />

            <Text style={styles.label}>{t('apiKeys.scopes')}</Text>
            <Text style={styles.fieldHint}>{t('apiKeys.scopesHint')}</Text>
            <View style={styles.scopeList}>
              {SCOPES.map((scope) => {
                const selected = scopes.includes(scope);
                return (
                  <TouchableOpacity
                    key={scope}
                    style={[styles.scopeRow, selected && styles.scopeRowSelected]}
                    onPress={() => toggleScope(scope)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={t(SCOPE_LABEL_KEYS[scope])}
                  >
                    <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                      {selected ? <Text style={styles.checkboxMark}>✓</Text> : null}
                    </View>
                    <Text style={styles.scopeLabel}>{t(SCOPE_LABEL_KEYS[scope])}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.label}>{t('apiKeys.expiresAt')}</Text>
            <TextInput
              style={styles.input}
              value={expires}
              onChangeText={(value) => { setExpires(value); setFormError(null); }}
              placeholder={t('apiKeys.expiresNever')}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              maxLength={10}
            />
            <Text style={styles.fieldHint}>{t('apiKeys.expiresHint')}</Text>

            {formError !== null ? <Text style={styles.formError}>{formError}</Text> : null}

            <TouchableOpacity
              style={[styles.primaryBtn, styles.modalPrimary, createMutation.isPending && styles.disabled]}
              onPress={submitCreate}
              disabled={createMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel={t('apiKeys.create')}
            >
              {createMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>{t('apiKeys.create')}</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => setCreateVisible(false)}
              disabled={createMutation.isPending}
              accessibilityRole="button"
            >
              <Text style={styles.cancelBtnText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* ── Reveal (once) ──────────────────────────────────────────────────── */}
      <Modal visible={revealed !== null} animationType="fade" transparent onRequestClose={closeReveal}>
        <View style={styles.revealOverlay}>
          <View style={styles.revealCard}>
            <Text style={styles.revealTitle}>{t('apiKeys.created')}</Text>
            <Text style={styles.revealName}>{revealed?.name}</Text>

            <View style={styles.warningBox}>
              <Text style={styles.warningText}>{t('apiKeys.copyWarning')}</Text>
            </View>

            <View style={styles.secretBox}>
              <Text style={styles.secretValue} selectable>{revealed?.key}</Text>
            </View>

            <TouchableOpacity
              style={[styles.copyBtn, copied && styles.copyBtnDone]}
              onPress={copyKey}
              accessibilityRole="button"
              accessibilityLabel={t('apiKeys.copy')}
            >
              <Text style={styles.copyBtnText}>{copied ? t('apiKeys.copied') : t('apiKeys.copy')}</Text>
            </TouchableOpacity>

            <Text style={styles.revealLabel}>{t('apiKeys.baseUrl')}</Text>
            <Text style={styles.revealMono} selectable>{publicApiBaseUrl()}</Text>

            <Text style={styles.revealLabel}>{t('apiKeys.authHeader')}</Text>
            <Text style={styles.revealHint}>{t('apiKeys.usageHint')}</Text>

            <TouchableOpacity style={styles.closeBtn} onPress={closeReveal} accessibilityRole="button">
              <Text style={styles.closeBtnText}>{t('apiKeys.close')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  loader: { marginTop: 40 },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 80 },
  gateContent: { padding: 16, gap: 8 },
  header: { marginBottom: 12, gap: 4 },
  pageTitle: { fontSize: 24, fontWeight: '700', color: c.text1 },
  pageSubtitle: { fontSize: 13, color: c.amber },
  scopesHint: { fontSize: 12, color: c.textMuted, lineHeight: 17, marginTop: 4 },
  limitCard: {
    marginTop: 10,
    backgroundColor: c.bgPanel,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(204,82,71,0.35)',
    padding: 12,
  },
  limitText: { fontSize: 13, color: c.red },
  noticeCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
    gap: 6,
  },
  noticeTitle: { fontSize: 15, fontWeight: '600', color: c.text1 },
  noticeText: { fontSize: 13, color: c.textMuted, lineHeight: 18 },
  errorWrap: { marginTop: 40, paddingHorizontal: 24, gap: 12, alignItems: 'center' },
  errorText: { color: c.red, textAlign: 'center' },
  retryText: { color: c.orange, fontWeight: '600', fontSize: 15 },

  card: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 14,
    marginBottom: 10,
    gap: 10,
  },
  cardMuted: { opacity: 0.6 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cardHeaderMain: { flex: 1, gap: 3 },
  cardName: { fontSize: 15, fontWeight: '600', color: c.text1 },
  prefix: { fontSize: 13, color: c.amber, letterSpacing: 0.5 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  badgeActive: { backgroundColor: 'rgba(212,162,127,0.15)' },
  badgeRevoked: { backgroundColor: 'rgba(204,82,71,0.15)' },
  badgeExpired: { backgroundColor: 'rgba(232,224,212,0.08)' },
  badgeTextActive: { color: c.amber },
  badgeTextRevoked: { color: c.red },
  badgeTextExpired: { color: c.textMuted },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipText: { fontSize: 11, color: c.text1 },

  metaWrap: { gap: 4 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  metaLabel: { fontSize: 12, color: c.textMuted },
  metaValue: { fontSize: 12, color: c.text1, flexShrink: 1, textAlign: 'right' },

  revokeBtn: {
    alignSelf: 'flex-start',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(204,82,71,0.35)',
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  revokeBtnText: { fontSize: 13, fontWeight: '600', color: c.red },
  disabled: { opacity: 0.5 },

  primaryBtn: { margin: 16, backgroundColor: c.orange, borderRadius: 10, padding: 14, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  modal: { flex: 1, backgroundColor: c.bg },
  modalScroll: { padding: 24, paddingTop: 60, paddingBottom: 48 },
  modalTitle: { fontSize: 22, fontWeight: '700', color: c.text1, marginBottom: 12 },
  modalPrimary: { marginHorizontal: 0, marginTop: 24 },
  label: { fontSize: 13, fontWeight: '600', color: c.text1, marginBottom: 6, marginTop: 16 },
  fieldHint: { fontSize: 12, color: c.textMuted, lineHeight: 17, marginTop: 6, marginBottom: 4 },
  input: {
    backgroundColor: c.inputBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.inputBorder,
    padding: 12,
    fontSize: 15,
    color: c.text1,
  },
  scopeList: { gap: 6, marginTop: 4 },
  scopeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  scopeRowSelected: { borderColor: c.orange },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: c.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: { backgroundColor: c.orange, borderColor: c.orange },
  checkboxMark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  scopeLabel: { fontSize: 14, color: c.text1 },
  formError: { fontSize: 13, color: c.red, marginTop: 16 },
  cancelBtn: { marginTop: 12, alignItems: 'center', padding: 12 },
  cancelBtnText: { color: c.amber, fontSize: 15 },

  revealOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'center', padding: 24 },
  revealCard: { backgroundColor: c.bgPanel, borderRadius: 16, padding: 24 },
  revealTitle: { fontSize: 20, fontWeight: '700', color: c.text1 },
  revealName: { fontSize: 14, color: c.amber, marginTop: 4 },
  warningBox: {
    marginTop: 16,
    backgroundColor: 'rgba(204,82,71,0.12)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(204,82,71,0.35)',
    padding: 12,
  },
  warningText: { fontSize: 13, color: c.red, lineHeight: 18, fontWeight: '600' },
  secretBox: {
    marginTop: 12,
    backgroundColor: c.bg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    padding: 12,
  },
  secretValue: { fontSize: 13, color: c.text1, letterSpacing: 0.3 },
  copyBtn: { marginTop: 12, backgroundColor: c.orange, borderRadius: 10, padding: 13, alignItems: 'center' },
  copyBtnDone: { backgroundColor: c.border },
  copyBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  revealLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: c.amber,
    marginTop: 16,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  revealMono: { fontSize: 13, color: c.text1 },
  revealHint: { fontSize: 12, color: c.textMuted, lineHeight: 17 },
  closeBtn: { marginTop: 20, alignItems: 'center', padding: 12 },
  closeBtnText: { color: c.amber, fontSize: 15 },
});
