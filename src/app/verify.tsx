import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView,
  ScrollView, ActivityIndicator, Platform, StyleSheet,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react-native';
import { useUserStore } from '../store/userStore';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';

const CODE_LENGTH = 6;
const CODE_REJECT_PATTERN = /[^0-9]/g;
/** POST /auth/verify/resend is rate-limited to 3 per 5 minutes on the server. */
const RESEND_COOLDOWN_S = 60;

/**
 * THE STEP THAT TURNS A CREATED ACCOUNT INTO A USABLE ONE.
 *
 * Invite acceptance used to hand back a seven-day session immediately, on an
 * address nobody had proven — so a forwarded link let anyone type any address,
 * including somebody else's, and use the organisation's CRM. Acceptance now
 * creates the account and mails a code; this screen is where the code is spent
 * and where `verifyOtp` mints the session.
 *
 * The invite is CONSUMED by the time anyone arrives here, so there is no "back"
 * that helps: the only ways out are a correct code or a resend. That is why the
 * address is shown (a typo is the likeliest reason no code arrives, and it is
 * worth seeing) and why resend is always reachable rather than hidden behind an
 * error state.
 */
export default function VerifyScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const { pendingVerification, verifyOtp, resendVerification } = useUserStore();

  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // Landing here with nothing pending means a reload or a deep link, not a
  // flow. There is no code to enter and no account to attach one to.
  useEffect(() => {
    if (pendingVerification === null) {
      router.replace('/login' as never);
    }
  }, [pendingVerification, router]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => { setCooldown((s) => s - 1); }, 1000);
    return () => { clearTimeout(timer); };
  }, [cooldown]);

  const handleSubmit = useCallback(async () => {
    if (pendingVerification === null || code.length !== CODE_LENGTH || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await verifyOtp(pendingVerification.userId, code, 'email');
      // `verifyOtp` reports failure by setting `error` on the store rather than
      // throwing, so success is read back off the store instead of inferred.
      const state = useUserStore.getState();
      if (state.error !== null || state.token === null) {
        setError(state.error ?? t('errors.unknown'));
        setCode('');
        return;
      }
      router.replace('/(tabs)' as never);
    } finally {
      setIsSubmitting(false);
    }
  }, [pendingVerification, code, isSubmitting, verifyOtp, router, t]);

  const handleResend = useCallback(async () => {
    if (pendingVerification === null || cooldown > 0) return;
    setError(null);
    // The countdown starts before the request and is the confirmation: the store
    // action is deliberately silent about failure, so a "sent" message would be
    // a claim this screen cannot make. The disabled button is one it can.
    setCooldown(RESEND_COOLDOWN_S);
    await resendVerification(pendingVerification.userId, 'email');
  }, [pendingVerification, cooldown, resendVerification]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.circle1} pointerEvents="none" />
      <View style={styles.circle2} pointerEvents="none" />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.logoContainer}>
          <View style={styles.logoSquare}>
            <ShieldCheck size={32} color="#FFFFFF" strokeWidth={2.5} />
          </View>
        </View>

        <Text style={styles.title}>{t('auth.verifyTitle')}</Text>
        <Text style={styles.subtitle}>
          {t('auth.verifySubtext', { contact: pendingVerification?.email ?? '' })}
        </Text>

        <View style={styles.card}>
          <TextInput
            style={styles.codeInput}
            placeholder="000000"
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            inputMode="numeric"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={CODE_LENGTH}
            value={code}
            onChangeText={(raw) => {
              setCode(raw.replace(CODE_REJECT_PATTERN, '').slice(0, CODE_LENGTH));
              setError(null);
            }}
            accessibilityLabel={t('auth.verifyTitle')}
          />

          <TouchableOpacity
            style={[styles.button, (isSubmitting || code.length !== CODE_LENGTH) && styles.buttonDisabled]}
            onPress={() => { void handleSubmit(); }}
            disabled={isSubmitting || code.length !== CODE_LENGTH}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            {isSubmitting
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>{t('auth.verifyButton')}</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => { void handleResend(); }}
            disabled={cooldown > 0}
            style={styles.resendButton}
            accessibilityRole="button"
          >
            <Text style={[styles.resendText, cooldown > 0 && styles.resendTextDisabled]}>
              {cooldown > 0 ? t('auth.resendIn', { seconds: cooldown }) : t('auth.resendCode')}
            </Text>
          </TouchableOpacity>

          {error !== null && <Text style={styles.errorText}>{error}</Text>}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  circle1: {
    position: 'absolute', width: 350, height: 350, borderRadius: 175,
    backgroundColor: 'rgba(6,95,70,0.04)', top: -80, right: -100,
  },
  circle2: {
    position: 'absolute', width: 280, height: 280, borderRadius: 140,
    backgroundColor: 'rgba(6,95,70,0.03)', bottom: 100, left: -80,
  },
  scrollContent: {
    flexGrow: 1, justifyContent: 'center', alignItems: 'center',
    padding: 24, paddingTop: 60, paddingBottom: 40,
  },
  logoContainer: { marginBottom: 24 },
  logoSquare: {
    width: 80, height: 80, borderRadius: 20,
    backgroundColor: c.orange, justifyContent: 'center', alignItems: 'center',
    shadowColor: c.orange, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 12, elevation: 6,
  },
  title: { fontSize: 26, fontWeight: '700', color: c.text1, textAlign: 'center', marginBottom: 8 },
  subtitle: {
    fontSize: 14, color: c.amber, textAlign: 'center',
    marginBottom: 32, lineHeight: 20, paddingHorizontal: 12,
  },
  card: {
    width: '100%', maxWidth: 400, backgroundColor: c.bgPanel, borderRadius: 16, padding: 24,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  codeInput: {
    borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.bg,
    height: 60, marginBottom: 16, textAlign: 'center',
    fontSize: 28, fontWeight: '700', letterSpacing: 8, color: c.text1,
  },
  button: {
    height: 52, backgroundColor: c.orange, borderRadius: 12,
    justifyContent: 'center', alignItems: 'center', marginTop: 4,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  resendButton: { marginTop: 16, alignItems: 'center' },
  resendText: { color: c.orange, fontSize: 14, fontWeight: '600' },
  resendTextDisabled: { color: c.textMuted, fontWeight: '400' },
  errorText: { color: c.red, fontSize: 14, textAlign: 'center', marginTop: 12 },
});
