// Why a contact was NOT added to an email sequence.
//
// ФЗ-38 «О рекламе», ст. 18 — advertising email needs the recipient's prior consent, so
// backend/services/sequences.ts refuses the enrollment instead of quietly skipping it. That
// refusal is the compliance story of this feature, and a red toast would waste it: an
// operator who is told "422" learns nothing, an operator who is told "this person never
// agreed, here is how to ask them and where to write it down" fixes it in a minute.
//
// So every refusal gets: what happened, why it is the law, what to do next, and — where the
// fix lives on a contact — a button straight to that contact's card, which carries
// ContactConsentCard.
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';

/** The `error.code` values POST /sequences/:id/enrollments can answer with. */
type RefusalVariant =
  | 'consent'
  | 'unsubscribed'
  | 'noEmail'
  | 'already'
  | 'notFound'
  | 'noSteps'
  | 'archived'
  | 'generic';

type VariantSpec = {
  /** The remediation paragraph — omitted where there is nothing the operator can do here. */
  hasHow: boolean;
  /** Whether the fix lives on the contact card (consent, email address). */
  opensContact: boolean;
  /** Whether to print the statute the refusal comes from. */
  isLegal: boolean;
};

const VARIANTS: Record<RefusalVariant, VariantSpec> = {
  consent: { hasHow: true, opensContact: true, isLegal: true },
  unsubscribed: { hasHow: true, opensContact: true, isLegal: true },
  noEmail: { hasHow: true, opensContact: true, isLegal: false },
  already: { hasHow: false, opensContact: true, isLegal: false },
  notFound: { hasHow: false, opensContact: false, isLegal: false },
  noSteps: { hasHow: false, opensContact: false, isLegal: false },
  archived: { hasHow: false, opensContact: false, isLegal: false },
  generic: { hasHow: false, opensContact: false, isLegal: false },
};

const CODE_TO_VARIANT: Record<string, RefusalVariant> = {
  MARKETING_CONSENT_REQUIRED: 'consent',
  CONTACT_UNSUBSCRIBED: 'unsubscribed',
  CONTACT_NO_EMAIL: 'noEmail',
  ALREADY_ENROLLED: 'already',
  CONTACT_NOT_FOUND: 'notFound',
  SEQUENCE_HAS_NO_STEPS: 'noSteps',
  SEQUENCE_NOT_ENROLLABLE: 'archived',
};

export function refusalVariantFor(code: string): RefusalVariant {
  return CODE_TO_VARIANT[code] ?? 'generic';
}

interface Props {
  code: string;
  /** Empty when the contact is unknown (the sequence itself was the problem). */
  contactName: string;
  onOpenContact: () => void;
  onDismiss: () => void;
}

export default function ConsentRefusalNotice({
  code,
  contactName,
  onOpenContact,
  onDismiss,
}: Props): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const variant = refusalVariantFor(code);
  const spec = VARIANTS[variant];
  const suffix = variant.charAt(0).toUpperCase() + variant.slice(1);
  const name = contactName.length > 0 ? contactName : t('sequences.refusedThisContact');

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <ShieldAlert size={22} color={colors.orange} strokeWidth={2} />
        <Text style={styles.title}>{t(`sequences.refused${suffix}Title`)}</Text>
      </View>

      <Text style={styles.body}>{t(`sequences.refused${suffix}Body`, { name })}</Text>

      {spec.isLegal ? <Text style={styles.legal}>{t('sequences.refusedLegalNote')}</Text> : null}

      {spec.hasHow ? (
        <View style={styles.howCard}>
          <Text style={styles.howTitle}>{t('sequences.refusedHowTitle')}</Text>
          <Text style={styles.howText}>{t(`sequences.refused${suffix}How`)}</Text>
        </View>
      ) : null}

      {spec.opensContact ? (
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={onOpenContact}
          accessibilityRole="button"
        >
          <Text style={styles.primaryButtonText}>{t('sequences.refusedOpenContact')}</Text>
        </TouchableOpacity>
      ) : null}

      <TouchableOpacity
        style={styles.secondaryButton}
        onPress={onDismiss}
        accessibilityRole="button"
      >
        <Text style={styles.secondaryButtonText}>{t('sequences.refusedDismiss')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { gap: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { flex: 1, fontSize: 17, fontWeight: '700', color: c.text1 },
  body: { fontSize: 14, color: c.text1, lineHeight: 20 },
  legal: { fontSize: 12, color: c.textMuted, lineHeight: 17 },
  howCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: 'rgba(204,120,92,0.08)',
    padding: 12,
    gap: 4,
  },
  howTitle: { fontSize: 13, fontWeight: '700', color: c.orange },
  howText: { fontSize: 13, color: c.text1, lineHeight: 19 },
  primaryButton: {
    backgroundColor: c.orange,
    borderRadius: 10,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    marginTop: 4,
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  secondaryButton: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 20 },
  secondaryButtonText: { color: c.amber, fontSize: 15 },
});
