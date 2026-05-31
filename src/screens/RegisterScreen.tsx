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
import { Mail, Lock, Eye, EyeOff, User, Building2, Sparkles } from 'lucide-react-native';
import { useUserStore } from '../store/userStore';

function isStrongPassword(password: string): boolean {
  return (
    password.length >= 8 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

export default function RegisterScreen() {
  const { t } = useTranslation();
  const [name, setName] = useState<string>('');
  const [orgName, setOrgName] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const router = useRouter();
  const { user, isLoading, error, register } = useUserStore();

  useEffect(() => {
    if (!isLoading && error === null && user !== null) {
      router.replace((user.onboarding_completed === false ? '/onboarding' : '/(tabs)') as never);
    }
  }, [user, isLoading, error, router]);

  const handleRegister = async () => {
    if (name.trim() === '') {
      setValidationError(t('auth.fieldRequired'));
      return;
    }
    if (orgName.trim() === '') {
      setValidationError(t('auth.fieldRequired'));
      return;
    }
    if (email.trim() === '' || !email.includes('@')) {
      setValidationError(t('auth.emailInvalid'));
      return;
    }
    if (!isStrongPassword(password)) {
      setValidationError(t('auth.passwordRequirements'));
      return;
    }
    setValidationError(null);
    await register(email, password, name, orgName);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.circle1} pointerEvents="none" />
      <View style={styles.circle2} pointerEvents="none" />
      <View style={styles.circle3} pointerEvents="none" />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.logoContainer}>
          <View style={styles.logoSquare}>
            <Sparkles size={34} color="#FFFFFF" strokeWidth={2.5} />
          </View>
        </View>

        <Text style={styles.title}>{t('auth.createAccountTitle')}</Text>
        <Text style={styles.subtitle}>{t('auth.createAccountSubtext')}</Text>

        <View style={styles.card}>
          <View style={styles.fieldWrapper}>
            <User size={18} color="#CFADA3" />
            <TextInput
              style={styles.input}
              placeholder={t('auth.name')}
              placeholderTextColor="#CFADA3"
              value={name}
              onChangeText={(v) => { setName(v); setValidationError(null); }}
              autoCapitalize="words"
            />
          </View>

          <View style={styles.fieldWrapper}>
            <Building2 size={18} color="#CFADA3" />
            <TextInput
              style={styles.input}
              placeholder={t('auth.orgName')}
              placeholderTextColor="#CFADA3"
              value={orgName}
              onChangeText={(v) => { setOrgName(v); setValidationError(null); }}
              autoCapitalize="words"
            />
          </View>

          <View style={styles.fieldWrapper}>
            <Mail size={18} color="#CFADA3" />
            <TextInput
              style={styles.input}
              placeholder={t('auth.email')}
              placeholderTextColor="#CFADA3"
              value={email}
              onChangeText={(v) => { setEmail(v); setValidationError(null); }}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.fieldWrapper}>
            <Lock size={18} color="#CFADA3" />
            <TextInput
              style={[styles.input, styles.inputFlex]}
              placeholder={t('auth.password')}
              placeholderTextColor="#CFADA3"
              value={password}
              onChangeText={(v) => { setPassword(v); setValidationError(null); }}
              secureTextEntry={!showPassword}
            />
            <TouchableOpacity
              onPress={() => { setShowPassword(prev => !prev); }}
              style={styles.eyeButton}
              accessibilityRole="button"
            >
              {showPassword
                ? <EyeOff size={18} color="#CFADA3" />
                : <Eye size={18} color="#CFADA3" />}
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={() => { void handleRegister(); }}
            disabled={isLoading}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            {isLoading
              ? <ActivityIndicator color="#FFFFFF" />
              : <Text style={styles.buttonText}>{t('auth.createAccountButton')}</Text>}
          </TouchableOpacity>

          {(validationError !== null || error !== null) && (
            <Text style={styles.errorText}>{validationError ?? error}</Text>
          )}

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>{t('auth.orDivider')}</Text>
            <View style={styles.dividerLine} />
          </View>

          <TouchableOpacity
            style={styles.loginLink}
            onPress={() => { router.push('/login'); }}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.loginLinkText}>{t('auth.alreadyHaveAccountSignIn')}</Text>
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
  circle3: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(6,95,70,0.03)',
    top: '40%',
    right: -60,
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
  fieldWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    backgroundColor: '#FAF6F3',
    paddingHorizontal: 14,
    marginBottom: 14,
    height: 52,
    gap: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#383432',
  },
  inputFlex: {
    flex: 1,
  },
  eyeButton: {
    padding: 4,
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
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#E8DDD6',
  },
  dividerText: {
    color: '#CFADA3',
    fontSize: 13,
    marginHorizontal: 12,
  },
  loginLink: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loginLinkText: {
    color: '#C45A10',
    fontSize: 14,
    fontWeight: '500',
  },
});
