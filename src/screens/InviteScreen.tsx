import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Stack, useRouter } from 'expo-router';
import { getInitialURL, useURL } from 'expo-linking';
import { useUserStore } from '../store/userStore';
import {
  discoverInvite,
  lookupInvite,
  tokenFromUrl,
  type InvitePreview,
} from '../utils/inviteDiscovery';

/**
 * The invitee's half of the invite flow — the first screen a person who has no
 * account sees, and the only one where an account can be created.
 *
 * Three states, in the order they are reached:
 *
 *   RESOLVING  ask `discoverInvite` which invite this install belongs to.
 *   FOUND      show who invited whom, and collect phone/email/password.
 *   CODE       the fallback when nothing was found: six characters retyped by
 *              hand off the invite web page.
 *
 * "No invite found" is NOT an error — it is the ordinary state of an app opened
 * by someone who was never invited — so it lands on CODE with no red text, and
 * CODE always offers the way back to the normal login screen.
 */

type Phase = 'resolving' | 'found' | 'code';
type FocusedField = 'phone' | 'email' | 'password' | 'confirm' | 'code' | null;

const COLORS = {
  cream: '#E8DDD6',
  dustyRose: '#C9A99A',
  mutedTerracotta: '#B07868',
  darkBrown: '#8B3A00',
  burntOrange: '#C45A10',
  charcoal: '#333333',
  white: '#FFFFFF',
  green: '#3F8F5B',
  red: '#ef4444',
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The claim code alphabet, kept deliberately free of the characters people
 * confuse when copying from one phone to another: no O/0, no I/1.
 * Mirrors CLAIM_ALPHABET in backend/services/invites.ts.
 */
const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CLAIM_CODE_LENGTH = 6;
const CLAIM_REJECT_PATTERN = new RegExp(`[^${CLAIM_ALPHABET}]`, 'g');

/** Human labels for the role the owner bound to the invite when minting it. */
const ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  head: 'Руководитель отдела',
  member: 'Менеджер',
  accountant: 'Бухгалтер',
  marketer: 'Маркетолог',
  support: 'Поддержка',
  viewer: 'Только просмотр',
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/**
 * The server's password policy, restated character-class for character-class.
 *
 * It is restated rather than approximated because a 400 here is a dead end: the
 * person has no account, so there is nothing to log back into and try again
 * with. The regexes are ASCII on purpose — the backend's are
 * (see PasswordSchema in backend/api/routes/auth.ts) — so a password built out
 * of Cyrillic letters would pass a looser client check and then be refused.
 */
const PASSWORD_RULES: { label: string; message: string; test: (value: string) => boolean }[] = [
  {
    label: 'не короче 8 символов',
    message: 'Пароль должен быть не короче 8 символов',
    test: (v) => v.length >= 8,
  },
  {
    label: 'строчная латинская буква (a–z)',
    message: 'В пароле нужна строчная латинская буква — от a до z',
    test: (v) => /[a-z]/.test(v),
  },
  {
    label: 'заглавная латинская буква (A–Z)',
    message: 'В пароле нужна заглавная латинская буква — от A до Z',
    test: (v) => /[A-Z]/.test(v),
  },
  {
    label: 'цифра (0–9)',
    message: 'В пароле нужна хотя бы одна цифра',
    test: (v) => /[0-9]/.test(v),
  },
  {
    label: 'знак: ! ? # $ % и подобные',
    message: 'В пароле нужен знак — например ! ? # $ % или дефис',
    test: (v) => /[^A-Za-z0-9]/.test(v),
  },
];

export default function InviteScreen() {
  const router = useRouter();
  const url = useURL();
  const { isLoading, error, acceptInvite } = useUserStore();

  const [phase, setPhase] = useState<Phase>('resolving');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [focusedField, setFocusedField] = useState<FocusedField>(null);

  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [code, setCode] = useState('');
  const [isLookingUp, setIsLookingUp] = useState(false);

  const [formError, setFormError] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  // `discoverInvite` may consume the RuStore install referrer, which the SDK
  // hands over exactly once. Running it twice would throw the second copy away,
  // so it is fired from a ref-guarded effect rather than one keyed on the URL.
  const discoveryStartedRef = useRef(false);
  // Kept alongside the state so the late-URL effect below can read it without
  // re-subscribing every time the form changes.
  const previewRef = useRef<InvitePreview | null>(null);
  const handledUrlRef = useRef<string | null>(null);

  const applyPreview = useCallback((found: InvitePreview) => {
    previewRef.current = found;
    setPreview(found);
    setLookupError(null);
    setPhase('found');
  }, []);

  useEffect(() => {
    if (discoveryStartedRef.current) return;
    discoveryStartedRef.current = true;

    let cancelled = false;
    void (async () => {
      // `useURL()` is null on the first render even for a cold start from a
      // link, so the initial URL is fetched directly rather than waited for.
      const deepLink = url ?? (await getInitialURL());
      handledUrlRef.current = deepLink;
      const result = await discoverInvite(deepLink);
      if (cancelled) return;

      if (result === null) {
        // Nothing anywhere. Not a failure — just somebody with no invite.
        setPhase('code');
        return;
      }
      if (result.ok) {
        applyPreview(result.preview);
        return;
      }
      // A credential existed and the server refused it: expired, revoked, or
      // already used. Say so, and let them retype a fresh code.
      setLookupError(result.message);
      setPhase('code');
    })();

    return () => {
      cancelled = true;
    };
    // Deliberately mount-only: see discoveryStartedRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A link that arrives while the app is already running and sitting on this
  // screen. Only the link path is retried — never `discoverInvite`, which would
  // burn the install referrer a second time.
  //
  // Held back until discovery has finished: two lookups of the same token race
  // at the server, which answers the loser with a 409 rather than a second
  // accept token, and a stale 409 must not paint an error under a form that the
  // winner has already filled in.
  useEffect(() => {
    if (phase === 'resolving') return;
    if (url === null || url === handledUrlRef.current) return;
    handledUrlRef.current = url;
    if (previewRef.current !== null) return;

    const token = tokenFromUrl(url);
    if (token === null) return;

    let cancelled = false;
    void (async () => {
      setIsLookingUp(true);
      const result = await lookupInvite({ via: 'link', token });
      if (cancelled || previewRef.current !== null) return;
      setIsLookingUp(false);
      if (result.ok) {
        applyPreview(result.preview);
      } else {
        setLookupError(result.message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, phase, applyPreview]);

  const normalizedEmail = useMemo(() => email.trim().toLowerCase(), [email]);
  const trimmedPhone = useMemo(() => phone.trim(), [phone]);
  const phoneDigits = useMemo(() => trimmedPhone.replace(/\D/g, ''), [trimmedPhone]);

  /** First unmet requirement, in reading order, or null when the form is good. */
  const validate = useCallback((): string | null => {
    if (trimmedPhone.length === 0) return 'Введите номер телефона';
    if (phoneDigits.length < 10 || trimmedPhone.length < 10) {
      return 'Номер телефона должен содержать не менее 10 цифр';
    }
    if (trimmedPhone.length > 20) return 'Номер телефона слишком длинный — не более 20 символов';

    if (normalizedEmail.length === 0) return 'Введите адрес электронной почты';
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      return 'Проверьте адрес электронной почты: он должен быть вида имя@компания.ру';
    }

    if (password.length === 0) return 'Придумайте пароль';
    const failed = PASSWORD_RULES.find((rule) => !rule.test(password));
    if (failed !== undefined) return failed.message;
    if (password.length > 100) return 'Пароль слишком длинный — не более 100 символов';

    if (confirmPassword.length === 0) return 'Повторите пароль ещё раз';
    if (password !== confirmPassword) return 'Пароли не совпадают';

    return null;
  }, [trimmedPhone, phoneDigits, normalizedEmail, password, confirmPassword]);

  const handleAccept = useCallback(async () => {
    if (preview === null || isLoading) return;

    const problem = validate();
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setSubmitAttempted(true);

    await acceptInvite({
      acceptToken: preview.accept_token,
      phone: trimmedPhone,
      email: normalizedEmail,
      password,
    });

    // `acceptInvite` reports failure by setting `error` on the store rather than
    // throwing, so success is read back off the store instead of inferred.
    const state = useUserStore.getState();
    if (state.error === null && state.user !== null && state.token !== null) {
      router.replace('/(tabs)' as never);
    }
  }, [preview, isLoading, validate, acceptInvite, trimmedPhone, normalizedEmail, password, router]);

  const handleCodeChange = useCallback((raw: string) => {
    setCode(raw.toUpperCase().replace(CLAIM_REJECT_PATTERN, '').slice(0, CLAIM_CODE_LENGTH));
    setLookupError(null);
  }, []);

  const handleCodeSubmit = useCallback(async () => {
    if (code.length !== CLAIM_CODE_LENGTH || isLookingUp) return;
    setLookupError(null);
    setIsLookingUp(true);
    const result = await lookupInvite({ via: 'code', claim_code: code });
    setIsLookingUp(false);
    if (result.ok) {
      applyPreview(result.preview);
    } else {
      setLookupError(result.message);
    }
  }, [code, isLookingUp, applyPreview]);

  /** Back to the code screen — the recovery path when an accept token expires. */
  const restartWithCode = useCallback(() => {
    previewRef.current = null;
    setPreview(null);
    setCode('');
    setFormError(null);
    setLookupError(null);
    setSubmitAttempted(false);
    setPhase('code');
  }, []);

  const goToLogin = useCallback(() => {
    router.replace('/login');
  }, [router]);

  const visibleError = formError ?? (submitAttempted ? error : null) ?? lookupError;

  return (
    <ImageBackground
      source={require('../../assets/login-bg.png')}
      resizeMode="cover"
      style={styles.screen}
    >
      <Stack.Screen options={{ headerShown: false }} />
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
              {/* Frosted-glass backdrop, same as the login screen */}
              <BlurView
                intensity={55}
                tint="light"
                experimentalBlurMethod="dimezisBlurView"
                style={styles.cardGlass}
              />
              <View pointerEvents="none" style={styles.cardTint} />

              <View style={styles.logo}>
                <Image
                  source={require('../../assets/icon.png')}
                  style={styles.logoImage}
                  resizeMode="cover"
                  accessibilityRole="image"
                  accessibilityLabel="4КУБ"
                />
              </View>

              {/* ---------------------------------------------------------- */}
              {/* 1. RESOLVING                                               */}
              {/* ---------------------------------------------------------- */}
              {phase === 'resolving' && (
                <View style={styles.resolvingBlock}>
                  <Text style={styles.title}>4КУБ</Text>
                  <ActivityIndicator
                    accessibilityLabel="Идёт поиск приглашения"
                    color={COLORS.burntOrange}
                    size="large"
                    style={styles.resolvingSpinner}
                  />
                  <Text style={styles.subtitle}>Ищем ваше приглашение…</Text>
                  <Text style={styles.hint}>Это займёт пару секунд.</Text>
                </View>
              )}

              {/* ---------------------------------------------------------- */}
              {/* 2. FOUND — the credentials form                            */}
              {/* ---------------------------------------------------------- */}
              {phase === 'found' && preview !== null && (
                <>
                  <Text style={styles.eyebrow}>Приглашение</Text>
                  <Text
                    accessibilityRole="header"
                    style={styles.title}
                  >{`Вас приглашают в ${preview.org_name}`}</Text>

                  <View style={styles.identityBlock}>
                    <Text style={styles.inviteeName}>{preview.name}</Text>
                    <View style={styles.roleBadge}>
                      <Ionicons
                        name="shield-checkmark-outline"
                        size={15}
                        color={COLORS.darkBrown}
                      />
                      <Text style={styles.roleBadgeText}>{roleLabel(preview.role)}</Text>
                    </View>
                  </View>

                  <Text style={styles.subtitle}>
                    Осталось придумать, как вы будете входить. Аккаунт создаётся сразу после
                    отправки.
                  </Text>

                  {/* Phone */}
                  <View
                    style={[
                      styles.inputWrapper,
                      focusedField === 'phone' && styles.inputWrapperFocused,
                    ]}
                  >
                    <Ionicons
                      name="call-outline"
                      size={25}
                      color={COLORS.mutedTerracotta}
                      style={styles.inputIcon}
                    />
                    <TextInput
                      accessibilityLabel="Номер телефона"
                      autoComplete="tel"
                      autoCorrect={false}
                      keyboardType="phone-pad"
                      maxLength={20}
                      onBlur={() => setFocusedField(null)}
                      onChangeText={setPhone}
                      onFocus={() => setFocusedField('phone')}
                      onSubmitEditing={() => emailRef.current?.focus()}
                      placeholder="Телефон, например +7 999 123-45-67"
                      placeholderTextColor={COLORS.dustyRose}
                      returnKeyType="next"
                      selectionColor={COLORS.burntOrange}
                      style={styles.input}
                      value={phone}
                    />
                  </View>
                  <View style={styles.noticeRow}>
                    <Ionicons
                      name="information-circle-outline"
                      size={17}
                      color={COLORS.mutedTerracotta}
                      style={styles.noticeIcon}
                    />
                    <Text style={styles.noticeText}>
                      Код по СМС не придёт — приложение не отправляет СМС. Номер нужен только
                      для того, чтобы коллеги могли с вами связаться.
                    </Text>
                  </View>

                  {/* Email */}
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
                      accessibilityLabel="Адрес электронной почты"
                      autoCapitalize="none"
                      autoComplete="email"
                      autoCorrect={false}
                      inputMode="email"
                      keyboardType="email-address"
                      onBlur={() => setFocusedField(null)}
                      onChangeText={setEmail}
                      onFocus={() => setFocusedField('email')}
                      onSubmitEditing={() => passwordRef.current?.focus()}
                      placeholder="Электронная почта"
                      placeholderTextColor={COLORS.dustyRose}
                      ref={emailRef}
                      returnKeyType="next"
                      selectionColor={COLORS.burntOrange}
                      style={styles.input}
                      value={email}
                    />
                  </View>

                  {/* Password */}
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
                      accessibilityLabel="Новый пароль"
                      autoCapitalize="none"
                      autoComplete="new-password"
                      autoCorrect={false}
                      onBlur={() => setFocusedField(null)}
                      onChangeText={setPassword}
                      onFocus={() => setFocusedField('password')}
                      onSubmitEditing={() => confirmRef.current?.focus()}
                      placeholder="Пароль"
                      placeholderTextColor={COLORS.dustyRose}
                      ref={passwordRef}
                      returnKeyType="next"
                      secureTextEntry={!showPassword}
                      selectionColor={COLORS.burntOrange}
                      style={styles.input}
                      value={password}
                    />
                    <Pressable
                      accessibilityLabel={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                      accessibilityRole="button"
                      hitSlop={12}
                      onPress={() => setShowPassword((v) => !v)}
                      style={({ pressed }) => [styles.eyeButton, pressed && styles.pressed]}
                    >
                      <Ionicons
                        name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                        size={26}
                        color={COLORS.mutedTerracotta}
                      />
                    </Pressable>
                  </View>

                  {/* Live rule checklist — the same five rules the server enforces */}
                  <View accessibilityRole="summary" style={styles.rules}>
                    <Text style={styles.rulesTitle}>Пароль должен содержать:</Text>
                    {PASSWORD_RULES.map((rule) => {
                      const met = rule.test(password);
                      return (
                        <View key={rule.label} style={styles.ruleRow}>
                          <Ionicons
                            name={met ? 'checkmark-circle' : 'ellipse-outline'}
                            size={16}
                            color={met ? COLORS.green : COLORS.dustyRose}
                          />
                          <Text
                            accessibilityLabel={`${rule.label}: ${met ? 'выполнено' : 'не выполнено'}`}
                            style={[styles.ruleText, met && styles.ruleTextMet]}
                          >
                            {rule.label}
                          </Text>
                        </View>
                      );
                    })}
                  </View>

                  {/* Confirm password */}
                  <View
                    style={[
                      styles.inputWrapper,
                      focusedField === 'confirm' && styles.inputWrapperFocused,
                    ]}
                  >
                    <Ionicons
                      name="lock-closed-outline"
                      size={25}
                      color={COLORS.mutedTerracotta}
                      style={styles.inputIcon}
                    />
                    <TextInput
                      accessibilityLabel="Повторите пароль"
                      autoCapitalize="none"
                      autoComplete="new-password"
                      autoCorrect={false}
                      onBlur={() => setFocusedField(null)}
                      onChangeText={setConfirmPassword}
                      onFocus={() => setFocusedField('confirm')}
                      onSubmitEditing={() => {
                        void handleAccept();
                      }}
                      placeholder="Повторите пароль"
                      placeholderTextColor={COLORS.dustyRose}
                      ref={confirmRef}
                      returnKeyType="done"
                      secureTextEntry={!showPassword}
                      selectionColor={COLORS.burntOrange}
                      style={styles.input}
                      value={confirmPassword}
                    />
                  </View>

                  {visibleError !== null && (
                    <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                      {visibleError}
                    </Text>
                  )}

                  <Pressable
                    accessibilityLabel="Принять приглашение и создать аккаунт"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: isLoading }}
                    disabled={isLoading}
                    onPress={() => {
                      void handleAccept();
                    }}
                    style={({ pressed }) => [
                      styles.primaryButtonShadow,
                      pressed && !isLoading && styles.pressed,
                      isLoading && styles.disabled,
                    ]}
                  >
                    <LinearGradient
                      colors={[COLORS.burntOrange, COLORS.darkBrown]}
                      start={{ x: 0, y: 0.5 }}
                      end={{ x: 1, y: 0.5 }}
                      style={styles.primaryButton}
                    >
                      {isLoading ? (
                        <ActivityIndicator color={COLORS.white} />
                      ) : (
                        <Text style={styles.primaryButtonText}>Принять приглашение</Text>
                      )}
                    </LinearGradient>
                  </Pressable>

                  {/* The accept token lives 30 minutes; the claim code outlives a
                      failed submit, so retyping it is the way back in. */}
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={restartWithCode}
                    style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.linkText}>Ввести код приглашения вручную</Text>
                  </Pressable>
                </>
              )}

              {/* ---------------------------------------------------------- */}
              {/* 3. MANUAL CODE                                             */}
              {/* ---------------------------------------------------------- */}
              {phase === 'code' && (
                <>
                  <Text style={styles.eyebrow}>Приглашение</Text>
                  <Text accessibilityRole="header" style={styles.title}>
                    Введите код приглашения
                  </Text>
                  <Text style={styles.subtitle}>
                    Код из шести символов показан на странице приглашения — той, что открылась в
                    браузере, когда вы перешли по ссылке. Вернитесь на неё и перепишите код сюда.
                  </Text>

                  <View
                    style={[
                      styles.inputWrapper,
                      focusedField === 'code' && styles.inputWrapperFocused,
                    ]}
                  >
                    <Ionicons
                      name="key-outline"
                      size={25}
                      color={COLORS.mutedTerracotta}
                      style={styles.inputIcon}
                    />
                    <TextInput
                      accessibilityLabel="Код приглашения из шести символов"
                      autoCapitalize="characters"
                      autoComplete="off"
                      autoCorrect={false}
                      maxLength={CLAIM_CODE_LENGTH}
                      onBlur={() => setFocusedField(null)}
                      onChangeText={handleCodeChange}
                      onFocus={() => setFocusedField('code')}
                      onSubmitEditing={() => {
                        void handleCodeSubmit();
                      }}
                      placeholder="XXXXXX"
                      placeholderTextColor={COLORS.dustyRose}
                      returnKeyType="done"
                      selectionColor={COLORS.burntOrange}
                      style={[styles.input, styles.codeInput]}
                      value={code}
                    />
                  </View>

                  <Text style={styles.hint}>
                    Буквы и цифры, без пробелов и дефисов. Букв «O» и «I» и цифр «0» и «1» в коде
                    не бывает — их слишком легко перепутать. Код действует 15 минут.
                  </Text>

                  {lookupError !== null && (
                    <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                      {lookupError}
                    </Text>
                  )}

                  <Pressable
                    accessibilityLabel="Продолжить с введённым кодом"
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled: isLookingUp || code.length !== CLAIM_CODE_LENGTH,
                    }}
                    disabled={isLookingUp || code.length !== CLAIM_CODE_LENGTH}
                    onPress={() => {
                      void handleCodeSubmit();
                    }}
                    style={({ pressed }) => [
                      styles.primaryButtonShadow,
                      pressed && !isLookingUp && styles.pressed,
                      (isLookingUp || code.length !== CLAIM_CODE_LENGTH) && styles.disabled,
                    ]}
                  >
                    <LinearGradient
                      colors={[COLORS.burntOrange, COLORS.darkBrown]}
                      start={{ x: 0, y: 0.5 }}
                      end={{ x: 1, y: 0.5 }}
                      style={styles.primaryButton}
                    >
                      {isLookingUp ? (
                        <ActivityIndicator color={COLORS.white} />
                      ) : (
                        <Text style={styles.primaryButtonText}>Продолжить</Text>
                      )}
                    </LinearGradient>
                  </Pressable>

                  <Pressable
                    accessibilityLabel="Перейти ко входу в существующий аккаунт"
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={goToLogin}
                    style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.linkText}>У меня уже есть аккаунт — войти</Text>
                  </Pressable>
                </>
              )}
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

  // Headings
  eyebrow: {
    color: COLORS.mutedTerracotta,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.4,
    textAlign: 'center',
    textTransform: 'uppercase',
    marginBottom: 8,
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
  hint: {
    marginTop: 12,
    color: COLORS.mutedTerracotta,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },

  // Resolving
  resolvingBlock: {
    alignItems: 'center',
    paddingBottom: 26,
  },
  resolvingSpinner: {
    marginTop: 26,
  },

  // Invitee identity
  identityBlock: {
    marginTop: 16,
    alignItems: 'center',
  },
  inviteeName: {
    color: COLORS.charcoal,
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
  },
  roleBadge: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(201, 169, 154, 0.9)',
    backgroundColor: 'rgba(232, 221, 214, 0.82)',
  },
  roleBadgeText: {
    color: COLORS.darkBrown,
    fontSize: 13,
    fontWeight: '800',
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
  codeInput: {
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 6,
    textAlign: 'center',
  },
  eyeButton: {
    marginLeft: 10,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Phone notice
  noticeRow: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  noticeIcon: {
    marginTop: 1,
    marginRight: 7,
  },
  noticeText: {
    flex: 1,
    color: COLORS.mutedTerracotta,
    fontSize: 12.5,
    lineHeight: 17,
  },

  // Password rules
  rules: {
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(201, 169, 154, 0.6)',
    backgroundColor: 'rgba(232, 221, 214, 0.5)',
  },
  rulesTitle: {
    color: COLORS.darkBrown,
    fontSize: 12.5,
    fontWeight: '800',
    marginBottom: 8,
  },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 3,
  },
  ruleText: {
    flex: 1,
    color: COLORS.mutedTerracotta,
    fontSize: 12.5,
    lineHeight: 17,
  },
  ruleTextMet: {
    color: COLORS.green,
    fontWeight: '700',
  },

  // Error
  errorText: {
    color: COLORS.red,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 14,
  },

  // Buttons
  primaryButtonShadow: {
    marginTop: 24,
    borderRadius: 13,
    shadowColor: COLORS.darkBrown,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.34,
    shadowRadius: 12,
    elevation: 8,
  },
  primaryButton: {
    minHeight: 60,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  primaryButtonText: {
    color: COLORS.white,
    fontSize: 19,
    fontWeight: '900',
    letterSpacing: 0.1,
  },
  linkButton: {
    marginTop: 6,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  linkText: {
    color: COLORS.darkBrown,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.66 },
});
