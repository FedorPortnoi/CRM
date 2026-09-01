import React, { useMemo, useState, useEffect } from 'react';
import {
  Image,
  ImageBackground,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../store/userStore';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors, spacing, radius, type, control } from '../theme';
import { Button, Card } from '../components/ui';

type FocusedField = 'email' | 'password' | null;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { user, isLoading, error, pendingVerification, pendingTotp, login } = useUserStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [focusedField, setFocusedField] = useState<FocusedField>(null);
  // Validation happens client-side before the store is ever touched, so it
  // gets its own inline slot instead of borrowing the store's `error` — a
  // native Alert() previously covered for this, which read as a jarring
  // interruption on a screen that otherwise never leaves the page.
  const [localError, setLocalError] = useState<string | null>(null);

  const normalizedEmail = useMemo(() => email.trim().toLowerCase(), [email]);
  const visibleError = localError ?? error;

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
      setLocalError('Введите email и пароль, чтобы продолжить.');
      return;
    }
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      setLocalError('Введите корректный адрес электронной почты.');
      return;
    }
    setLocalError(null);
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
            <Card padded={false} style={styles.card}>
              {/* Frosted-glass backdrop */}
              <BlurView
                intensity={55}
                tint={isDark ? 'dark' : 'light'}
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
                <View
                  accessibilityRole="tab"
                  accessibilityState={{ selected: true }}
                  style={[styles.tab, styles.loginTab, styles.tabActive]}
                >
                  <Text style={[styles.tabText, styles.tabTextActive]}>
                    {t('auth.tabLogin')}
                  </Text>
                </View>

                <TouchableOpacity
                  accessibilityLabel="Перейти к вводу кода приглашения"
                  accessibilityRole="button"
                  activeOpacity={0.7}
                  onPress={() => router.push('/invite' as never)}
                  style={[styles.tab, styles.registerTab, styles.tabInactive]}
                >
                  <Text style={[styles.tabText, styles.tabTextInactive]}>
                    {t('auth.tabJoin')}
                  </Text>
                </TouchableOpacity>
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
                  color={colors.textMuted}
                  style={styles.inputIcon}
                />
                <TextInput
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  inputMode="email"
                  keyboardType="email-address"
                  onBlur={() => setFocusedField(null)}
                  onChangeText={(v) => { setEmail(v); if (localError) setLocalError(null); }}
                  onFocus={() => setFocusedField('email')}
                  onSubmitEditing={() => setFocusedField('password')}
                  placeholder={t('auth.email')}
                  placeholderTextColor={colors.placeholder}
                  returnKeyType="next"
                  selectionColor={colors.accent}
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
                  color={colors.textMuted}
                  style={styles.inputIcon}
                />
                <TextInput
                  autoCapitalize="none"
                  autoComplete="current-password"
                  autoCorrect={false}
                  onBlur={() => setFocusedField(null)}
                  onChangeText={(v) => { setPassword(v); if (localError) setLocalError(null); }}
                  onFocus={() => setFocusedField('password')}
                  onSubmitEditing={() => { void handleLogin(); }}
                  placeholder={t('auth.password')}
                  placeholderTextColor={colors.placeholder}
                  returnKeyType="done"
                  secureTextEntry={!showPassword}
                  selectionColor={colors.accent}
                  style={styles.input}
                  value={password}
                />
                <TouchableOpacity
                  accessibilityLabel={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                  accessibilityRole="button"
                  activeOpacity={0.7}
                  hitSlop={12}
                  onPress={() => setShowPassword(v => !v)}
                  style={styles.eyeButton}
                >
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={26}
                    color={colors.textMuted}
                  />
                </TouchableOpacity>
              </View>

              {/* Error — inline and specific, never a system alert */}
              {visibleError !== null && (
                <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                  {visibleError}
                </Text>
              )}

              {/* Login button */}
              <Button
                title={t('auth.signIn')}
                onPress={() => { void handleLogin(); }}
                loading={isLoading}
                block
                style={styles.loginButton}
              />

              {/* Reset-by-email is keyed on User.email, and reaching this screen
                  at all already means the account has one — nothing left that
                  would make this a dead end.

                  Until this existed there was no password recovery anywhere in
                  the product: both /auth/me routes need a session the locked-out
                  user does not have, and the remedy was a hand-written UPDATE
                  against the production database. */}
              <TouchableOpacity
                accessibilityLabel="Восстановить пароль"
                accessibilityRole="button"
                activeOpacity={0.7}
                hitSlop={8}
                onPress={() => router.push('/forgot-password' as never)}
                style={styles.inviteLinkButton}
              >
                <Text style={styles.inviteLinkText}>{t('auth.forgotPassword')}</Text>
              </TouchableOpacity>
            </Card>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ImageBackground>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: c.bgDark,
  },
  safeArea: { flex: 1 },
  keyboardArea: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },

  // Card
  card: {
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
    paddingTop: spacing.xxl + spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    borderRadius: radius.xxl,
    borderWidth: 1.25,
    borderColor: c.borderStrong,
    backgroundColor: 'transparent',
    overflow: 'hidden',
    shadowColor: c.bgDark,
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.36,
    shadowRadius: 25,
    elevation: 16,
  },
  cardGlass: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.xxl,
    overflow: 'hidden',
  },
  cardTint: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.xxl,
    backgroundColor: `${c.surface}59`,
  },
  logo: {
    position: 'absolute',
    top: -60,
    alignSelf: 'center',
    width: 118,
    height: 118,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xxl,
    borderWidth: 1.6,
    borderColor: c.wheat,
    backgroundColor: c.bgDark,
    shadowColor: c.bgDark,
    shadowOffset: { width: 0, height: 11 },
    shadowOpacity: 0.42,
    shadowRadius: 14,
    elevation: 14,
  },
  logoImage: {
    width: 114,
    height: 114,
    borderRadius: radius.xxl,
  },
  title: {
    ...type.display,
    color: c.text1,
    textAlign: 'center',
    letterSpacing: -0.45,
  },
  subtitle: {
    marginTop: spacing.md,
    ...type.body,
    color: c.text1,
    textAlign: 'center',
  },

  // Tabs
  tabs: {
    flexDirection: 'row',
    marginTop: spacing.xxl,
    padding: spacing.xs,
    borderRadius: radius.xxl,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: `${c.inputBg}D1`,
  },
  tab: {
    minHeight: control.sm + spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xxl,
    paddingHorizontal: spacing.md,
  },
  loginTab: { flex: 0.9 },
  registerTab: { flex: 1.35 },
  tabActive: {
    backgroundColor: c.accent,
  },
  tabInactive: {
    backgroundColor: 'transparent',
  },
  tabText: {
    ...type.label,
    textAlign: 'center',
  },
  tabTextActive: {
    color: c.onAccent,
  },
  tabTextInactive: {
    color: c.textMuted,
  },

  // Inputs
  inputWrapper: {
    minHeight: control.md,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: c.inputBorder,
    backgroundColor: `${c.inputBg}C7`,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputWrapperFocused: {
    borderColor: c.accent,
  },
  inputIcon: {
    marginRight: spacing.lg,
  },
  input: {
    flex: 1,
    paddingVertical: spacing.sm,
    color: c.text1,
    ...type.heading,
  },
  eyeButton: {
    marginLeft: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Error
  errorText: {
    ...type.label,
    color: c.danger,
    textAlign: 'center',
    marginTop: spacing.md,
  },

  // Login button
  loginButton: {
    marginTop: spacing.xl,
  },

  // Invite door — same treatment as the link buttons on InviteScreen, so the two
  // screens that point at each other look like they belong together.
  inviteLinkButton: {
    marginTop: spacing.sm,
    minHeight: control.sm + spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  inviteLinkText: {
    ...type.body,
    color: c.accent,
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
});
