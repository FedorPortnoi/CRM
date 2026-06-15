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

              {/* Tab switcher */}
              <View style={styles.tabs}>
                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: activeTab === 'login' }}
                  onPress={() => handleTabPress('login')}
                  style={({ pressed }) => [
                    styles.tab,
                    styles.loginTab,
                    activeTab === 'login' ? styles.tabActive : styles.tabInactive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.tabText,
                      activeTab === 'login' ? styles.tabTextActive : styles.tabTextInactive,
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
                    activeTab === 'join' ? styles.tabActive : styles.tabInactive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.tabText,
                      activeTab === 'join' ? styles.tabTextActive : styles.tabTextInactive,
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
                      styles.inputWrapper,
                      focusedField === 'companyCode' && styles.inputWrapperFocused,
                    ]}
                  >
                    <Ionicons
                      name="business-outline"
                      size={25}
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
                      styles.inputWrapper,
                      focusedField === 'username' && styles.inputWrapperFocused,
                    ]}
                  >
                    <Ionicons
                      name="person-outline"
                      size={25}
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
              )}

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
                    size={26}
                    color={COLORS.mutedTerracotta}
                  />
                </Pressable>
              </View>

              {/* Forgot password */}
              {!isJoin && (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={10}
                  style={({ pressed }) => [styles.forgotButton, pressed && styles.pressed]}
                >
                  <Text style={styles.forgotText}>{t('auth.forgotPassword')}</Text>
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
  joinHint: {
    fontSize: 13,
    color: COLORS.mutedTerracotta,
    lineHeight: 18,
    marginTop: 12,
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

  // Forgot password
  forgotButton: {
    alignSelf: 'flex-end',
    marginTop: 15,
    paddingVertical: 4,
  },
  forgotText: {
    color: COLORS.burntOrange,
    fontSize: 15,
    fontWeight: '700',
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
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.66 },
});
