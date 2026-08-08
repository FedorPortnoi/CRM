import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView,
  ScrollView, ActivityIndicator, Platform, StyleSheet,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react-native';
import { API_URL } from '../utils/api';
import { checkPassword } from '../utils/password';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';

const CODE_LENGTH = 6;
const CODE_REJECT_PATTERN = /[^0-9]/g;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** POST /auth/forgot-password is limited to 3 per 15 minutes per (ip, email). */
const RESEND_COOLDOWN_S = 60;

/**
 * THE ONLY WAY BACK IN, AND UNTIL NOW IT DID NOT EXIST.
 *
 * `PATCH /auth/me/password` and `/auth/me/credentials` both need a session the
 * locked-out person does not have; `POST /auth/users/invite` creates a NEW
 * account rather than resetting one; and `/auth/invites/accept` answers 409
 * EMAIL_TAKEN at their own address. Recovery meant a hand-written UPDATE against
 * the production database, or a second account that stranded every contact, deal
 * and task the first one owned.
 *
 * TWO THINGS THIS SCREEN DELIBERATELY DOES NOT DO.
 *
 * It never reports whether the address is known. `POST /auth/forgot-password`
 * answers 202 for every address — that is what stops it being an account
 * enumeration oracle — so this screen cannot truthfully say "sent" either. It
 * says "if that address is on an account, a code is on its way", which is the
 * strongest true statement available, and moves to the code step regardless.
 *
 * And it does not sign the user in. `POST /auth/reset-password` returns no
 * token: a six-digit code should not be a login primitive. On success the user
 * is returned to the sign-in screen with their new password.
 *
 * NOTE FOR INVITED MEMBERS: this is keyed on the account's email. Employees
 * created by `POST /auth/users/invite` have a username and NO address until they
 * complete first-run setup, so this route cannot reach them and they still have
 * no self-service recovery — see the Known Gaps entry in
 * docs/architecture/api-design.md.
 */
export default function ForgotPasswordScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => { setCooldown((s) => s - 1); }, 1000);
    return () => { clearTimeout(timer); };
  }, [cooldown]);

  const requestCode = useCallback(async () => {
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalized)) {
      setError('Проверьте адрес электронной почты');
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      // Fire and forget, like the resend action: the server answers identically
      // whatever the address resolves to, so there is nothing in the response
      // worth branching on and reading it would only invite someone to.
      await fetch(`${API_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalized }),
      });
    } catch {
      // Offline is the one failure worth naming, and it is indistinguishable
      // from a slow network here; the code step is still the right next screen.
    } finally {
      setIsSubmitting(false);
      setCooldown(RESEND_COOLDOWN_S);
      setStep('code');
    }
  }, [email, t]);

  const submitReset = useCallback(async () => {
    if (code.length !== CODE_LENGTH) {
      setError(t('auth.codeInvalid'));
      return;
    }

    const problem = checkPassword(newPassword);
    if (problem === 'weak') { setError(t('auth.passwordWeak')); return; }
    if (problem === 'tooLong') { setError(t('auth.passwordTooLong')); return; }
    if (problem === 'common') { setError(t('auth.passwordCommon')); return; }

    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(`${API_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          code,
          new_password: newPassword,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null) as
          { error?: { message?: string } } | null;
        // Every failure mode answers one 400 INVALID_CODE, so there is nothing
        // more specific to show and nothing here can leak which one it was.
        setError(body?.error?.message ?? t('auth.codeInvalid'));
        setCode('');
        return;
      }

      // No token comes back, by design. Straight to sign-in.
      router.replace('/login' as never);
    } catch {
      setError(t('errors.networkError'));
    } finally {
      setIsSubmitting(false);
    }
  }, [code, newPassword, email, router, t]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.logoContainer}>
          <View style={styles.logoSquare}>
            <KeyRound size={32} color="#FFFFFF" strokeWidth={2.5} />
          </View>
        </View>

        <Text style={styles.title}>{t('auth.forgotPassword')}</Text>
        <Text style={styles.subtitle}>
          {step === 'email' ? t('auth.forgotPasswordIntro') : t('auth.forgotPasswordSent')}
        </Text>

        <View style={styles.card}>
          {step === 'email' ? (
            <>
              <TextInput
                style={styles.input}
                placeholder={t('auth.email')}
                placeholderTextColor={colors.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                value={email}
                onChangeText={setEmail}
              />
              <TouchableOpacity
                style={[styles.button, isSubmitting && styles.buttonDisabled]}
                disabled={isSubmitting}
                onPress={requestCode}
                accessibilityRole="button"
              >
                {isSubmitting
                  ? <ActivityIndicator color="#FFFFFF" />
                  : <Text style={styles.buttonText}>{t('auth.sendCode')}</Text>}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TextInput
                style={styles.codeInput}
                placeholder="000000"
                placeholderTextColor={colors.placeholder}
                keyboardType="number-pad"
                maxLength={CODE_LENGTH}
                value={code}
                onChangeText={(value) => { setCode(value.replace(CODE_REJECT_PATTERN, '')); }}
              />
              <TextInput
                style={styles.input}
                placeholder={t('auth.newPassword')}
                placeholderTextColor={colors.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                value={newPassword}
                onChangeText={setNewPassword}
              />
              <TouchableOpacity
                style={[styles.button, isSubmitting && styles.buttonDisabled]}
                disabled={isSubmitting}
                onPress={submitReset}
                accessibilityRole="button"
              >
                {isSubmitting
                  ? <ActivityIndicator color="#FFFFFF" />
                  : <Text style={styles.buttonText}>{t('auth.resetPassword')}</Text>}
              </TouchableOpacity>

              <TouchableOpacity
                disabled={cooldown > 0}
                onPress={requestCode}
                accessibilityRole="button"
                style={styles.resend}
              >
                <Text style={[styles.resendText, cooldown > 0 && styles.resendDisabled]}>
                  {cooldown > 0
                    ? t('auth.resendIn', { seconds: cooldown })
                    : t('auth.resendCode')}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {error !== null && <Text style={styles.error}>{error}</Text>}
        </View>

        <TouchableOpacity onPress={() => { router.replace('/login' as never); }} accessibilityRole="button">
          <Text style={styles.backLink}>{t('auth.backToLogin')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scrollContent: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  logoContainer: { alignItems: 'center', marginBottom: 24 },
  logoSquare: {
    width: 64, height: 64, borderRadius: 16, backgroundColor: colors.orange,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 24, fontWeight: '700', color: colors.text1, textAlign: 'center' },
  subtitle: {
    fontSize: 14, color: colors.textMuted, textAlign: 'center',
    marginTop: 8, marginBottom: 24, paddingHorizontal: 8,
  },
  card: {
    backgroundColor: colors.bgPanel, borderRadius: 16, padding: 20,
    borderWidth: 1, borderColor: colors.border,
  },
  input: {
    height: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, color: colors.text1, marginBottom: 12,
  },
  codeInput: {
    height: 56, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    textAlign: 'center', fontSize: 24, letterSpacing: 8,
    color: colors.text1, marginBottom: 12,
  },
  button: {
    height: 48, borderRadius: 12, backgroundColor: colors.orange,
    alignItems: 'center', justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  resend: { marginTop: 14, alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  resendText: { color: colors.orange, fontSize: 14, fontWeight: '600' },
  resendDisabled: { color: colors.textMuted },
  error: { color: colors.red, fontSize: 13, marginTop: 12, textAlign: 'center' },
  backLink: {
    color: colors.textMuted, fontSize: 14, textAlign: 'center',
    marginTop: 20, textDecorationLine: 'underline',
  },
});
