import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../hooks/useTheme';
import {
  AmoApiError,
  type AmoImportCursor,
  type AmoImportResult,
  mergeAmoImportResults,
  useAmoCrm,
} from '../../hooks/useAmoCrm';
import type { ThemeColors } from '../../theme';
import { formatMarketDateTime } from '../../market/profile';
import {
  AmoButton,
  AmoMetric,
  AmoNotice,
  AmoSectionCard,
} from '../../components/amocrm/AmoUi';

const ERROR_COPY: Record<string, { key: string; fallback: string }> = {
  FORBIDDEN: { key: 'amocrm.errors.forbidden', fallback: 'У вас нет прав для этого действия.' },
  AMO_NOT_CONFIGURED: {
    key: 'amocrm.errors.notConfigured',
    fallback: 'Интеграция amoCRM ещё не настроена на сервере.',
  },
  AMO_NOT_CONNECTED: {
    key: 'amocrm.errors.notConnected',
    fallback: 'Сначала подключите аккаунт amoCRM.',
  },
  AMO_NEEDS_REAUTH: {
    key: 'amocrm.errors.needsReauth',
    fallback: 'Авторизация устарела. Подключите amoCRM заново.',
  },
  AMOCRM_PREVIEW_FAILED: {
    key: 'amocrm.errors.previewFailed',
    fallback: 'Не удалось подготовить предварительный просмотр.',
  },
  AMOCRM_IMPORT_FAILED: {
    key: 'amocrm.errors.importFailed',
    fallback: 'Импорт из amoCRM не завершён.',
  },
  AMO_RECONCILE_FAILED: {
    key: 'amocrm.errors.reconcileFailed',
    fallback: 'Не удалось сверить данные с amoCRM.',
  },
  AMO_WEBHOOK_SUBSCRIBE_FAILED: {
    key: 'amocrm.errors.webhookFailed',
    fallback: 'Не удалось включить получение изменений из amoCRM.',
  },
};

type Translate = ReturnType<typeof useTranslation>['t'];

function translatedError(t: Translate, error: Error | null | undefined): string | null {
  if (!error) return null;
  const code = error instanceof AmoApiError ? error.code : null;
  const copy = code ? ERROR_COPY[code] : undefined;
  return copy
    ? t(copy.key, { defaultValue: copy.fallback })
    : t('amocrm.errors.generic', { defaultValue: 'Не удалось выполнить запрос к amoCRM.' });
}

function countLabel(value: number, hasMore: boolean): string {
  return hasMore ? `${value}+` : String(value);
}

export default function AmoCrmSettingsScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const {
    canManage,
    canImport,
    awaitingOAuth,
    statusQuery,
    previewQuery,
    connectMutation,
    importMutation,
    reconcileMutation,
    subscribeMutation,
    refresh,
  } = useAmoCrm();

  const [includeLeads, setIncludeLeads] = useState(true);
  const [includeCompanies, setIncludeCompanies] = useState(true);
  const [importResult, setImportResult] = useState<AmoImportResult | null>(null);

  const status = statusQuery.data;
  const active = status?.connected === true && status.status === 'active';
  const refreshing = statusQuery.isRefetching || previewQuery.isRefetching;
  const importError = translatedError(t, importMutation.error);
  const statusError = translatedError(t, statusQuery.error);
  const previewError = translatedError(t, previewQuery.error);
  const connectError = translatedError(t, connectMutation.error);
  const reconcileError = translatedError(t, reconcileMutation.error);
  const subscribeError = translatedError(t, subscribeMutation.error);

  const accountLabel = status?.subdomain
    ? `${status.subdomain}.amocrm.ru`
    : t('amocrm.accountUnknown', { defaultValue: 'Аккаунт подключён' });

  const connectionTone = useMemo(() => {
    if (!status?.connected) return colors.textMuted;
    if (status.status === 'active') return colors.orange;
    return colors.red;
  }, [colors, status]);

  const runImport = useCallback(
    (cursor?: AmoImportCursor) => {
      if (!canImport || !active || importMutation.isPending) return;
      if (!cursor) setImportResult(null);
      importMutation.mutate(
        { include_leads: includeLeads, include_companies: includeCompanies, cursor },
        { onSuccess: (next) => setImportResult((previous) => mergeAmoImportResults(previous, next)) },
      );
    }, [active, canImport, importMutation, includeCompanies, includeLeads],
  );

  const confirmImport = useCallback(() => {
    Alert.alert(
      t('amocrm.import.confirmTitle', { defaultValue: 'Импортировать данные?' }),
      t('amocrm.import.confirmBody', {
        defaultValue:
          'Контакты и выбранные сущности будут добавлены или обновлены в 4КУБ. Существующие связи amoCRM используются для защиты от дублей.',
      }),
      [
        { text: t('common.cancel', { defaultValue: 'Отмена' }), style: 'cancel' },
        {
          text: t('amocrm.import.confirmAction', { defaultValue: 'Начать импорт' }),
          onPress: () => runImport(),
        },
      ],
    );
  }, [runImport, t]);

  if (!canManage) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: t('amocrm.title', { defaultValue: 'amoCRM' }) }} />
        <View style={styles.centered}>
          <AmoNotice colors={colors} tone="warning">
            {t('amocrm.forbidden', {
              defaultValue: 'Подключать amoCRM и просматривать состояние синхронизации могут владелец и администратор.',
            })}
          </AmoNotice>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t('amocrm.title', { defaultValue: 'amoCRM' }) }} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={colors.orange}
          />
        }
      >
        <Text style={styles.pageTitle}>{t('amocrm.title', { defaultValue: 'amoCRM' })}</Text>
        <Text style={styles.pageIntro}>
          {t('amocrm.intro', {
            defaultValue:
              'Подключение, первичный импорт и двусторонняя синхронизация контактов и сделок.',
          })}
        </Text>

        {statusQuery.isPending ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.orange} />
            <Text style={styles.muted}>
              {t('amocrm.loading', { defaultValue: 'Проверяем подключение…' })}
            </Text>
          </View>
        ) : statusError ? (
          <AmoNotice colors={colors} tone="error">{statusError}</AmoNotice>
        ) : (
          <AmoSectionCard
            colors={colors}
            title={t('amocrm.connection.title', { defaultValue: 'Подключение' })}
          >
            <View style={styles.connectionRow}>
              <View style={[styles.statusDot, { backgroundColor: connectionTone }]} />
              <View style={styles.flex}>
                <Text style={styles.connectionTitle}>
                  {!status?.configured
                    ? t('amocrm.connection.notConfigured', { defaultValue: 'Не настроено на сервере' })
                    : !status.connected
                      ? t('amocrm.connection.disconnected', { defaultValue: 'Не подключено' })
                      : status.status === 'active'
                        ? accountLabel
                        : status.status === 'needs_reauth'
                          ? t('amocrm.connection.needsReauth', { defaultValue: 'Нужна повторная авторизация' })
                          : t('amocrm.connection.paused', { defaultValue: 'Синхронизация приостановлена' })}
                </Text>
                {status?.connected_at ? (
                  <Text style={styles.muted}>
                    {t('amocrm.connection.connectedAt', {
                      defaultValue: 'Подключено {{date}}',
                      date: formatMarketDateTime(status.connected_at),
                    })}
                  </Text>
                ) : null}
              </View>
              {status?.base_url ? (
                <TouchableOpacity
                  onPress={() => void Linking.openURL(status.base_url as string)}
                  accessibilityRole="link"
                >
                  <Text style={styles.link}>
                    {t('amocrm.connection.openAccount', { defaultValue: 'Открыть' })}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {!status?.configured ? (
              <AmoNotice colors={colors} tone="warning">
                {t('amocrm.connection.serverSetupHint', {
                  defaultValue:
                    'Администратору сервера нужно задать AMOCRM_CLIENT_ID, AMOCRM_CLIENT_SECRET и AMOCRM_REDIRECT_URI.',
                })}
              </AmoNotice>
            ) : !active ? (
              <AmoButton
                colors={colors}
                label={
                  status?.connected
                    ? t('amocrm.connection.reauthorize', { defaultValue: 'Подключить заново' })
                    : t('amocrm.connection.connect', { defaultValue: 'Подключить amoCRM' })
                }
                onPress={() => connectMutation.mutate()}
                busy={connectMutation.isPending || awaitingOAuth}
              />
            ) : null}

            {awaitingOAuth ? (
              <AmoNotice colors={colors}>
                {t('amocrm.connection.oauthHint', {
                  defaultValue:
                    'Завершите авторизацию в открывшемся окне, затем вернитесь в 4КУБ. Статус обновится автоматически.',
                })}
              </AmoNotice>
            ) : null}
            {connectError ? <AmoNotice colors={colors} tone="error">{connectError}</AmoNotice> : null}
            {status?.last_error ? (
              <AmoNotice colors={colors} tone="error">
                {t('amocrm.connection.lastError', {
                  defaultValue: 'Последняя ошибка синхронизации. Проверьте вебхуки и выполните сверку.',
                })}
              </AmoNotice>
            ) : null}
          </AmoSectionCard>
        )}

        {active && status ? (
          <AmoSectionCard
            colors={colors}
            title={t('amocrm.sync.title', { defaultValue: 'Двусторонняя синхронизация' })}
            subtitle={t('amocrm.sync.subtitle', {
              defaultValue: 'Очередь изменений между 4КУБ и amoCRM.',
            })}
          >
            <View style={styles.metrics}>
              <AmoMetric colors={colors} label={t('amocrm.sync.pending', { defaultValue: 'В очереди' })} value={status.sync.pending} />
              <AmoMetric colors={colors} label={t('amocrm.sync.processing', { defaultValue: 'В работе' })} value={status.sync.processing} />
              <AmoMetric colors={colors} label={t('amocrm.sync.failed', { defaultValue: 'Ошибки' })} value={status.sync.failed} danger={status.sync.failed > 0} />
              <AmoMetric colors={colors} label={t('amocrm.sync.conflicts', { defaultValue: 'Конфликты' })} value={status.sync.conflicts} danger={status.sync.conflicts > 0} />
            </View>

            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>{t('amocrm.sync.webhooks', { defaultValue: 'Подписки на изменения' })}</Text>
              <Text style={styles.detailValue}>{status.webhook_count}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>{t('amocrm.sync.lastSync', { defaultValue: 'Последняя полная сверка' })}</Text>
              <Text style={styles.detailValue}>
                {status.last_sync_at
                  ? formatMarketDateTime(status.last_sync_at)
                  : t('amocrm.sync.never', { defaultValue: 'Ещё не выполнялась' })}
              </Text>
            </View>

            {status.webhook_count === 0 ? (
              <>
                <AmoNotice colors={colors} tone="warning">
                  {t('amocrm.sync.noWebhooks', {
                    defaultValue: 'Получение новых изменений не включено. Повторите подписку.',
                  })}
                </AmoNotice>
                <AmoButton
                  colors={colors}
                  secondary
                  label={t('amocrm.sync.subscribe', { defaultValue: 'Включить получение изменений' })}
                  onPress={() => subscribeMutation.mutate()}
                  busy={subscribeMutation.isPending}
                />
              </>
            ) : null}
            {subscribeError ? <AmoNotice colors={colors} tone="error">{subscribeError}</AmoNotice> : null}

            <AmoButton
              colors={colors}
              secondary
              label={t('amocrm.sync.reconcile', { defaultValue: 'Сверить данные сейчас' })}
              onPress={() => reconcileMutation.mutate()}
              busy={reconcileMutation.isPending}
            />
            {reconcileMutation.data ? (
              <AmoNotice colors={colors} tone="success">
                {t('amocrm.sync.reconcileResult', {
                  defaultValue: 'Проверено: {{inspected}} · восстановлено: {{healed}} · только в 4КУБ: {{localOnly}}',
                  inspected: reconcileMutation.data.entitiesInspected,
                  healed: reconcileMutation.data.healed,
                  localOnly: reconcileMutation.data.localOnly,
                })}
              </AmoNotice>
            ) : null}
            {reconcileError ? <AmoNotice colors={colors} tone="error">{reconcileError}</AmoNotice> : null}
          </AmoSectionCard>
        ) : null}

        {active ? (
          <AmoSectionCard
            colors={colors}
            title={t('amocrm.import.title', { defaultValue: 'Первичный импорт' })}
            subtitle={t('amocrm.import.subtitle', {
              defaultValue: 'Сначала проверьте объём и воронки. Импорт запускается только после подтверждения.',
            })}
          >
            {previewQuery.isPending ? (
              <View style={styles.inlineLoading}>
                <ActivityIndicator color={colors.orange} size="small" />
                <Text style={styles.muted}>{t('amocrm.import.previewLoading', { defaultValue: 'Читаем данные amoCRM…' })}</Text>
              </View>
            ) : previewError ? (
              <AmoNotice colors={colors} tone="error">{previewError}</AmoNotice>
            ) : previewQuery.data ? (
              <>
                <Text style={styles.subheading}>{t('amocrm.import.preview', { defaultValue: 'Предварительный просмотр' })}</Text>
                <View style={styles.metrics}>
                  <AmoMetric colors={colors} label={t('amocrm.import.contacts', { defaultValue: 'Контакты' })} value={countLabel(previewQuery.data.sample.contacts, previewQuery.data.has_more.contacts)} />
                  <AmoMetric colors={colors} label={t('amocrm.import.companies', { defaultValue: 'Компании' })} value={countLabel(previewQuery.data.sample.companies, previewQuery.data.has_more.companies)} />
                  <AmoMetric colors={colors} label={t('amocrm.import.leads', { defaultValue: 'Сделки' })} value={countLabel(previewQuery.data.sample.leads, previewQuery.data.has_more.leads)} />
                  <AmoMetric colors={colors} label={t('amocrm.import.pipelines', { defaultValue: 'Воронки' })} value={previewQuery.data.pipelines.length} />
                </View>

                {previewQuery.data.already_mapped.contacts + previewQuery.data.already_mapped.leads > 0 ? (
                  <Text style={styles.muted}>
                    {t('amocrm.import.alreadyMapped', {
                      defaultValue: 'Уже связаны: контакты — {{contacts}}, сделки — {{leads}}.',
                      contacts: previewQuery.data.already_mapped.contacts,
                      leads: previewQuery.data.already_mapped.leads,
                    })}
                  </Text>
                ) : null}

                {previewQuery.data.pipelines.map((pipeline) => (
                  <View key={pipeline.amo_pipeline_id} style={styles.pipelineRow}>
                    <View style={styles.flex}>
                      <Text style={styles.pipelineName}>{pipeline.name}</Text>
                      <Text style={styles.muted}>
                        {t('amocrm.import.stageCount', {
                          defaultValue: 'Этапов: {{count}}',
                          count: pipeline.stages.length,
                        })}
                      </Text>
                    </View>
                    {pipeline.is_archive ? (
                      <Text style={styles.archiveBadge}>{t('amocrm.import.archived', { defaultValue: 'Архив' })}</Text>
                    ) : null}
                  </View>
                ))}

                {previewQuery.data.warnings.map((warning) => (
                  <AmoNotice
                    key={`${warning.code}:${warning.amo_pipeline_id}:${warning.amo_status_id ?? ''}`}
                    colors={colors}
                    tone="warning"
                  >
                    {warning.code === 'EMPTY_PIPELINE'
                      ? t('amocrm.import.warningEmptyPipeline', {
                          defaultValue: 'В одной из воронок нет этапов; она будет пропущена.',
                        })
                      : t('amocrm.import.warningDuplicateTerminal', {
                          defaultValue: 'Повторный финальный этап «{{stage}}» будет импортирован как обычный.',
                          stage: warning.stage_name ?? '—',
                        })}
                  </AmoNotice>
                ))}
              </>
            ) : null}

            <View style={styles.optionRow}>
              <View style={styles.flex}>
                <Text style={styles.optionTitle}>{t('amocrm.import.includeCompanies', { defaultValue: 'Импортировать компании' })}</Text>
                <Text style={styles.muted}>{t('amocrm.import.includeCompaniesHint', { defaultValue: 'Названия компаний будут добавлены к контактам.' })}</Text>
              </View>
              <Switch
                value={includeCompanies}
                onValueChange={setIncludeCompanies}
                disabled={importMutation.isPending}
                trackColor={{ false: colors.borderStrong, true: colors.orange }}
              />
            </View>
            <View style={styles.optionRow}>
              <View style={styles.flex}>
                <Text style={styles.optionTitle}>{t('amocrm.import.includeLeads', { defaultValue: 'Импортировать сделки' })}</Text>
                <Text style={styles.muted}>{t('amocrm.import.includeLeadsHint', { defaultValue: 'Сделки попадут в соответствующие этапы воронок.' })}</Text>
              </View>
              <Switch
                value={includeLeads}
                onValueChange={setIncludeLeads}
                disabled={importMutation.isPending}
                trackColor={{ false: colors.borderStrong, true: colors.orange }}
              />
            </View>

            {canImport ? (
              <AmoButton
                colors={colors}
                label={t('amocrm.import.start', { defaultValue: 'Импортировать из amoCRM' })}
                onPress={confirmImport}
                busy={importMutation.isPending}
                disabled={!previewQuery.data}
              />
            ) : (
              <AmoNotice colors={colors} tone="warning">
                {t('amocrm.import.forbidden', {
                  defaultValue: 'Для импорта нужна возможность массово изменять контакты.',
                })}
              </AmoNotice>
            )}
            {importError ? <AmoNotice colors={colors} tone="error">{importError}</AmoNotice> : null}

            {importResult ? (
              <View style={styles.resultBox}>
                <Text style={styles.subheading}>{t('amocrm.import.resultTitle', { defaultValue: 'Результат импорта' })}</Text>
                <Text style={styles.resultText}>
                  {t('amocrm.import.resultContacts', {
                    defaultValue: 'Контакты: {{imported}} добавлено/обновлено, {{failed}} с ошибкой.',
                    imported: importResult.contacts_imported,
                    failed: importResult.contacts_failed,
                  })}
                </Text>
                <Text style={styles.resultText}>
                  {t('amocrm.import.resultDeals', {
                    defaultValue: 'Сделки: {{imported}} добавлено/обновлено, {{failed}} с ошибкой.',
                    imported: importResult.deals_imported,
                    failed: importResult.deals_failed,
                  })}
                </Text>
                <Text style={styles.resultText}>
                  {t('amocrm.import.resultCompanies', {
                    defaultValue: 'Компании: {{seen}} обработано, {{failed}} с ошибкой.',
                    seen: importResult.companies_seen,
                    failed: importResult.companies_failed,
                  })}
                </Text>
                <Text style={styles.resultText}>
                  {t('amocrm.import.resultPipelines', {
                    defaultValue: 'Воронки: {{created}} создано, {{updated}} обновлено. Этапы: {{stagesCreated}} создано, {{stagesUpdated}} обновлено.',
                    created: importResult.pipelines_created,
                    updated: importResult.pipelines_updated,
                    stagesCreated: importResult.stages_created,
                    stagesUpdated: importResult.stages_updated,
                  })}
                </Text>
                {importResult.error ? (
                  <AmoNotice colors={colors} tone="warning">
                    {t('amocrm.import.partialError', {
                      defaultValue: 'Часть данных обработана, но amoCRM вернула ошибку. Можно продолжить с сохранённого места.',
                    })}
                  </AmoNotice>
                ) : null}
                {importResult.partial && importResult.cursor ? (
                  <AmoButton
                    colors={colors}
                    secondary
                    label={t('amocrm.import.continue', { defaultValue: 'Продолжить импорт' })}
                    onPress={() => runImport(importResult.cursor)}
                    busy={importMutation.isPending}
                  />
                ) : (
                  <AmoNotice colors={colors} tone="success">
                    {t('amocrm.import.complete', { defaultValue: 'Импорт завершён.' })}
                  </AmoNotice>
                )}
              </View>
            ) : null}
          </AmoSectionCard>
        ) : null}

        <Text style={styles.footer}>
          {t('amocrm.footer', {
            defaultValue: 'Токены и секреты никогда не показываются в приложении.',
          })}
        </Text>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    content: { padding: 14, paddingBottom: 44, gap: 14 },
    pageTitle: { color: c.text1, fontSize: 24, fontWeight: '800' },
    pageIntro: { color: c.textMuted, fontSize: 14, lineHeight: 20, marginTop: -8 },
    centered: { flex: 1, justifyContent: 'center', padding: 18 },
    loading: { paddingVertical: 28, alignItems: 'center', gap: 10 },
    inlineLoading: { flexDirection: 'row', alignItems: 'center', gap: 9 },
    flex: { flex: 1 },
    muted: { color: c.textMuted, fontSize: 12, lineHeight: 17 },
    connectionRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    statusDot: { width: 11, height: 11, borderRadius: 6 },
    connectionTitle: { color: c.text1, fontSize: 15, fontWeight: '700' },
    link: { color: c.orange, fontSize: 13, fontWeight: '700' },
    metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    detailRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 12,
      paddingVertical: 3,
    },
    detailLabel: { flex: 1, color: c.textMuted, fontSize: 13 },
    detailValue: { color: c.text1, fontSize: 13, fontWeight: '600', textAlign: 'right' },
    subheading: { color: c.text1, fontSize: 14, fontWeight: '700' },
    pipelineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderTopWidth: 1,
      borderTopColor: c.border,
      paddingTop: 9,
    },
    pipelineName: { color: c.text1, fontSize: 13, fontWeight: '600' },
    archiveBadge: {
      color: c.textMuted,
      backgroundColor: c.skeleton,
      borderRadius: 7,
      paddingHorizontal: 8,
      paddingVertical: 4,
      fontSize: 11,
    },
    optionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 3 },
    optionTitle: { color: c.text1, fontSize: 14, fontWeight: '600' },
    resultBox: {
      borderTopWidth: 1,
      borderTopColor: c.border,
      paddingTop: 12,
      gap: 8,
    },
    resultText: { color: c.text1, fontSize: 13, lineHeight: 19 },
    footer: { color: c.textMuted, textAlign: 'center', fontSize: 11, lineHeight: 16 },
  });
