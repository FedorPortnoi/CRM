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

type Tab = 'login' | 'join';

export default function LoginScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user, isLoading, error, login } = useUserStore();

  const [activeTab, setActiveTab] = useState<Tab>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!isLoading && error === null && user !== null) {
      if (user.must_change_password) {
        router.replace('/set-password' as never);
      } else {
        router.replace((user.onboarding_completed === false ? '/onboarding' : '/(tabs)') as never);
      }
    }
  }, [user, isLoading, error, router]);

  const handleSubmit = async () => {
    await login(email, password);
  };

  const switchTab = (tab: Tab) => {
    setActiveTab(tab);
    setPassword('');
    setShowPassword(false);
  };

  const isJoin = activeTab === 'join';

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
            <Check size={36} color="#FFFFFF" strokeWidth={3} />
          </View>
        </View>

        <Text style={styles.title}>{t('auth.welcomeBack')}</Text>
        <Text style={styles.subtitle}>{t('auth.loginSubtext')}</Text>

        <View style={styles.card}>
          {/* Tab switcher */}
          <View style={styles.tabs}>
            <TouchableOpacity
              style={[styles.tab, !isJoin && styles.tabActive]}
              onPress={() => switchTab('login')}
              activeOpacity={0.7}
              accessibilityRole="tab"
            >
              <Text style={[styles.tabText, !isJoin && styles.tabTextActive]}>
                {t('auth.tabLogin')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, isJoin && styles.tabActive]}
              onPress={() => switchTab('join')}
              activeOpacity={0.7}
              accessibilityRole="tab"
            >
              <Text style={[styles.tabText, isJoin && styles.tabTextActive]}>
                {t('auth.tabJoin')}
              </Text>
            </TouchableOpacity>
          </View>

          {isJoin && (
            <Text style={styles.joinHint}>{t('auth.joinHint')}</Text>
          )}

          <View style={styles.fieldWrapper}>
            <Mail size={18} color="#CFADA3" />
            <TextInput
              style={styles.input}
              placeholder={t('auth.email')}
              placeholderTextColor="#CFADA3"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              value={email}
              onChangeText={setEmail}
            />
          </View>

          <View style={styles.fieldWrapper}>
            <Lock size={18} color="#CFADA3" />
            <TextInput
              style={[styles.input, styles.inputFlex]}
              placeholder={isJoin ? t('auth.managerPassword') : t('auth.password')}
              placeholderTextColor="#CFADA3"
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={setPassword}
            />
            <TouchableOpacity
              onPress={() => setShowPassword(prev => !prev)}
              style={styles.eyeButton}
              accessibilityRole="button"
            >
              {showPassword
                ? <EyeOff size={18} color="#CFADA3" />
                : <Eye size={18} color="#CFADA3" />}
            </TouchableOpacity>
          </View>

          {!isJoin && (
            <TouchableOpacity style={styles.forgotWrapper} accessibilityRole="button">
              <Text style={styles.forgotText}>{t('auth.forgotPassword')}</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={() => { void handleSubmit(); }}
            disabled={isLoading}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            {isLoading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>
                  {isJoin ? t('auth.joinButton') : t('auth.signIn')}
                </Text>}
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
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  circle1: {
    position: 'absolute', width: 350, height: 350, borderRadius: 175,
    backgroundColor: 'rgba(6,95,70,0.04)', top: -80, right: -100,
  },
  circle2: {
    position: 'absolute', width: 280, height: 280, borderRadius: 140,
    backgroundColor: 'rgba(6,95,70,0.03)', bottom: 100, left: -80,
  },
  circle3: {
    position: 'absolute', width: 200, height: 200, borderRadius: 100,
    backgroundColor: 'rgba(6,95,70,0.03)', top: '40%', right: -60,
  },
  scrollContent: {
    flexGrow: 1, justifyContent: 'center', alignItems: 'center',
    padding: 24, paddingTop: 60, paddingBottom: 40,
  },
  logoContainer: { marginBottom: 24 },
  logoSquare: {
    width: 80, height: 80, borderRadius: 20, backgroundColor: '#C45A10',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#C45A10', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 12, elevation: 6,
  },
  title: {
    fontSize: 28, fontWeight: '700', color: '#383432',
    textAlign: 'center', marginBottom: 8,
  },
  subtitle: {
    fontSize: 14, color: '#B07868', textAlign: 'center',
    marginBottom: 32, lineHeight: 20, paddingHorizontal: 12,
  },
  card: {
    width: '100%', maxWidth: 400, backgroundColor: '#ffffff', borderRadius: 16, padding: 24,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  tabs: {
    flexDirection: 'row', backgroundColor: '#FAF6F3', borderRadius: 10,
    padding: 4, marginBottom: 20, gap: 4,
  },
  tab: {
    flex: 1, paddingVertical: 9, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  tabActive: {
    backgroundColor: '#ffffff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08, shadowRadius: 4, elevation: 2,
  },
  tabText: { fontSize: 14, fontWeight: '500', color: '#B07868' },
  tabTextActive: { color: '#383432', fontWeight: '600' },
  joinHint: {
    fontSize: 13, color: '#B07868', lineHeight: 18,
    marginBottom: 16, marginTop: -4,
  },
  fieldWrapper: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1,
    borderColor: '#E8DDD6', borderRadius: 12, backgroundColor: '#FAF6F3',
    paddingHorizontal: 14, marginBottom: 14, height: 52, gap: 10,
  },
  input: { flex: 1, fontSize: 15, color: '#383432' },
  inputFlex: { flex: 1 },
  eyeButton: { padding: 4 },
  forgotWrapper: {
    alignSelf: 'flex-end', marginBottom: 20, marginTop: -4, paddingVertical: 4,
  },
  forgotText: { color: '#C45A10', fontSize: 13, fontWeight: '500' },
  button: {
    height: 52, backgroundColor: '#C45A10', borderRadius: 12,
    justifyContent: 'center', alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  errorText: { color: '#ef4444', fontSize: 14, textAlign: 'center', marginTop: 12 },
});
