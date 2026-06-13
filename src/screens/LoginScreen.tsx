import React, { useMemo, useState, useEffect } from 'react';
import {
  Alert,
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
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../store/userStore';

type ActiveTab = 'login' | 'join';
type FocusedField = 'email' | 'password' | 'companyCode' | 'username' | null;

const COLORS = {
  cream: '#E8DDD6',
  dustyRose: '#C9A99A',
  terracotta: '#C4694A',
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
  const { user, isLoading, error, login, join } = useUserStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [companyCode, setCompanyCode] = useState('');
  const [username, setUsername] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('login');
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

  const isJoin = activeTab === 'join';

  const handleTabPress = (tab: ActiveTab) => {
    setActiveTab(tab);
    setPassword('');
    setShowPassword(false);
  };

  const handleLogin = async () => {
    if (isJoin) {
      if (!companyCode.trim() || !username.trim() || !password) {
        Alert.alert(t('auth.fillFields'), t('auth.joinFillHint'));
        return;
      }
      await join(companyCode.trim(), username.trim(), password);
      return;
    }
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
    <LinearGradient
      colors={[COLORS.charcoal, COLORS.darkBrown]}
      locations={[0, 1]}
      style={styles.screen}
    >
      {/* Background decorations */}
      <View pointerEvents="none" style={styles.backgroundDecoration}>
        <View style={styles.topRightGlow} />
        <View style={styles.topLeftSmearLarge} />
        <View style={styles.topLeftSmearSmall} />
        <View style={styles.bottomRightSmearLarge} />
        <View style={styles.bottomRightSmearSmall} />
        <View style={styles.chalkSplashTop} />
        <View style={styles.chalkSplashTopAccent} />
        <View style={styles.chalkSplashBottom} />
        <View style={styles.chalkSplashBottomAccent} />
      </View>

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
              {/* Logo */}
              <LinearGradient
                colors={[COLORS.burntOrange, COLORS.terracotta]}
                start={{ x: 0.05, y: 0.05 }}
                end={{ x: 1, y: 1 }}
                style={styles.logo}
              >
                <Ionicons name="checkmark-sharp" color={COLORS.white} size={60} />
              </LinearGradient>

              <Text style={styles.title}>{t('auth.welcomeBack')}</Text>
              <Text style={styles.subtitle}>{t('auth.loginSubtext')}</Text>

              {/* Tab switcher */}
              <View style={styles.tabContainer}>
                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: activeTab === 'login' }}
                  onPress={() => handleTabPress('login')}
                  style={({ pressed }) => [
                    styles.tab,
                    styles.loginTab,
                    activeTab === 'login' ? styles.activeTab : styles.inactiveTab,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.tabText,
                      activeTab === 'login' ? styles.activeTabText : styles.inactiveTabText,
                    ]}
                  >
                    {t('auth.tabLogin')}
                  </Text>
                </Pressable>

                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: activeTab === 'join' }}
                  onPress={() => handleTabPress('join')}
                  style={({ pressed }) => [
                    styles.tab,
                    styles.registerTab,
                    activeTab === 'join' ? styles.activeTab : styles.inactiveTab,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.tabText,
                      activeTab === 'join' ? styles.activeTabText : styles.inactiveTabText,
                    ]}
                  >
                    {t('auth.tabJoin')}
                  </Text>
                </Pressable>
              </View>

              {isJoin && (
                <Text style={styles.joinHint}>{t('auth.joinHint')}</Text>
              )}

              {isJoin ? (
                <>
                  {/* Company code input */}
                  <View
                    style={[
                      styles.inputContainer,
                      focusedField === 'companyCode' && styles.inputContainerFocused,
                    ]}
                  >
                    <Ionicons
                      name="business-outline"
                      size={23}
                      color={COLORS.mutedTerracotta}
                      style={styles.inputIcon}
                    />
                    <TextInput
                      autoCapitalize="characters"
                      autoCorrect={false}
                      onBlur={() => setFocusedField(null)}
                      onChangeText={setCompanyCode}
                      onFocus={() => setFocusedField('companyCode')}
                      onSubmitEditing={() => setFocusedField('username')}
                      placeholder={t('auth.companyCode')}
                      placeholderTextColor={COLORS.dustyRose}
                      returnKeyType="next"
                      selectionColor={COLORS.burntOrange}
                      style={styles.input}
                      value={companyCode}
                    />
                  </View>

                  {/* Username input */}
                  <View
                    style={[
                      styles.inputContainer,
                      focusedField === 'username' && styles.inputContainerFocused,
                    ]}
                  >
                    <Ionicons
                      name="person-outline"
                      size={23}
                      color={COLORS.mutedTerracotta}
                      style={styles.inputIcon}
                    />
                    <TextInput
                      autoCapitalize="words"
                      autoCorrect={false}
                      onBlur={() => setFocusedField(null)}
                      onChangeText={setUsername}
                      onFocus={() => setFocusedField('username')}
                      onSubmitEditing={() => setFocusedField('password')}
                      placeholder={t('auth.username')}
                      placeholderTextColor={COLORS.dustyRose}
                      returnKeyType="next"
                      selectionColor={COLORS.burntOrange}
                      style={styles.input}
                      value={username}
                    />
                  </View>
                </>
              ) : (
                /* Email input */
                <View
                  style={[
                    styles.inputContainer,
                    focusedField === 'email' && styles.inputContainerFocused,
                  ]}
                >
                  <Ionicons
                    name="mail-outline"
                    size={23}
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
              )}

              {/* Password input */}
              <View
                style={[
                  styles.inputContainer,
                  focusedField === 'password' && styles.inputContainerFocused,
                ]}
              >
                <Ionicons
                  name="lock-closed-outline"
                  size={23}
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
                  placeholder={isJoin ? t('auth.managerPassword') : t('auth.password')}
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
                    size={24}
                    color={COLORS.mutedTerracotta}
                  />
                </Pressable>
              </View>

              {/* Forgot password */}
              {!isJoin && (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  style={({ pressed }) => [styles.forgotPasswordButton, pressed && styles.pressed]}
                >
                  <Text style={styles.forgotPasswordText}>{t('auth.forgotPassword')}</Text>
                </Pressable>
              )}

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
                  styles.loginButtonWrapper,
                  pressed && !isLoading && styles.pressed,
                  isLoading && styles.disabledButton,
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
                    : <Text style={styles.loginButtonText}>
                        {isJoin ? t('auth.joinButton') : t('auth.signIn')}
                      </Text>
                  }
                </LinearGradient>
              </Pressable>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  safeArea: { flex: 1 },
  keyboardArea: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 52,
  },

  // Background decorations
  backgroundDecoration: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  topRightGlow: {
    position: 'absolute',
    top: -70, right: -75,
    width: 240, height: 240,
    borderRadius: 120,
    backgroundColor: 'rgba(196, 105, 74, 0.15)',
  },
  topLeftSmearLarge: {
    position: 'absolute',
    top: 85, left: -96,
    width: 255, height: 190,
    borderTopLeftRadius: 90, borderTopRightRadius: 28,
    borderBottomLeftRadius: 60, borderBottomRightRadius: 108,
    backgroundColor: 'rgba(196, 105, 74, 0.24)',
    transform: [{ rotate: '-14deg' }],
  },
  topLeftSmearSmall: {
    position: 'absolute',
    top: 205, left: -60,
    width: 215, height: 164,
    borderTopLeftRadius: 48, borderTopRightRadius: 104,
    borderBottomLeftRadius: 90, borderBottomRightRadius: 22,
    backgroundColor: 'rgba(201, 169, 154, 0.20)',
    transform: [{ rotate: '7deg' }],
  },
  bottomRightSmearLarge: {
    position: 'absolute',
    right: -102, bottom: -10,
    width: 290, height: 225,
    borderTopLeftRadius: 105, borderTopRightRadius: 32,
    borderBottomLeftRadius: 58, borderBottomRightRadius: 126,
    backgroundColor: 'rgba(196, 105, 74, 0.23)',
    transform: [{ rotate: '-10deg' }],
  },
  bottomRightSmearSmall: {
    position: 'absolute',
    right: 18, bottom: 82,
    width: 230, height: 155,
    borderTopLeftRadius: 114, borderTopRightRadius: 54,
    borderBottomLeftRadius: 32, borderBottomRightRadius: 88,
    backgroundColor: 'rgba(201, 169, 154, 0.22)',
    transform: [{ rotate: '-18deg' }],
  },
  chalkSplashTop: {
    position: 'absolute',
    top: 188, right: 22,
    width: 76, height: 44,
    borderTopLeftRadius: 44, borderTopRightRadius: 12,
    borderBottomLeftRadius: 18, borderBottomRightRadius: 38,
    backgroundColor: 'rgba(232, 221, 214, 0.19)',
    transform: [{ rotate: '-19deg' }],
  },
  chalkSplashTopAccent: {
    position: 'absolute',
    top: 172, right: 62,
    width: 31, height: 25,
    borderTopLeftRadius: 18, borderTopRightRadius: 7,
    borderBottomLeftRadius: 5, borderBottomRightRadius: 16,
    backgroundColor: 'rgba(232, 221, 214, 0.16)',
    transform: [{ rotate: '23deg' }],
  },
  chalkSplashBottom: {
    position: 'absolute',
    bottom: 115, left: 28,
    width: 82, height: 51,
    borderTopLeftRadius: 17, borderTopRightRadius: 48,
    borderBottomLeftRadius: 42, borderBottomRightRadius: 12,
    backgroundColor: 'rgba(232, 221, 214, 0.18)',
    transform: [{ rotate: '16deg' }],
  },
  chalkSplashBottomAccent: {
    position: 'absolute',
    bottom: 104, left: 83,
    width: 36, height: 23,
    borderTopLeftRadius: 6, borderTopRightRadius: 17,
    borderBottomLeftRadius: 13, borderBottomRightRadius: 5,
    backgroundColor: 'rgba(232, 221, 214, 0.15)',
    transform: [{ rotate: '-22deg' }],
  },

  // Card
  card: {
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
    paddingTop: 76,
    paddingHorizontal: 22,
    paddingBottom: 24,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(232, 221, 214, 0.72)',
    backgroundColor: 'rgba(232, 221, 214, 0.94)',
    shadowColor: COLORS.charcoal,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.32,
    shadowRadius: 22,
    elevation: 14,
  },
  logo: {
    position: 'absolute',
    top: -54,
    alignSelf: 'center',
    width: 108, height: 108,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: COLORS.cream,
    shadowColor: COLORS.darkBrown,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.38,
    shadowRadius: 12,
    elevation: 12,
  },
  title: {
    color: COLORS.charcoal,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 12,
    color: COLORS.mutedTerracotta,
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 21,
    textAlign: 'center',
  },
  joinHint: {
    fontSize: 13,
    color: COLORS.mutedTerracotta,
    lineHeight: 18,
    marginTop: 12,
    textAlign: 'center',
  },

  // Tabs
  tabContainer: {
    flexDirection: 'row',
    marginTop: 28,
    padding: 4,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: COLORS.dustyRose,
    backgroundColor: COLORS.cream,
  },
  tab: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    paddingHorizontal: 12,
  },
  loginTab: { flex: 0.9 },
  registerTab: { flex: 1.35 },
  activeTab: { backgroundColor: COLORS.burntOrange },
  inactiveTab: { backgroundColor: COLORS.cream },
  tabText: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
  activeTabText: { color: COLORS.white },
  inactiveTabText: { color: COLORS.dustyRose },

  // Inputs
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 58,
    marginTop: 20,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: COLORS.dustyRose,
    backgroundColor: COLORS.cream,
  },
  inputContainerFocused: { borderColor: COLORS.burntOrange },
  inputIcon: { marginRight: 12 },
  input: {
    flex: 1,
    paddingVertical: 15,
    color: COLORS.charcoal,
    fontSize: 16,
    fontWeight: '500',
  },
  eyeButton: { alignItems: 'center', justifyContent: 'center', marginLeft: 10 },

  // Forgot password
  forgotPasswordButton: { alignSelf: 'flex-end', marginTop: 14, paddingVertical: 4 },
  forgotPasswordText: { color: COLORS.burntOrange, fontSize: 14, fontWeight: '700' },

  // Error
  errorText: {
    color: '#ef4444',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 14,
  },

  // Login button
  loginButtonWrapper: {
    marginTop: 22,
    borderRadius: 14,
    shadowColor: COLORS.darkBrown,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
    elevation: 7,
  },
  loginButton: {
    minHeight: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    paddingHorizontal: 18,
  },
  loginButtonText: {
    color: COLORS.white,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  pressed: { opacity: 0.82 },
  disabledButton: { opacity: 0.68 },
});
