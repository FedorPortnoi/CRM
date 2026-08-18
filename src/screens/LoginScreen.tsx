import React, { useMemo, useState, useEffect } from 'react';
import {
  Alert,
  Image,
  ImageBackground,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../store/userStore';

type FocusedField = 'email' | 'password' | null;

const COLORS = {
  cream: '#E8DDD6',
  dustyRose: '#C9A99A',
  mutedTerracotta: '#B07868',
  darkBrown: '#8B3A00',
  burntOrange: '#C45A10',
  charcoal: '#333333',
  white: '#FFFFFF',
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user, isLoading, error, pendingVerification, pendingTotp, login } = useUserStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [focusedField, setFocusedField] = useState<FocusedField>(null);

  const normalizedEmail = useMemo(() => email.trim().toLowerCase(), [email]);

  useEffect(() => {
    if (!isLoading && error === null && user !== null) {
      if (user.must_change_password || user.must_change_email) {
        router.replace('/set-password' as never);
      } else {
        router.replace(
          (user.onboarding_completed === false ? '/onboarding' : '/(tabs)') as never
        );
      }
    }
  }, [user, isLoading, error, router]);

  // login() lands here — instead of an error banner — when the password was
  // right but the address on file still needs its code. Same pendingVerification
  // handle acceptInvite() produces, so /verify needs no changes to serve either
  // origin. join() (still in userStore.ts, no UI reaches it from this screen
  // any more — see the tab switcher below) produces the same shape and would
  // land here too if anything ever called it again.
  useEffect(() => {
    if (!isLoading && pendingVerification !== null) {
      router.replace('/verify' as never);
    }
  }, [pendingVerification, isLoading, router]);

  // Same shape, different challenge: login() lands here — instead of an error
  // banner — when the password was right and the account has 2FA turned on.
  // verifyTotp mints the real session one screen later.
  useEffect(() => {
    if (!isLoading && pendingTotp !== null) {
      router.replace('/verify-totp' as never);
    }
  }, [pendingTotp, isLoading, router]);

  const handleLogin = async () => {
    if (!normalizedEmail || !password) {
      Alert.alert('Заполните поля', 'Введите email и пароль, чтобы продолжить.');
      return;
    }
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      Alert.alert('Проверьте email', 'Введите корректный адрес электронной почты.');
      return;
    }
    await login(normalizedEmail, password);
  };

  return (
    <ImageBackground
      source={require('../../assets/login-bg.png')}
      resizeMode="cover"
      style={styles.screen}
    >
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboardArea}
        >
          <ScrollView
            bounces={false}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.card}>
              {/* Frosted-glass backdrop */}
              <BlurView
                intensity={55}
                tint="light"
                experimentalBlurMethod="dimezisBlurView"
                style={styles.cardGlass}
              />
              <View pointerEvents="none" style={styles.cardTint} />

              {/* Logo — 4КУБ cube brand badge */}
              <View style={styles.logo}>
                <Image
                  source={require('../../assets/icon.png')}
                  style={styles.logoImage}
                  resizeMode="cover"
                  accessibilityRole="image"
                  accessibilityLabel="4КУБ"
                />
              </View>

              <Text style={styles.title}>4КУБ</Text>
              <Text style={styles.subtitle}>{t('auth.loginSubtext')}</Text>

              {/* Tab switcher. The second tab is not a tab in the usual sense —
                  it never becomes the active pane, it navigates straight to
                  /invite. It used to toggle in place to a company-code +
                  manager-password form (`/auth/join`, still in userStore.ts,
                  now unreachable from here on purpose): a real new hire read
                  "Я новый сотрудник" and typed in the invite claim code they
                  were holding, not a manager's shared password they never
                  had — the two forms just happened to sit one tap apart. */}
              <View style={styles.tabs}>
                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: true }}
                  style={[styles.tab, styles.loginTab, styles.tabActive]}
                >
                  <Text style={[styles.tabText, styles.tabTextActive]}>
                    {t('auth.tabLogin')}
                  </Text>
                </Pressable>

                <Pressable
                  accessibilityLabel="Перейти к вводу кода приглашения"
                  accessibilityRole="button"
                  onPress={() => router.push('/invite' as never)}
                  style={({ pressed }) => [
                    styles.tab,
                    styles.registerTab,
                    styles.tabInactive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.tabText, styles.tabTextInactive]}>
                    {t('auth.tabJoin')}
                  </Text>
                </Pressable>
              </View>

              {/* Email input */}
              <View
                style={[
                  styles.inputWrapper,
                  focusedField === 'email' && styles.inputWrapperFocused,
                ]}
              >
                <Ionicons
                  name="mail-outline"
                  size={25}
                  color={COLORS.mutedTerracotta}
                  style={styles.inputIcon}
                />
                <TextInput
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  inputMode="email"
                  keyboardType="email-address"
                  onBlur={() => setFocusedField(null)}
                  onChangeText={setEmail}
                  onFocus={() => setFocusedField('email')}
                  onSubmitEditing={() => setFocusedField('password')}
                  placeholder={t('auth.email')}
                  placeholderTextColor={COLORS.dustyRose}
                  returnKeyType="next"
                  selectionColor={COLORS.burntOrange}
                  style={styles.input}
                  value={email}
                />
              </View>

              {/* Password input */}
              <View
                style={[
                  styles.inputWrapper,
                  focusedField === 'password' && styles.inputWrapperFocused,
                ]}
              >
                <Ionicons
                  name="lock-closed-outline"
                  size={25}
                  color={COLORS.mutedTerracotta}
                  style={styles.inputIcon}
                />
                <TextInput
                  autoCapitalize="none"
                  autoComplete="current-password"
                  autoCorrect={false}
                  onBlur={() => setFocusedField(null)}
                  onChangeText={setPassword}
                  onFocus={() => setFocusedField('password')}
                  onSubmitEditing={() => { void handleLogin(); }}
                  placeholder={t('auth.password')}
                  placeholderTextColor={COLORS.dustyRose}
                  returnKeyType="done"
                  secureTextEntry={!showPassword}
                  selectionColor={COLORS.burntOrange}
                  style={styles.input}
                  value={password}
                />
                <Pressable
                  accessibilityLabel={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                  accessibilityRole="button"
                  hitSlop={12}
                  onPress={() => setShowPassword(v => !v)}
                  style={({ pressed }) => [styles.eyeButton, pressed && styles.pressed]}
                >
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={26}
                    color={COLORS.mutedTerracotta}
                  />
                </Pressable>
              </View>


              {/* Error */}
              {error !== null && (
                <Text style={styles.errorText}>{error}</Text>
              )}

              {/* Login button */}
              <Pressable
                accessibilityRole="button"
                disabled={isLoading}
                onPress={() => { void handleLogin(); }}
                style={({ pressed }) => [
                  styles.loginButtonShadow,
                  pressed && !isLoading && styles.pressed,
                  isLoading && styles.disabled,
                ]}
              >
                <LinearGradient
                  colors={[COLORS.burntOrange, COLORS.darkBrown]}
                  start={{ x: 0, y: 0.5 }}
                  end={{ x: 1, y: 0.5 }}
                  style={styles.loginButton}
                >
                  {isLoading
                    ? <ActivityIndicator color={COLORS.white} />
                    : <Text style={styles.loginButtonText}>{t('auth.signIn')}</Text>
                  }
                </LinearGradient>
              </Pressable>

              {/* Reset-by-email is keyed on User.email, and reaching this screen
                  at all already means the account has one — nothing left that
                  would make this a dead end.

                  Until this existed there was no password recovery anywhere in
                  the product: both /auth/me routes need a session the locked-out
                  user does not have, and the remedy was a hand-written UPDATE
                  against the production database. */}
              <Pressable
                accessibilityLabel="Восстановить пароль"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => router.push('/forgot-password' as never)}
                style={({ pressed }) => [styles.inviteLinkButton, pressed && styles.pressed]}
              >
                <Text style={styles.inviteLinkText}>{t('auth.forgotPassword')}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.darkBrown,
  },
  safeArea: { flex: 1 },
  keyboardArea: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 76,
  },

  // Card
  card: {
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
    paddingTop: 66,
    paddingHorizontal: 28,
    paddingBottom: 20,
    borderRadius: 24,
    borderWidth: 1.25,
    borderColor: 'rgba(255, 255, 255, 0.68)',
    backgroundColor: 'transparent',
    shadowColor: COLORS.charcoal,
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.36,
    shadowRadius: 25,
    elevation: 16,
  },
  cardGlass: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 24,
    overflow: 'hidden',
  },
  cardTint: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 24,
    backgroundColor: 'rgba(247, 241, 236, 0.35)',
  },
  logo: {
    position: 'absolute',
    top: -60,
    alignSelf: 'center',
    width: 118,
    height: 118,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 30,
    borderWidth: 1.6,
    borderColor: COLORS.cream,
    backgroundColor: '#0E0E0E',
    shadowColor: COLORS.darkBrown,
    shadowOffset: { width: 0, height: 11 },
    shadowOpacity: 0.42,
    shadowRadius: 14,
    elevation: 14,
  },
  logoImage: {
    width: 114,
    height: 114,
    borderRadius: 28,
  },
  title: {
    color: COLORS.charcoal,
    fontSize: 24,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.45,
  },
  subtitle: {
    marginTop: 13,
    color: COLORS.darkBrown,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
    textAlign: 'center',
  },

  // Tabs
  tabs: {
    flexDirection: 'row',
    marginTop: 30,
    padding: 4,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(201, 169, 154, 0.78)',
    backgroundColor: 'rgba(232, 221, 214, 0.82)',
  },
  tab: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    paddingHorizontal: 10,
  },
  loginTab: { flex: 0.9 },
  registerTab: { flex: 1.35 },
  tabActive: {
    backgroundColor: COLORS.burntOrange,
    shadowColor: COLORS.darkBrown,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.24,
    shadowRadius: 8,
    elevation: 6,
  },
  tabInactive: {
    backgroundColor: 'transparent',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  tabTextActive: {
    color: COLORS.white,
  },
  tabTextInactive: {
    color: COLORS.mutedTerracotta,
  },

  // Inputs
  inputWrapper: {
    minHeight: 58,
    marginTop: 20,
    paddingHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: COLORS.dustyRose,
    backgroundColor: 'rgba(232, 221, 214, 0.78)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputWrapperFocused: {
    borderColor: COLORS.burntOrange,
  },
  inputIcon: {
    marginRight: 15,
  },
  input: {
    flex: 1,
    paddingVertical: 14,
    color: COLORS.charcoal,
    fontSize: 16,
    fontWeight: '500',
  },
  eyeButton: {
    marginLeft: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Error
  errorText: {
    color: '#ef4444',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 14,
  },

  // Login button
  loginButtonShadow: {
    marginTop: 27,
    borderRadius: 13,
    shadowColor: COLORS.darkBrown,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.34,
    shadowRadius: 12,
    elevation: 8,
  },
  loginButton: {
    minHeight: 60,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  loginButtonText: {
    color: COLORS.white,
    fontSize: 19,
    fontWeight: '900',
    letterSpacing: 0.1,
  },

  // Invite door — same treatment as the link buttons on InviteScreen, so the two
  // screens that point at each other look like they belong together.
  inviteLinkButton: {
    marginTop: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  inviteLinkText: {
    color: COLORS.darkBrown,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.66 },
});
