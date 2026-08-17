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

const TOTP_CODE_LENGTH = 6;
const TOTP_REJECT_PATTERN = /[^0-9]/g;
// XXXX-XXXX: 8 characters from the server's backup-code alphabet plus the
// separator. The server strips non-alphanumeric characters and uppercases
// before comparing, so the dash and case only matter for readability here.
const BACKUP_CODE_MAX_LENGTH = 9;
const BACKUP_CODE_REJECT_PATTERN = /[^A-Za-z0-9-]/g;

type CodeMode = 'totp' | 'backup';

/**
 * STEP TWO OF A LOGIN THAT ALREADY PROVED THE PASSWORD.
 *
 * login() and join() land the user here — instead of on the tabs — when the
 * server answers 403 TOTP_REQUIRED: the password was right, but the account
 * has 2FA turned on. There is no session yet, so this screen (and the
 * POST /auth/2fa/verify call behind it) is deliberately public — mirrors
 * verify.tsx's shape exactly, down to reading success/failure back off the
 * store rather than a thrown error, because verifyTotp is written the same
 * way verifyOtp is.
 *
 * The backup-code toggle exists because a lost phone is the normal failure
 * mode for TOTP, not an edge case: the same `code` field and the same
 * verifyTotp call accept either a live 6-digit TOTP or an XXXX-XXXX backup
 * code, so this is a formatting switch, not a different flow.
 */
export default function VerifyTotpScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const { pendingTotp, verifyTotp } = useUserStore();

  const [mode, setMode] = useState<CodeMode>('totp');
  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Landing here with nothing pending means a reload or a deep link, not a
  // flow. There is no challenge to answer and no account to attach one to.
  useEffect(() => {
    if (pendingTotp === null) {
      router.replace('/login' as never);
    }
  }, [pendingTotp, router]);

  const isTotpMode = mode === 'totp';
  const codeLength = isTotpMode ? TOTP_CODE_LENGTH : BACKUP_CODE_MAX_LENGTH;
  // A backup code is valid at 8 characters whether or not the user typed the
  // separating dash themselves — the server strips it either way, and typing
  // exactly "XXXX-XXXX" should not be a requirement the button silently enforces.
  const isCodeComplete = isTotpMode
    ? code.length === TOTP_CODE_LENGTH
    : code.replace(/-/g, '').length === 8;

  const handleToggleMode = useCallback(() => {
    setMode((m) => (m === 'totp' ? 'backup' : 'totp'));
    setCode('');
    setError(null);
  }, []);

  const handleChangeCode = useCallback((raw: string) => {
    const pattern = isTotpMode ? TOTP_REJECT_PATTERN : BACKUP_CODE_REJECT_PATTERN;
    const cleaned = isTotpMode ? raw.replace(pattern, '') : raw.replace(pattern, '').toUpperCase();
    setCode(cleaned.slice(0, codeLength));
    setError(null);
  }, [isTotpMode, codeLength]);

  const handleSubmit = useCallback(async () => {
    if (pendingTotp === null || !isCodeComplete || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await verifyTotp(pendingTotp.userId, code);
      // verifyTotp reports failure by setting `error` on the store rather than
      // throwing, so success is read back off the store instead of inferred.
      const state = useUserStore.getState();
      if (state.error !== null || state.token === null) {
        setError(state.error ?? t('auth.codeInvalid'));
        setCode('');
        return;
      }
      router.replace('/(tabs)' as never);
    } finally {
      setIsSubmitting(false);
    }
  }, [pendingTotp, code, isCodeComplete, isSubmitting, verifyTotp, router, t]);

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

        <Text style={styles.title}>{t('auth.verifyTotpTitle')}</Text>
        <Text style={styles.subtitle}>{t('auth.verifyTotpSubtitle')}</Text>

        <View style={styles.card}>
          <TextInput
            style={styles.codeInput}
            placeholder={isTotpMode ? '000000' : t('auth.verifyTotpBackupPlaceholder')}
            placeholderTextColor={colors.placeholder}
            keyboardType={isTotpMode ? 'number-pad' : 'default'}
            inputMode={isTotpMode ? 'numeric' : 'text'}
            autoCapitalize="characters"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={codeLength}
            value={code}
            onChangeText={handleChangeCode}
            accessibilityLabel={isTotpMode ? t('auth.verifyTotpTitle') : t('auth.verifyTotpBackupLabel')}
          />

          <TouchableOpacity
            style={[styles.button, (isSubmitting || !isCodeComplete) && styles.buttonDisabled]}
            onPress={() => { void handleSubmit(); }}
            disabled={isSubmitting || !isCodeComplete}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            {isSubmitting
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>{t('auth.verifyTotpButton')}</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleToggleMode}
            style={styles.toggleButton}
            accessibilityRole="button"
          >
            <Text style={styles.toggleText}>
              {isTotpMode ? t('auth.verifyTotpUseBackupCode') : t('auth.verifyTotpUseAuthenticatorCode')}
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
  toggleButton: { marginTop: 16, alignItems: 'center' },
  toggleText: { color: c.orange, fontSize: 14, fontWeight: '600' },
  errorText: { color: c.red, fontSize: 14, textAlign: 'center', marginTop: 12 },
});
