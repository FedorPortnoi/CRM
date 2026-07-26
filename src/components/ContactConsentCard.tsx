// Marketing-consent panel on the contact card (ФЗ-38 «О рекламе», ст. 18).
//
// Backend: GET    /api/v1/consent/contacts/:contactId
//          POST   /api/v1/consent/contacts/:contactId   { source }
//          DELETE /api/v1/consent/contacts/:contactId
// i18n:    consent.*
//
// This panel is the evidence an operator would have to produce, so the date and the source
// are laid out as labelled rows — never collapsed into a badge or hidden behind a tap.
//
// Recording consent is a legal act, so the source is mandatory: the picker has no default and
// nothing is sent until one is chosen. Withdrawal is behind a confirmation because it also
// stops every sequence the contact is in, org-wide, and the server reports how many.
//
// A `viewer` is refused any non-GET by the global role rule in backend/api/authenticate.ts,
// so the controls are hidden rather than shown and then rejected.
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../store/userStore';
import { formatMarketDateTime } from '../market/profile';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';
import {
  CONSENT_SOURCES,
  useContactConsent,
  useRecordConsent,
  useWithdrawConsent,
  type ConsentSource,
  type ConsentState,
} from '../hooks/useContactConsent';

interface Props {
  contactId: string;
  /** Decrypted contact email, when the contact record has already loaded. */
  contactEmail?: string | null;
}

/** Full date and time — a bare day is not enough to evidence when consent was given. */
function evidenceTimestamp(value: string | null): string {
  return formatMarketDateTime(value, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type ConsentStatus = 'granted' | 'unsubscribed' | 'missing';

function statusOf(state: ConsentState | undefined): ConsentStatus {
  if (!state) return 'missing';
  if (state.unsubscribed_at !== null) return 'unsubscribed';
  if (state.marketing_consent) return 'granted';
  return 'missing';
}

export default function ContactConsentCard({ contactId, contactEmail }: Props): JSX.Element {
  const { t } = useTranslation();
  const role = useUserStore((s) => s.user?.role);
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const canEdit = role !== 'viewer';

  const consentQuery = useContactConsent(contactId);
  const recordConsent = useRecordConsent(contactId);
  const withdrawConsent = useWithdrawConsent(contactId);

  const [isSourcePickerVisible, setIsSourcePickerVisible] = useState<boolean>(false);

  const state = consentQuery.data;
  const status = statusOf(state);
  const isSaving = recordConsent.isPending || withdrawConsent.isPending;
  const saveError = recordConsent.error ?? withdrawConsent.error;

  // Only shown after a withdrawal in this session — the read endpoint does not carry it.
  const stoppedEnrollments = withdrawConsent.data?.stopped_enrollments ?? null;

  const statusLabel = useMemo(() => {
    if (status === 'unsubscribed') return t('consent.statusUnsubscribed');
    if (status === 'granted') return t('consent.statusGranted');
    return t('consent.statusMissing');
  }, [status, t]);

  const statusColor = status === 'granted' ? colors.orange : status === 'unsubscribed' ? colors.red : colors.textMuted;

  const grant = useCallback(
    (source: ConsentSource): void => {
      setIsSourcePickerVisible(false);
      withdrawConsent.reset();
      recordConsent.mutate(source);
    },
    [recordConsent, withdrawConsent],
  );

  const confirmWithdraw = useCallback((): void => {
    Alert.alert(t('consent.withdrawConfirmTitle'), t('consent.withdrawConfirmBody'), [
      { text: t('consent.cancel'), style: 'cancel' },
      {
        text: t('consent.withdrawConfirmAction'),
        style: 'destructive',
        onPress: () => {
          recordConsent.reset();
          withdrawConsent.mutate();
        },
      },
    ]);
  }, [recordConsent, withdrawConsent, t]);

  // The source is stored verbatim, so a value outside the known vocabulary (an import, or a
  // future server-side addition) has to render as itself rather than as a missing key.
  const sourceLabel = useCallback(
    (source: string): string => {
      const known = (CONSENT_SOURCES as readonly string[]).includes(source);
      return known ? t(`consent.source_${source}`) : source;
    },
    [t],
  );

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t('consent.title')}</Text>

      <View style={styles.card}>
        {consentQuery.isPending ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.orange} />
            <Text style={styles.hint}>{t('consent.loading')}</Text>
          </View>
        ) : consentQuery.isError ? (
          <View>
            <Text style={styles.errorText}>{t('consent.failedToLoad')}</Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => { void consentQuery.refetch(); }}
              accessibilityRole="button"
            >
              <Text style={styles.retryText}>{t('consent.retry')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.statusRow}>
              <View style={styles.statusLabelRow}>
                <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                <Text style={styles.statusText}>{statusLabel}</Text>
              </View>
              <View
                style={[
                  styles.badge,
                  state?.can_send_marketing ? styles.badgeAllowed : styles.badgeBlocked,
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    { color: state?.can_send_marketing ? colors.orange : colors.red },
                  ]}
                >
                  {state?.can_send_marketing ? t('consent.canSend') : t('consent.cannotSend')}
                </Text>
              </View>
            </View>

            {/* The evidence itself: when consent was obtained and how. */}
            {status === 'granted' && state ? (
              <View style={styles.evidence}>
                <Text style={styles.evidenceTitle}>{t('consent.evidenceTitle')}</Text>
                <View style={styles.evidenceRow}>
                  <Text style={styles.evidenceLabel}>{t('consent.grantedAtLabel')}</Text>
                  <Text style={styles.evidenceValue}>
                    {state.marketing_consent_at !== null
                      ? evidenceTimestamp(state.marketing_consent_at)
                      : t('consent.unknownDate')}
                  </Text>
                </View>
                <View style={styles.evidenceRow}>
                  <Text style={styles.evidenceLabel}>{t('consent.sourceLabel')}</Text>
                  <Text style={styles.evidenceValue}>
                    {state.marketing_consent_source !== null
                      ? sourceLabel(state.marketing_consent_source)
                      : t('consent.unknownSource')}
                  </Text>
                </View>
              </View>
            ) : null}

            {status === 'unsubscribed' && state ? (
              <View style={styles.evidence}>
                <View style={styles.evidenceRow}>
                  <Text style={styles.evidenceLabel}>{t('consent.unsubscribedAtLabel')}</Text>
                  <Text style={styles.evidenceValue}>{evidenceTimestamp(state.unsubscribed_at)}</Text>
                </View>
                <Text style={styles.hint}>{t('consent.unsubscribedHint')}</Text>
              </View>
            ) : null}

            {status === 'missing' ? <Text style={styles.hint}>{t('consent.missingHint')}</Text> : null}

            {contactEmail === null ? <Text style={styles.hint}>{t('consent.noEmailHint')}</Text> : null}

            {stoppedEnrollments !== null && stoppedEnrollments > 0 ? (
              <Text style={styles.hint}>
                {t('consent.stoppedEnrollments', { count: stoppedEnrollments })}
              </Text>
            ) : null}

            <Text style={styles.legalNote}>{t('consent.legalNote')}</Text>

            {saveError ? <Text style={styles.errorText}>{t('consent.failedToSave')}</Text> : null}

            {!canEdit ? (
              <Text style={styles.hint}>{t('consent.readOnlyRole')}</Text>
            ) : isSaving ? (
              <ActivityIndicator color={colors.orange} style={styles.actionLoader} />
            ) : (
              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={() => setIsSourcePickerVisible(true)}
                  accessibilityRole="button"
                  activeOpacity={0.7}
                >
                  <Text style={styles.primaryButtonText}>
                    {status === 'granted' ? t('consent.updateRecord') : t('consent.grant')}
                  </Text>
                </TouchableOpacity>
                {/* Already unsubscribed is terminal — withdrawing again would be a no-op. */}
                {status !== 'unsubscribed' ? (
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={confirmWithdraw}
                    accessibilityRole="button"
                    activeOpacity={0.7}
                  >
                    <Text style={styles.secondaryButtonText}>{t('consent.withdraw')}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            )}
          </>
        )}
      </View>

      <Modal
        visible={isSourcePickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIsSourcePickerVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('consent.selectSource')}</Text>
            <Text style={styles.hint}>{t('consent.selectSourceHint')}</Text>
            {status === 'unsubscribed' ? (
              <Text style={styles.warningText}>{t('consent.regrantWarning')}</Text>
            ) : null}
            <ScrollView style={styles.modalScroll}>
              {CONSENT_SOURCES.map((source) => (
                <TouchableOpacity
                  key={source}
                  style={styles.sourceRow}
                  onPress={() => grant(source)}
                  accessibilityRole="button"
                >
                  <Text style={styles.sourceText}>{t(`consent.source_${source}`)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={styles.modalClose}
              onPress={() => setIsSourcePickerVisible(false)}
              accessibilityRole="button"
            >
              <Text style={styles.modalCloseText}>{t('consent.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  // The contact screen's ScrollView already pads 16 — matching its section rhythm exactly.
  section: { marginTop: 20 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: c.amber,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  card: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    padding: 16,
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  statusLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 15, fontWeight: '600', color: c.text1, flexShrink: 1 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  badgeAllowed: { backgroundColor: 'rgba(204,120,92,0.08)' },
  badgeBlocked: { backgroundColor: 'rgba(204,82,71,0.12)' },
  badgeText: { fontSize: 11, fontWeight: '700' },
  evidence: {
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: 10,
    marginTop: 2,
    gap: 6,
  },
  evidenceTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: c.amber,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  evidenceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  evidenceLabel: { fontSize: 13, color: c.textMuted, width: 110 },
  evidenceValue: { fontSize: 13, color: c.text1, flex: 1, fontWeight: '500' },
  hint: { fontSize: 12, color: c.amber, lineHeight: 17 },
  warningText: { fontSize: 12, color: c.red, lineHeight: 17, marginTop: 4 },
  legalNote: { fontSize: 11, color: c.textMuted, lineHeight: 16, marginTop: 2 },
  errorText: { fontSize: 13, color: c.red, marginBottom: 4 },
  retryButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: c.orange,
    borderRadius: 6,
  },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  actionLoader: { marginTop: 10 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  primaryButton: {
    flex: 1,
    backgroundColor: c.orange,
    borderRadius: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700', textAlign: 'center' },
  secondaryButton: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.red,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  secondaryButtonText: { color: c.red, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  modalBackdrop: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: c.bgPanel,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '80%',
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: c.text1, marginBottom: 6 },
  modalScroll: { marginTop: 8 },
  sourceRow: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.border },
  sourceText: { fontSize: 15, color: c.text1 },
  modalClose: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 20 },
  modalCloseText: { color: c.orange, fontSize: 14, fontWeight: '700' },
});
