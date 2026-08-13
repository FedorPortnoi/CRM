import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../theme';
import {
  LeadInboxApiError,
  useLeadInbox,
  type LeadInboxRecentMessage,
} from '../../hooks/useLeadInbox';
// Deliberately reused rather than cloned: these atoms are integration-agnostic
// (they take `colors` and render cards/buttons/notices), and the two screens
// looking identical is a feature.
import { AmoButton, AmoMetric, AmoNotice, AmoSectionCard } from '../../components/amocrm/AmoUi';

function errorText(
  error: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | null {
  if (!error) return null;
  if (error instanceof LeadInboxApiError && error.code === 'COLLECTOR_NOT_CONFIGURED') {
    return t('leadInbox.errors.collectorNotConfigured');
  }
  if (error instanceof Error && error.message) return error.message;
  return t('leadInbox.errors.generic');
}

function formatWhen(value: string | null | undefined, never: string): string {
  if (!value) return never;
  const d = new Date(value);
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function LeadInboxScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const styles = makeStyles(colors);
  const { canManage, statusQuery, connectMutation, testMutation, disconnectMutation, refresh } =
    useLeadInbox();

  const data = statusQuery.data;
  const address = data?.intake_address ?? null;

  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [address]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const copyAddress = useCallback((): void => {
    if (!address) return;
    Clipboard.setString(address);
    setCopied(true);
  }, [address]);

  const confirmDisconnect = useCallback((): void => {
    Alert.alert(t('leadInbox.actions.disconnectTitle'), t('leadInbox.actions.disconnectBody'), [
      { text: t('leadInbox.actions.cancel'), style: 'cancel' },
      {
        text: t('leadInbox.actions.disconnect'),
        style: 'destructive',
        onPress: () => disconnectMutation.mutate(),
      },
    ]);
  }, [disconnectMutation, t]);

  if (!canManage) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Stack.Screen options={{ title: t('leadInbox.title') }} />
        <AmoNotice colors={colors} tone="warning">
          {t('leadInbox.accessDenied')}
        </AmoNotice>
      </View>
    );
  }

  const loadError = errorText(statusQuery.error, t);
  const connectError = errorText(connectMutation.error, t);
  const disconnectError = errorText(disconnectMutation.error, t);
  const testResult = testMutation.data;
  const testError = errorText(testMutation.error, t) ?? (testResult && !testResult.ok ? testResult.error ?? null : null);

  const statusLabel =
    data?.status === 'error'
      ? t('leadInbox.status.error')
      : data?.status === 'paused'
        ? t('leadInbox.status.paused')
        : t('leadInbox.status.active');

  const messageStatus = (m: LeadInboxRecentMessage): string => {
    switch (m.status) {
      case 'processed':
        return t('leadInbox.recent.processed');
      case 'failed':
        return t('leadInbox.recent.failed');
      case 'duplicate':
        return t('leadInbox.recent.duplicate');
      default:
        return t('leadInbox.recent.claimed');
    }
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t('leadInbox.title') }} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.orange}
          />
        }
      >
        <Text style={styles.pageTitle}>{t('leadInbox.title')}</Text>
        <Text style={styles.pageIntro}>{t('leadInbox.intro')}</Text>

        {statusQuery.isPending ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.orange} />
          </View>
        ) : loadError ? (
          <AmoNotice colors={colors} tone="error">
            {loadError}
          </AmoNotice>
        ) : data && !data.configured ? (
          <AmoSectionCard
            colors={colors}
            title={t('leadInbox.setup.title')}
            subtitle={t('leadInbox.setup.subtitle')}
          >
            <AmoButton
              colors={colors}
              label={t('leadInbox.setup.connect')}
              onPress={() => connectMutation.mutate()}
              busy={connectMutation.isPending}
            />
            {connectError ? (
              <AmoNotice colors={colors} tone="error">
                {connectError}
              </AmoNotice>
            ) : null}
          </AmoSectionCard>
        ) : data ? (
          <>
            <AmoSectionCard
              colors={colors}
              title={t('leadInbox.address.title')}
              subtitle={t('leadInbox.address.subtitle')}
            >
              <Text style={styles.address} selectable>
                {address ?? data.imap_user ?? '—'}
              </Text>
              {address ? (
                <AmoButton
                  colors={colors}
                  label={copied ? t('leadInbox.address.copied') : t('leadInbox.address.copy')}
                  onPress={copyAddress}
                />
              ) : null}
            </AmoSectionCard>

            <AmoSectionCard colors={colors} title={t('leadInbox.steps.title')}>
              <Text style={styles.step}>{t('leadInbox.steps.one')}</Text>
              <Text style={styles.step}>{t('leadInbox.steps.two')}</Text>
              <Text style={styles.step}>{t('leadInbox.steps.three')}</Text>
              <Text style={styles.stepNote}>{t('leadInbox.steps.note')}</Text>
              <AmoButton
                colors={colors}
                label={t('leadInbox.steps.openCabinet')}
                onPress={() => void Linking.openURL('https://business.yandex.ru')}
                secondary
              />
            </AmoSectionCard>

            <AmoSectionCard colors={colors} title={t('leadInbox.status.title')}>
              <View style={styles.metricsRow}>
                <AmoMetric
                  colors={colors}
                  label={t('leadInbox.status.state')}
                  value={statusLabel}
                  danger={data.status === 'error'}
                />
                <AmoMetric
                  colors={colors}
                  label={t('leadInbox.status.lastPolled')}
                  value={formatWhen(data.last_polled_at, t('leadInbox.status.never'))}
                />
                <AmoMetric
                  colors={colors}
                  label={t('leadInbox.status.total')}
                  value={data.messages_total ?? 0}
                />
              </View>
              {data.last_error ? (
                <AmoNotice colors={colors} tone="error">
                  {data.last_error}
                </AmoNotice>
              ) : null}
              <AmoButton
                colors={colors}
                label={t('leadInbox.actions.test')}
                onPress={() => testMutation.mutate()}
                busy={testMutation.isPending}
                secondary
              />
              {testResult?.ok ? (
                <AmoNotice colors={colors} tone="success">
                  {t('leadInbox.actions.testOk')}
                </AmoNotice>
              ) : null}
              {testError ? (
                <AmoNotice colors={colors} tone="error">
                  {testError}
                </AmoNotice>
              ) : null}
            </AmoSectionCard>

            <AmoSectionCard colors={colors} title={t('leadInbox.recent.title')}>
              {!data.recent_messages || data.recent_messages.length === 0 ? (
                <Text style={styles.empty}>{t('leadInbox.recent.empty')}</Text>
              ) : (
                data.recent_messages.map((m) => (
                  <TouchableOpacity
                    key={m.id}
                    disabled={!m.deal_id}
                    onPress={() => m.deal_id && router.push(`/deal/${m.deal_id}` as never)}
                    accessibilityRole={m.deal_id ? 'button' : undefined}
                  >
                    <View style={styles.messageRow}>
                      <View style={styles.messageMain}>
                        <Text style={styles.messageSubject} numberOfLines={1}>
                          {m.subject || m.from_addr || '—'}
                        </Text>
                        <Text
                          style={[styles.messageMeta, m.status === 'failed' && styles.dangerText]}
                        >
                          {messageStatus(m)} ·{' '}
                          {formatWhen(m.received_at ?? m.created_at, t('leadInbox.status.never'))}
                        </Text>
                      </View>
                      {m.deal_id ? <Text style={styles.chevron}>{'>'}</Text> : null}
                    </View>
                  </TouchableOpacity>
                ))
              )}
            </AmoSectionCard>

            <AmoButton
              colors={colors}
              label={t('leadInbox.actions.disconnect')}
              onPress={confirmDisconnect}
              busy={disconnectMutation.isPending}
              secondary
            />
            {disconnectError ? (
              <AmoNotice colors={colors} tone="error">
                {disconnectError}
              </AmoNotice>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    centered: { justifyContent: 'center', padding: 20 },
    content: { padding: 16, gap: 14, paddingBottom: 40 },
    pageTitle: { color: c.text1, fontSize: 24, fontWeight: '800' },
    pageIntro: { color: c.textMuted, fontSize: 14, lineHeight: 20 },
    loading: { paddingVertical: 32, alignItems: 'center' },
    address: {
      color: c.text1,
      fontSize: 16,
      fontWeight: '700',
      backgroundColor: c.bg,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    step: { color: c.text1, fontSize: 14, lineHeight: 20 },
    stepNote: { color: c.textMuted, fontSize: 13, lineHeight: 18 },
    metricsRow: { flexDirection: 'row', gap: 8 },
    empty: { color: c.textMuted, fontSize: 13, lineHeight: 18 },
    messageRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    messageMain: { flex: 1 },
    messageSubject: { color: c.text1, fontSize: 14, fontWeight: '600' },
    messageMeta: { color: c.textMuted, fontSize: 12, marginTop: 2 },
    dangerText: { color: c.red },
    chevron: { color: c.textMuted, fontSize: 16, marginLeft: 8 },
  });
