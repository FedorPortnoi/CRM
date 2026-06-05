import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView,
  ScrollView, ActivityIndicator, Platform, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Mail, Lock, Eye, EyeOff, Users } from 'lucide-react-native';
import { useUserStore } from '../store/userStore';

export default function JoinCompanyScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user, isLoading, error, login } = useUserStore();

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

  const handleJoin = async () => {
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
          <View style={styles.logoSquare}>
            <Users size={32} color="#FFFFFF" strokeWidth={2.5} />
          </View>
        </View>

        <Text style={styles.title}>{t('auth.joinTitle')}</Text>
        <Text style={styles.subtitle}>{t('auth.joinSubtitle')}</Text>

        <View style={styles.card}>
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
              placeholder={t('auth.tempPassword')}
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

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={() => { void handleJoin(); }}
            disabled={isLoading}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            {isLoading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>{t('auth.joinButton')}</Text>}
          </TouchableOpacity>

          {error !== null && (
            <Text style={styles.errorText}>{error}</Text>
          )}
        </View>

        <TouchableOpacity
          style={styles.backLink}
          onPress={() => router.back()}
          accessibilityRole="button"
        >
          <Text style={styles.backLinkText}>{t('auth.backToLogin')}</Text>
        </TouchableOpacity>
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
  title: { fontSize: 28, fontWeight: '700', color: '#383432', textAlign: 'center', marginBottom: 8 },
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
  backLink: { marginTop: 24, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  backLinkText: { color: '#B07868', fontSize: 14 },
});
