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
import { ThemeColors, spacing, radius, type, tabular, control } from '../../theme';
import { Screen, Card, Button, Badge, EmptyState, SkeletonText } from '../../components/ui';
import { displayDateToIso, maskDateInput } from '../../utils/dateInput';

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

/**
 * The backend takes a full ISO datetime; the field asks for ДД.ММ.ГГГГ. A date
 * the user types means "valid through the end of that day", so it is widened to
 * 23:59:59.999 UTC rather than midnight, which would expire the key a day early.
 */
function expiryToIso(displayDate: string): string | null {
  const value = displayDateToIso(displayDate);
  if (!value) return null;
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
      const statusVariant = status === 'active' ? 'accent' : status === 'revoked' ? 'danger' : 'neutral';

      return (
        <Card style={status !== 'active' ? styles.cardMuted : undefined}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderMain}>
              <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
              {/* Only the prefix ever reaches the client after creation. */}
              <Text style={styles.prefix} selectable>{item.key_prefix}…</Text>
            </View>
            <Badge variant={statusVariant} label={t(STATUS_LABEL_KEYS[status])} />
          </View>

          <View style={styles.chipWrap}>
            {item.scopes.map((scope) => (
              <Badge key={scope} variant="neutral" label={t(SCOPE_LABEL_KEYS[scope])} />
            ))}
          </View>

          <View style={styles.metaWrap}>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>{t('apiKeys.createdAt')}</Text>
              <Text style={[styles.metaValue, tabular]}>
                {formatMarketDate(item.created_at, { day: 'numeric', month: 'short', year: 'numeric' })}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>{t('apiKeys.lastUsed')}</Text>
              <Text style={[styles.metaValue, tabular]}>
                {item.last_used_at ? formatMarketDateTime(item.last_used_at) : t('apiKeys.neverUsed')}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>{t('apiKeys.expiresAt')}</Text>
              <Text style={[styles.metaValue, tabular]}>
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
            <Button
              variant="danger"
              size="sm"
              title={t('apiKeys.revoke')}
              onPress={() => confirmRevoke(item)}
              disabled={isRevoking}
              loading={isRevoking}
              style={styles.revokeBtn}
              accessibilityLabel={`${t('apiKeys.revoke')}: ${item.name}`}
            />
          ) : null}
        </Card>
      );
    },
    [confirmRevoke, creatorName, revokingId, styles, t],
  );

  if (!canManage) {
    return (
      <Screen contentContainerStyle={styles.gateContent}>
        <Stack.Screen options={{ title: t('apiKeys.title') }} />
        <Text style={styles.pageTitle}>{t('apiKeys.title')}</Text>
        <Text style={styles.pageSubtitle}>{t('apiKeys.subtitle')}</Text>
        <EmptyState title={t('apiKeys.adminOnly')} />
      </Screen>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('apiKeys.title') }} />

      {keysQuery.isLoading ? (
        <View style={styles.list}>
          <Card style={styles.skeletonCard}><SkeletonText lines={3} /></Card>
          <Card style={styles.skeletonCard}><SkeletonText lines={3} /></Card>
        </View>
      ) : keysQuery.error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>{keysQuery.error.message}</Text>
          <TouchableOpacity onPress={() => { void keysQuery.refetch(); }} accessibilityRole="button" activeOpacity={0.7}>
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
            <EmptyState title={t('apiKeys.empty')} description={t('apiKeys.emptyHint')} />
          }
        />
      )}

      <Button
        title={t('apiKeys.create')}
        onPress={() => { resetForm(); setCreateVisible(true); }}
        disabled={limitReached}
        block
        style={styles.createBtn}
      />

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
                    activeOpacity={0.7}
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
              onChangeText={(value) => { setExpires(maskDateInput(value)); setFormError(null); }}
              placeholder={t('apiKeys.expiresNever')}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="number-pad"
              maxLength={10}
            />
            <Text style={styles.fieldHint}>{t('apiKeys.expiresHint')}</Text>

            {formError !== null ? <Text style={styles.formError}>{formError}</Text> : null}

            <Button
              title={t('apiKeys.create')}
              onPress={submitCreate}
              loading={createMutation.isPending}
              block
              style={styles.modalPrimary}
            />
            <Button
              title={t('common.cancel')}
              onPress={() => setCreateVisible(false)}
              disabled={createMutation.isPending}
              variant="ghost"
              block
            />
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

            <Button
              title={copied ? t('apiKeys.copied') : t('apiKeys.copy')}
              onPress={copyKey}
              block
              variant={copied ? 'secondary' : 'primary'}
              style={styles.copyBtn}
            />

            <Text style={styles.revealLabel}>{t('apiKeys.baseUrl')}</Text>
            <Text style={styles.revealMono} selectable>{publicApiBaseUrl()}</Text>

            <Text style={styles.revealLabel}>{t('apiKeys.authHeader')}</Text>
            <Text style={styles.revealHint}>{t('apiKeys.usageHint')}</Text>

            <Button
              title={t('apiKeys.close')}
              onPress={closeReveal}
              variant="ghost"
              block
              style={styles.closeBtn}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.sm, paddingBottom: control.md + spacing.xxl },
  skeletonCard: { gap: spacing.sm },
  gateContent: { padding: spacing.lg, gap: spacing.sm },
  header: { marginBottom: spacing.md, gap: spacing.xs },
  pageTitle: { ...type.title, color: c.text1 },
  pageSubtitle: { fontSize: 13, color: c.amber },
  scopesHint: { fontSize: 12, color: c.textMuted, lineHeight: 17, marginTop: spacing.xs },
  limitCard: {
    marginTop: spacing.sm,
    backgroundColor: c.dangerSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.danger,
    padding: spacing.md,
  },
  limitText: { fontSize: 13, color: c.danger },
  errorWrap: { marginTop: spacing.xxl, paddingHorizontal: spacing.xl, gap: spacing.md, alignItems: 'center' },
  errorText: { color: c.danger, textAlign: 'center' },
  retryText: { color: c.accent, ...type.heading },

  cardMuted: { opacity: 0.6 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  cardHeaderMain: { flex: 1, gap: spacing.xs },
  cardName: { ...type.heading, color: c.text1 },
  prefix: { ...type.mono, color: c.amber },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },

  metaWrap: { gap: spacing.xs },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  metaLabel: { fontSize: 12, color: c.textMuted },
  metaValue: { fontSize: 12, color: c.text1, flexShrink: 1, textAlign: 'right' },

  revokeBtn: { alignSelf: 'flex-start' },

  createBtn: { margin: spacing.lg },

  modal: { flex: 1, backgroundColor: c.bg },
  modalScroll: { padding: spacing.xl, paddingTop: spacing.xxl * 2, paddingBottom: spacing.xxl },
  modalTitle: { ...type.subtitle, color: c.text1, marginBottom: spacing.md },
  modalPrimary: { marginHorizontal: 0, marginTop: spacing.xl },
  label: { ...type.label, color: c.text1, marginBottom: spacing.sm, marginTop: spacing.lg },
  fieldHint: { fontSize: 12, color: c.textMuted, lineHeight: 17, marginTop: spacing.sm, marginBottom: spacing.xs },
  input: {
    backgroundColor: c.inputBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.inputBorder,
    padding: spacing.md,
    fontSize: 16,
    color: c.text1,
  },
  scopeList: { gap: spacing.sm, marginTop: spacing.xs },
  scopeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  scopeRowSelected: { borderColor: c.accent },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: { backgroundColor: c.accent, borderColor: c.accent },
  checkboxMark: { color: c.onAccent, fontSize: 13, fontWeight: '700' },
  scopeLabel: { fontSize: 14, color: c.text1 },
  formError: { fontSize: 13, color: c.danger, marginTop: spacing.lg },

  revealOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'center', padding: spacing.xl },
  revealCard: { backgroundColor: c.surface, borderRadius: radius.xl, padding: spacing.xl },
  revealTitle: { ...type.title, color: c.text1 },
  revealName: { fontSize: 14, color: c.amber, marginTop: spacing.xs },
  warningBox: {
    marginTop: spacing.lg,
    backgroundColor: c.dangerSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.danger,
    padding: spacing.md,
  },
  warningText: { fontSize: 13, color: c.danger, lineHeight: 18, fontWeight: '600' },
  secretBox: {
    marginTop: spacing.md,
    backgroundColor: c.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.md,
  },
  secretValue: { ...type.mono, color: c.text1 },
  copyBtn: { marginTop: spacing.md },
  revealLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: c.amber,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  revealMono: { ...type.mono, color: c.text1 },
  revealHint: { fontSize: 12, color: c.textMuted, lineHeight: 17 },
  closeBtn: { marginTop: spacing.xl },
});
