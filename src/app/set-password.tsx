import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView,
  ScrollView, ActivityIndicator, Platform, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Lock, Mail, Eye, EyeOff, ShieldCheck, CheckCircle2, Circle } from 'lucide-react-native';
import { Stack } from 'expo-router';
import { useUserStore } from '../store/userStore';
import { checkPassword } from '../utils/password';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The same five checks checkPassword()/PasswordSchema enforce, decomposed so
 * each can be shown live rather than only surfacing as one rejection message
 * after a failed submit — mirrors PASSWORD_RULES in InviteScreen.tsx (same
 * wording, same regexes) rather than inventing a second phrasing of the policy.
 */
const PASSWORD_RULES: { key: string; test: (value: string) => boolean }[] = [
  { key: 'passwordRuleLength', test: (v) => v.length >= 8 },
  { key: 'passwordRuleLower', test: (v) => /[a-z]/.test(v) },
  { key: 'passwordRuleUpper', test: (v) => /[A-Z]/.test(v) },
  { key: 'passwordRuleDigit', test: (v) => /[0-9]/.test(v) },
  { key: 'passwordRuleSymbol', test: (v) => /[^A-Za-z0-9]/.test(v) },
];

export default function SetPasswordScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const { user, changePassword, setCredentials } = useUserStore();

  const needsEmail = user?.must_change_email === true;

  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    if (needsEmail && !EMAIL_PATTERN.test(email.trim().toLowerCase())) {
      setError(t('auth.emailInvalidShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    // Shared with InviteScreen and mirroring PasswordSchema on the server. This
    // screen used to check length alone, so every invited employee who picked a
    // weak password sailed past the client and got a raw English zod string
    // back inside a Russian UI.
    const problem = checkPassword(newPassword);
    if (problem === 'weak') {
      setError(t('auth.passwordWeak'));
      return;
    }
    if (problem === 'tooLong') {
      setError(t('auth.passwordTooLong'));
      return;
    }
    if (problem === 'common') {
      setError(t('auth.passwordCommon'));
      return;
    }
    setIsLoading(true);
    try {
      let outcome: 'authenticated' | 'verification-required' | 'login-required';
      if (needsEmail) {
        outcome = await setCredentials(email.trim().toLowerCase(), newPassword);
        // The server may now require the new address to be proven by an emailed
        // code. When it does, setCredentials populates pendingVerification and the
        // old session is gone — the only next screen is /verify, which mints the
        // real session on success. The explicit outcome prevents the revoked
        // caller token from being mistaken for an authenticated result.
        if (outcome === 'verification-required') {
          router.replace('/verify' as never);
          return;
        }
      } else {
        outcome = await changePassword(newPassword);
      }
      // Compatibility with an API version that already revokes all sessions but
      // predates replacement-token responses: explicitly sign in again instead
      // of entering the tabs with a JWT whose session id is dead.
      if (outcome === 'login-required') {
        router.replace('/login' as never);
        return;
      }
      router.replace((user?.onboarding_completed === false ? '/onboarding' : '/(tabs)') as never);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('errors.unknown'));
    } finally {
      setIsLoading(false);
    }
  };

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

        <Text style={styles.title}>{t('auth.setPasswordTitle', { name: user?.name ?? '' })}</Text>
        <Text style={styles.subtitle}>{needsEmail ? t('auth.setCredentialsSubtitle') : t('auth.setPasswordSubtitle')}</Text>

        <View style={styles.card}>
          {needsEmail && (
            <View style={styles.fieldWrapper}>
              <Mail size={18} color={colors.textMuted} />
              <TextInput
                style={[styles.input, styles.inputFlex]}
                placeholder={t('auth.emailPlaceholder')}
                placeholderTextColor={colors.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                inputMode="email"
                value={email}
                onChangeText={setEmail}
              />
            </View>
          )}

          <View style={styles.fieldWrapper}>
            <Lock size={18} color={colors.textMuted} />
            <TextInput
              style={[styles.input, styles.inputFlex]}
              placeholder={t('auth.newPassword')}
              placeholderTextColor={colors.placeholder}
              secureTextEntry={!showNew}
              value={newPassword}
              onChangeText={setNewPassword}
            />
            <TouchableOpacity onPress={() => setShowNew(p => !p)} style={styles.eyeButton} accessibilityRole="button">
              {showNew ? <EyeOff size={18} color={colors.textMuted} /> : <Eye size={18} color={colors.textMuted} />}
            </TouchableOpacity>
          </View>

          <View accessibilityRole="summary" style={styles.rules}>
            <Text style={styles.rulesTitle}>{t('auth.passwordRulesTitle')}</Text>
            {PASSWORD_RULES.map((rule) => {
              const met = rule.test(newPassword);
              const label = t(`auth.${rule.key}`);
              return (
                <View key={rule.key} style={styles.ruleRow}>
                  {met
                    ? <CheckCircle2 size={16} color={colors.green} />
                    : <Circle size={16} color={colors.textMuted} />}
                  <Text
                    accessibilityLabel={`${label}: ${met ? t('auth.passwordRuleMet') : t('auth.passwordRuleUnmet')}`}
                    style={[styles.ruleText, met && styles.ruleTextMet]}
                  >
                    {label}
                  </Text>
                </View>
              );
            })}
          </View>

          <View style={styles.fieldWrapper}>
            <Lock size={18} color={colors.textMuted} />
            <TextInput
              style={[styles.input, styles.inputFlex]}
              placeholder={t('auth.confirmPassword')}
              placeholderTextColor={colors.placeholder}
              secureTextEntry={!showConfirm}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
            />
            <TouchableOpacity onPress={() => setShowConfirm(p => !p)} style={styles.eyeButton} accessibilityRole="button">
              {showConfirm ? <EyeOff size={18} color={colors.textMuted} /> : <Eye size={18} color={colors.textMuted} />}
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={() => { void handleSubmit(); }}
            disabled={isLoading || !newPassword || !confirmPassword || (needsEmail && !email)}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            {isLoading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>{needsEmail ? t('auth.setCredentialsButton') : t('auth.setPasswordButton')}</Text>}
          </TouchableOpacity>

          {error !== null && (
            <Text style={styles.errorText}>{error}</Text>
          )}
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
  fieldWrapper: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1,
    borderColor: c.border, borderRadius: 12, backgroundColor: c.bg,
    paddingHorizontal: 14, marginBottom: 14, height: 52, gap: 10,
  },
  input: { flex: 1, fontSize: 15, color: c.text1 },
  inputFlex: { flex: 1 },
  eyeButton: { padding: 4 },
  rules: {
    borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.bg,
    paddingVertical: 12, paddingHorizontal: 14, marginBottom: 14,
  },
  rulesTitle: { fontSize: 12.5, fontWeight: '700', color: c.text1, marginBottom: 8 },
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },
  ruleText: { flex: 1, fontSize: 12.5, lineHeight: 17, color: c.textMuted },
  ruleTextMet: { color: c.green, fontWeight: '700' },
  button: {
    height: 52, backgroundColor: c.orange, borderRadius: 12,
    justifyContent: 'center', alignItems: 'center', marginTop: 4,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  errorText: { color: c.red, fontSize: 14, textAlign: 'center', marginTop: 12 },
});
