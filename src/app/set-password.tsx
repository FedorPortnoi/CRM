import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView,
  ScrollView, ActivityIndicator, Platform, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Lock, Mail, Eye, EyeOff, ShieldCheck } from 'lucide-react-native';
import { Stack } from 'expo-router';
import { useUserStore } from '../store/userStore';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SetPasswordScreen() {
  const { t } = useTranslation();
  const router = useRouter();
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
    if (newPassword.length < 8) {
      setError(t('auth.passwordTooShort'));
      return;
    }
    setIsLoading(true);
    try {
      if (needsEmail) {
        await setCredentials(email.trim().toLowerCase(), newPassword);
      } else {
        await changePassword(newPassword);
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
              <Mail size={18} color="#CFADA3" />
              <TextInput
                style={[styles.input, styles.inputFlex]}
                placeholder={t('auth.emailPlaceholder')}
                placeholderTextColor="#CFADA3"
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
            <Lock size={18} color="#CFADA3" />
            <TextInput
              style={[styles.input, styles.inputFlex]}
              placeholder={t('auth.newPassword')}
              placeholderTextColor="#CFADA3"
              secureTextEntry={!showNew}
              value={newPassword}
              onChangeText={setNewPassword}
            />
            <TouchableOpacity onPress={() => setShowNew(p => !p)} style={styles.eyeButton} accessibilityRole="button">
              {showNew ? <EyeOff size={18} color="#CFADA3" /> : <Eye size={18} color="#CFADA3" />}
            </TouchableOpacity>
          </View>

          <View style={styles.fieldWrapper}>
            <Lock size={18} color="#CFADA3" />
            <TextInput
              style={[styles.input, styles.inputFlex]}
              placeholder={t('auth.confirmPassword')}
              placeholderTextColor="#CFADA3"
              secureTextEntry={!showConfirm}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
            />
            <TouchableOpacity onPress={() => setShowConfirm(p => !p)} style={styles.eyeButton} accessibilityRole="button">
              {showConfirm ? <EyeOff size={18} color="#CFADA3" /> : <Eye size={18} color="#CFADA3" />}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
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
    backgroundColor: '#C45A10', justifyContent: 'center', alignItems: 'center',
    shadowColor: '#C45A10', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 12, elevation: 6,
  },
  title: { fontSize: 26, fontWeight: '700', color: '#383432', textAlign: 'center', marginBottom: 8 },
  subtitle: {
    fontSize: 14, color: '#B07868', textAlign: 'center',
    marginBottom: 32, lineHeight: 20, paddingHorizontal: 12,
  },
  card: {
    width: '100%', maxWidth: 400, backgroundColor: '#ffffff', borderRadius: 16, padding: 24,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  fieldWrapper: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1,
    borderColor: '#E8DDD6', borderRadius: 12, backgroundColor: '#FAF6F3',
    paddingHorizontal: 14, marginBottom: 14, height: 52, gap: 10,
  },
  input: { flex: 1, fontSize: 15, color: '#383432' },
  inputFlex: { flex: 1 },
  eyeButton: { padding: 4 },
  button: {
    height: 52, backgroundColor: '#C45A10', borderRadius: 12,
    justifyContent: 'center', alignItems: 'center', marginTop: 4,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  errorText: { color: '#ef4444', fontSize: 14, textAlign: 'center', marginTop: 12 },
});
