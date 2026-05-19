import React, { useState, useEffect } from 'react';
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
import { Mail, Lock, Eye, EyeOff, Check } from 'lucide-react-native';
import { useUserStore } from '../store/userStore';

export default function LoginScreen() {
  const { t } = useTranslation();
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);

  const router = useRouter();
  const { user, isLoading, error, login } = useUserStore();

  useEffect(() => {
    if (!isLoading && error === null && user !== null) {
      router.replace('/(tabs)');
    }
  }, [user, isLoading, error]);

  const handleSignIn = async () => {
    await login(email, password);
  };

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
          <View style={styles.logoCircle}>
            <Check size={36} color="#FFFFFF" strokeWidth={3} />
          </View>
        </View>

        <Text style={styles.title}>{t('auth.welcomeBack')}</Text>
        <Text style={styles.subtitle}>{t('auth.loginSubtext')}</Text>

        <View style={styles.card}>
          <View style={styles.fieldWrapper}>
            <Mail size={18} color="#9ca3af" />
            <TextInput
              style={styles.input}
              placeholder={t('auth.email')}
              placeholderTextColor="#9ca3af"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              value={email}
              onChangeText={setEmail}
            />
          </View>

          <View style={styles.fieldWrapper}>
            <Lock size={18} color="#9ca3af" />
            <TextInput
              style={[styles.input, styles.inputFlex]}
              placeholder={t('auth.password')}
              placeholderTextColor="#9ca3af"
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={setPassword}
            />
            <TouchableOpacity
              onPress={() => { setShowPassword(prev => !prev); }}
              style={styles.eyeButton}
              accessibilityRole="button"
            >
              {showPassword
                ? <EyeOff size={18} color="#9ca3af" />
                : <Eye size={18} color="#9ca3af" />}
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.forgotWrapper} accessibilityRole="button">
            <Text style={styles.forgotText}>{t('auth.forgotPassword')}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={() => { void handleSignIn(); }}
            disabled={isLoading}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            {isLoading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>{t('auth.signIn')}</Text>}
          </TouchableOpacity>

          {error !== null && (
            <Text style={styles.errorText}>{error}</Text>
          )}

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>{t('auth.orDivider')}</Text>
            <View style={styles.dividerLine} />
          </View>

          <TouchableOpacity
            style={styles.registerLink}
            onPress={() => { router.push('/register'); }}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.registerLinkText}>{t('auth.newHereCreate')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0fdf8',
  },
  circle1: {
    position: 'absolute',
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: 'rgba(16,185,129,0.08)',
    top: -80,
    right: -80,
  },
  circle2: {
    position: 'absolute',
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: 'rgba(16,185,129,0.05)',
    bottom: 60,
    left: -70,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    paddingTop: 60,
    paddingBottom: 40,
  },
  logoContainer: {
    marginBottom: 24,
  },
  logoCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#10b981',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
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
  fieldWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    backgroundColor: '#f9fafb',
    paddingHorizontal: 14,
    marginBottom: 14,
    height: 52,
    gap: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#111827',
  },
  inputFlex: {
    flex: 1,
  },
  eyeButton: {
    padding: 4,
  },
  forgotWrapper: {
    alignSelf: 'flex-end',
    marginBottom: 20,
    marginTop: -4,
    paddingVertical: 4,
  },
  forgotText: {
    color: '#10b981',
    fontSize: 13,
    fontWeight: '500',
  },
  button: {
    height: 52,
    backgroundColor: '#10b981',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
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
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e5e7eb',
  },
  dividerText: {
    color: '#9ca3af',
    fontSize: 13,
    marginHorizontal: 12,
  },
  registerLink: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  registerLinkText: {
    color: '#10b981',
    fontSize: 14,
    fontWeight: '500',
  },
});
