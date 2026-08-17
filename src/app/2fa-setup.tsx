import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Image,
  ScrollView, ActivityIndicator, Platform, StyleSheet,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../store/userStore';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';

const CODE_LENGTH = 6;
const CODE_REJECT_PATTERN = /[^0-9]/g;

type Step = 'qr' | 'confirm' | 'backup-codes';

/** "ABCDEFGHIJKLMNOP" -> "ABCD EFGH IJKL MNOP" — easier to read and to key in by hand. */
function chunkSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(' ');
}

/**
 * THE ENROLLMENT WIZARD. Three steps, one screen, local step state — nothing
 * here is persisted server-side as "in progress": POST /2fa/setup mints a
 * pending secret that just sits there (encrypted, totp_enabled still false)
 * until POST /2fa/enable confirms it with a live code, so abandoning this
 * screen after step 'qr' leaves nothing dangerous behind, and re-opening it
 * simply overwrites the pending secret with a fresh one.
 *
 * Reached only from Settings → Security → "Set up", authenticated — unlike
 * /verify-totp this is not part of the public login flow.
 */
export default function TwoFactorSetupScreen(): JSX.Element {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const setupTotp = useUserStore((s) => s.setupTotp);
  const enableTotp = useUserStore((s) => s.enableTotp);

  const [step, setStep] = useState<Step>('qr');

  const [isLoadingSetup, setIsLoadingSetup] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [qrCode, setQrCode] = useState('');

  const [code, setCode] = useState('');
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  const loadSetup = useCallback(async (): Promise<void> => {
    setIsLoadingSetup(true);
    setSetupError(null);
    try {
      const result = await setupTotp();
      setSecret(result.secret);
      setQrCode(result.qrCode);
    } catch (e: unknown) {
      setSetupError(e instanceof Error ? e.message : t('settings.twoFactorSetupFailed'));
    } finally {
      setIsLoadingSetup(false);
    }
  }, [setupTotp, t]);

  // Runs once on mount — re-fetching on every re-render would silently
  // overwrite the secret the user is halfway through scanning.
  useEffect(() => {
    void loadSetup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (code.length !== CODE_LENGTH || isConfirming) return;
    setConfirmError(null);
    setIsConfirming(true);
    try {
      const result = await enableTotp(code);
      setBackupCodes(result.backupCodes);
      setStep('backup-codes');
    } catch (e: unknown) {
      setConfirmError(e instanceof Error ? e.message : t('auth.codeInvalid'));
      setCode('');
    } finally {
      setIsConfirming(false);
    }
  }, [code, isConfirming, enableTotp, t]);

  const handleGoBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/settings' as never);
    }
  }, [router]);

  const handleDone = useCallback(() => {
    // replace, not push: back-navigation from settings must not return into
    // the wizard — the backup codes it just showed cannot be shown again.
    router.replace('/(tabs)/settings' as never);
  }, [router]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('settings.twoFactorSetupTitle') }} />
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {step === 'qr' && (
          isLoadingSetup ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.orange} size="large" />
            </View>
          ) : setupError !== null ? (
            <View style={styles.card}>
              <Text style={styles.errorText}>{setupError}</Text>
              <TouchableOpacity style={styles.secondaryButton} onPress={handleGoBack} accessibilityRole="button">
                <Text style={styles.secondaryButtonText}>{t('settings.twoFactorGoBack')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.stepTitle}>{t('settings.twoFactorScanTitle')}</Text>
              <Text style={styles.stepSubtitle}>{t('settings.twoFactorScanInstructions')}</Text>

              {qrCode !== '' && (
                <View style={styles.qrWrapper}>
                  <Image
                    source={{ uri: qrCode }}
                    style={styles.qrImage}
                    resizeMode="contain"
                    accessibilityRole="image"
                    accessibilityLabel={t('settings.twoFactorScanTitle')}
                  />
                </View>
              )}

              <Text style={styles.secretLabel}>{t('settings.twoFactorSecretLabel')}</Text>
              <Text style={styles.secretText} selectable>{chunkSecret(secret)}</Text>

              <TouchableOpacity style={styles.button} onPress={() => setStep('confirm')} accessibilityRole="button">
                <Text style={styles.buttonText}>{t('settings.twoFactorContinue')}</Text>
              </TouchableOpacity>
            </View>
          )
        )}

        {step === 'confirm' && (
          <View style={styles.card}>
            <Text style={styles.stepTitle}>{t('settings.twoFactorConfirmTitle')}</Text>
            <Text style={styles.stepSubtitle}>{t('settings.twoFactorConfirmSubtitle')}</Text>

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
                setConfirmError(null);
              }}
              accessibilityLabel={t('settings.twoFactorConfirmTitle')}
            />

            <TouchableOpacity
              style={[styles.button, (isConfirming || code.length !== CODE_LENGTH) && styles.buttonDisabled]}
              onPress={() => { void handleConfirm(); }}
              disabled={isConfirming || code.length !== CODE_LENGTH}
              accessibilityRole="button"
            >
              {isConfirming
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.buttonText}>{t('settings.twoFactorConfirm')}</Text>}
            </TouchableOpacity>

            {confirmError !== null && <Text style={styles.errorText}>{confirmError}</Text>}
          </View>
        )}

        {step === 'backup-codes' && (
          <View style={styles.card}>
            <Text style={styles.stepTitle}>{t('settings.twoFactorBackupCodesTitle')}</Text>
            <Text style={styles.warningText}>{t('settings.twoFactorBackupCodesWarning')}</Text>

            <View style={styles.codesList}>
              {backupCodes.map((backupCode) => (
                <Text key={backupCode} style={styles.codeItem} selectable>{backupCode}</Text>
              ))}
            </View>

            <TouchableOpacity style={styles.button} onPress={handleDone} accessibilityRole="button">
              <Text style={styles.buttonText}>{t('settings.twoFactorSavedButton')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scrollContent: { flexGrow: 1, padding: 20, paddingBottom: 40 },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  card: {
    backgroundColor: c.bgPanel, borderWidth: 1, borderColor: c.border,
    borderRadius: 16, padding: 20,
  },
  stepTitle: { fontSize: 20, fontWeight: '700', color: c.text1, marginBottom: 8 },
  stepSubtitle: { fontSize: 14, color: c.textMuted, lineHeight: 20, marginBottom: 18 },
  qrWrapper: {
    alignSelf: 'center', width: 220, height: 220, borderRadius: 12,
    backgroundColor: '#FFFFFF', padding: 12, marginBottom: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  qrImage: { width: '100%', height: '100%' },
  secretLabel: { fontSize: 13, color: c.textMuted, marginBottom: 6 },
  secretText: {
    fontSize: 16, fontWeight: '700', letterSpacing: 1.5, color: c.text1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: c.inputBg, borderWidth: 1, borderColor: c.inputBorder,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    marginBottom: 20, textAlign: 'center',
  },
  codeInput: {
    borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.bg,
    height: 60, marginBottom: 16, textAlign: 'center',
    fontSize: 28, fontWeight: '700', letterSpacing: 8, color: c.text1,
  },
  button: {
    height: 52, backgroundColor: c.orange, borderRadius: 12,
    justifyContent: 'center', alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  secondaryButton: {
    height: 48, borderRadius: 12, borderWidth: 1, borderColor: c.border,
    justifyContent: 'center', alignItems: 'center', marginTop: 16,
  },
  secondaryButtonText: { color: c.text1, fontSize: 15, fontWeight: '600' },
  warningText: {
    fontSize: 13, color: c.amber, lineHeight: 19, marginBottom: 18,
    backgroundColor: 'rgba(204,120,92,0.08)', borderRadius: 10, padding: 12,
  },
  codesList: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 22,
  },
  codeItem: {
    width: '47%', fontSize: 15, fontWeight: '700', color: c.text1, textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: c.inputBg, borderWidth: 1, borderColor: c.inputBorder,
    borderRadius: 8, paddingVertical: 10,
  },
  errorText: { color: c.red, fontSize: 14, textAlign: 'center', marginTop: 12 },
});
