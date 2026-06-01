import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  ScrollView,
  ActivityIndicator,
  Platform,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react-native';
import { useUserStore } from '../store/userStore';

const RESEND_COOLDOWN = 60;

export default function VerifyOtpScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user, isLoading, error, pendingVerification, verifyOtp, resendVerification, clearPendingVerification } = useUserStore();

  const [code, setCode] = useState('');
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [cooldown, setCooldown] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!pendingVerification) {
      router.replace('/register' as never);
    }
  }, [pendingVerification, router]);

  useEffect(() => {
    if (!isLoading && error === null && user !== null) {
      router.replace((user.onboarding_completed === false ? '/onboarding' : '/(tabs)') as never);
    }
  }, [user, isLoading, error, router]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const startCooldown = () => {
    setCooldown(RESEND_COOLDOWN);
    intervalRef.current = setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleVerify = async () => {
    if (!pendingVerification || code.length !== 6) return;
    await verifyOtp(pendingVerification.userId, code, channel);
  };

  const handleResend = async () => {
    if (!pendingVerification || cooldown > 0) return;
    await resendVerification(pendingVerification.userId, channel);
    startCooldown();
  };

  const handleBack = () => {
    clearPendingVerification();
    router.replace('/register' as never);
  };

  if (!pendingVerification) return null;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.circle1} pointerEvents="none" />
      <View style={styles.circle2} pointerEvents="none" />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.logoContainer}>
          <View style={styles.logoSquare}>
            <ShieldCheck size={34} color="#FFFFFF" strokeWidth={2.5} />
          </View>
        </View>

        <Text style={styles.title}>{t('auth.verifyTitle')}</Text>
        <Text style={styles.subtitle}>
          {t('auth.verifySubtext', {
            contact: channel === 'email' ? pendingVerification.email : pendingVerification.phone,
          })}
        </Text>

        <View style={styles.card}>
          <View style={styles.channelRow}>
            <TouchableOpacity
              style={[styles.channelBtn, channel === 'email' && styles.channelBtnActive]}
              onPress={() => setChannel('email')}
              activeOpacity={0.7}
            >
              <Text style={[styles.channelBtnText, channel === 'email' && styles.channelBtnTextActive]}>
                Email
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.channelBtn, channel === 'sms' && styles.channelBtnActive]}
              onPress={() => setChannel('sms')}
              activeOpacity={0.7}
            >
              <Text style={[styles.channelBtnText, channel === 'sms' && styles.channelBtnTextActive]}>
                SMS
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.fieldWrapper}>
            <TextInput
              style={[styles.input, styles.codeInput]}
              placeholder="000000"
              placeholderTextColor="#CFADA3"
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
              textAlign="center"
              autoFocus
            />
          </View>

          <TouchableOpacity
            style={[styles.button, (isLoading || code.length !== 6) && styles.buttonDisabled]}
            onPress={() => { void handleVerify(); }}
            disabled={isLoading || code.length !== 6}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            {isLoading
              ? <ActivityIndicator color="#FFFFFF" />
              : <Text style={styles.buttonText}>{t('auth.verifyButton')}</Text>}
          </TouchableOpacity>

          {error !== null && (
            <Text style={styles.errorText}>{error}</Text>
          )}

          <TouchableOpacity
            style={[styles.resendButton, cooldown > 0 && styles.resendDisabled]}
            onPress={() => { void handleResend(); }}
            disabled={cooldown > 0}
            activeOpacity={0.7}
          >
            <Text style={[styles.resendText, cooldown > 0 && styles.resendTextDisabled]}>
              {cooldown > 0
                ? t('auth.resendIn', { seconds: cooldown })
                : t('auth.resendCode')}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.backLink}
            onPress={handleBack}
            activeOpacity={0.7}
          >
            <Text style={styles.backLinkText}>{t('auth.backToRegister')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  circle1: {
    position: 'absolute',
    width: 350,
    height: 350,
    borderRadius: 175,
    backgroundColor: 'rgba(6,95,70,0.04)',
    top: -80,
    right: -100,
  },
  circle2: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: 'rgba(6,95,70,0.03)',
    bottom: 100,
    left: -80,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    paddingTop: 48,
    paddingBottom: 40,
  },
  logoContainer: {
    marginBottom: 24,
  },
  logoSquare: {
    width: 80,
    height: 80,
    borderRadius: 20,
    backgroundColor: '#C45A10',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#C45A10',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#383432',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#B07868',
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 20,
    paddingHorizontal: 12,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  channelRow: {
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E8DDD6',
    overflow: 'hidden',
    marginBottom: 20,
  },
  channelBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#FAF6F3',
  },
  channelBtnActive: {
    backgroundColor: '#C45A10',
  },
  channelBtnText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#B07868',
  },
  channelBtnTextActive: {
    color: '#FFFFFF',
  },
  fieldWrapper: {
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    backgroundColor: '#FAF6F3',
    marginBottom: 14,
    height: 64,
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#383432',
    paddingHorizontal: 14,
  },
  codeInput: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 8,
    color: '#383432',
  },
  button: {
    height: 52,
    backgroundColor: '#C45A10',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 12,
  },
  resendButton: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 16,
  },
  resendDisabled: {
    opacity: 0.5,
  },
  resendText: {
    color: '#C45A10',
    fontSize: 14,
    fontWeight: '500',
  },
  resendTextDisabled: {
    color: '#B07868',
  },
  backLink: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backLinkText: {
    color: '#CFADA3',
    fontSize: 13,
  },
});
