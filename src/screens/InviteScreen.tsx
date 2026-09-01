import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { Stack, useRouter } from 'expo-router';
import { getInitialURL, useURL } from 'expo-linking';
import { useUserStore } from '../store/userStore';
import {
  discoverInvite,
  lookupInvite,
  tokenFromUrl,
  type InviteLookupResult,
  type InvitePreview,
} from '../utils/inviteDiscovery';
import { PASSWORD_MAX_BYTES, utf8ByteLength } from '../utils/password';
import { isCommonPassword } from '../utils/password-blocklist';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors, spacing, radius, type, control, tabular } from '../theme';
import { Button, Card } from '../components/ui';

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
type FoundStep = 'email' | 'password' | 'confirmPassword' | 'phone';
type FocusedField = 'phone' | 'email' | 'password' | 'confirm' | 'code' | null;

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
 * Run one lookup and apply its result — the single path BOTH racers take.
 *
 * A link arriving while this screen is open and a code typed into the form hit
 * the same endpoint, and the server hands the loser of that race a 409 instead
 * of a second accept token (the `minted.count === 0` branch in
 * backend/api/controllers/invites.ts). Two rules follow, and each one previously
 * held on only one of the two paths, which is why they live here now:
 *
 *   THE SPINNER IS CLEARED BEFORE THE STALENESS CHECK, never after it. Nothing
 *   else in this screen ever sets `isLookingUp` back to false — `restartWithCode`
 *   does not touch it — so a guarded return that skipped the reset left
 *   «Продолжить» disabled behind a spinner with no recovery short of killing the
 *   app.
 *
 *   A RESULT THAT ARRIVES AFTER THE OTHER RACER HAS PAINTED THE FORM IS DROPPED.
 *   `lookupError` renders inside the `found` block as well as the `code` block,
 *   so a late 409 would otherwise put a red "приглашение уже открыто на другом
 *   устройстве" underneath a form the invitee is halfway through filling in —
 *   an error about a race they cannot see, on the one screen where there is no
 *   account to fall back to.
 *
 * The previous error is cleared BEFORE the request rather than after it, so the
 * screen never shows a stale failure next to a live spinner.
 *
 * Module-level and dependency-injected rather than a hook: that ordering is the
 * entire content of the function, and this way it can be tested by driving the
 * promise directly instead of through a renderer.
 */
export async function settleInviteLookup(
  lookup: () => Promise<InviteLookupResult>,
  handlers: {
    setIsLookingUp: (value: boolean) => void;
    setLookupError: (message: string | null) => void;
    applyPreview: (preview: InvitePreview) => void;
    isStale: () => boolean;
  },
): Promise<void> {
  handlers.setLookupError(null);
  handlers.setIsLookingUp(true);
  const result = await lookup();
  handlers.setIsLookingUp(false);
  if (handlers.isStale()) return;
  if (result.ok) {
    handlers.applyPreview(result.preview);
  } else {
    handlers.setLookupError(result.message);
  }
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
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { isLoading, error, acceptInvite } = useUserStore();

  const [phase, setPhase] = useState<Phase>('resolving');
  // Four fields, four screens: entered one at a time rather than on one long
  // form, so «Далее» always means «the field I am looking at is valid» instead
  // of leaving all four errors to surface together at the very end.
  const [foundStep, setFoundStep] = useState<FoundStep>('email');
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

  // Discovery can cross the native bridge, read the clipboard, and hit the
  // lookup endpoint. Fire it once from a ref-guarded effect rather than repeating
  // those side effects whenever the URL hook settles.
  const discoveryStartedRef = useRef(false);
  // Kept alongside the state so the late-URL effect below can read it without
  // re-subscribing every time the form changes.
  const previewRef = useRef<InvitePreview | null>(null);
  const handledUrlRef = useRef<string | null>(null);

  const applyPreview = useCallback((found: InvitePreview) => {
    previewRef.current = found;
    setPreview(found);
    setLookupError(null);
    setFoundStep('email');
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
    void settleInviteLookup(() => lookupInvite({ via: 'link', token }), {
      setIsLookingUp,
      setLookupError,
      applyPreview,
      isStale: () => cancelled || previewRef.current !== null,
    });

    return () => {
      cancelled = true;
    };
  }, [url, phase, applyPreview]);

  const normalizedEmail = useMemo(() => email.trim().toLowerCase(), [email]);
  const trimmedPhone = useMemo(() => phone.trim(), [phone]);
  const phoneDigits = useMemo(() => trimmedPhone.replace(/\D/g, ''), [trimmedPhone]);

  // One validator per step, so «Далее» can check only the field the invitee is
  // looking at. handleAccept below runs all three again as a last defense —
  // cheap, and it means a step can never be skipped past by anything (a stale
  // ref, a fast double-tap) without the final submit still catching it.
  const validateEmailStep = useCallback((): string | null => {
    if (normalizedEmail.length === 0) return 'Введите адрес электронной почты';
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      return 'Проверьте адрес электронной почты: он должен быть вида имя@компания.ру';
    }
    return null;
  }, [normalizedEmail]);

  const validatePasswordStep = useCallback((): string | null => {
    if (password.length === 0) return 'Придумайте пароль';
    const failed = PASSWORD_RULES.find((rule) => !rule.test(password));
    if (failed !== undefined) return failed.message;
    // 72 BYTES, not 100 characters. This said `> 100` while the server refuses
    // at 72 bytes — and Cyrillic is two bytes a letter, so a 40-character
    // Russian passphrase passed here and was refused there, on a screen where a
    // 400 is a dead end because the person has no account to retry from.
    if (utf8ByteLength(password) > PASSWORD_MAX_BYTES) {
      return 'Пароль слишком длинный — до 72 байт (кириллица считается за два символа)';
    }
    // Not expressible as a checklist row — a rule you satisfy by NOT being on a
    // list has nothing to tick — so it lives here rather than in PASSWORD_RULES.
    if (isCommonPassword(password)) {
      return 'Этот пароль слишком простой — придумайте другой';
    }
    return null;
  }, [password]);

  const validateConfirmPasswordStep = useCallback((): string | null => {
    if (confirmPassword.length === 0) return 'Повторите пароль ещё раз';
    if (password !== confirmPassword) return 'Пароли не совпадают';
    return null;
  }, [password, confirmPassword]);

  const validatePhoneStep = useCallback((): string | null => {
    if (trimmedPhone.length === 0) return 'Введите номер телефона';
    if (phoneDigits.length < 10 || trimmedPhone.length < 10) {
      return 'Номер телефона должен содержать не менее 10 цифр';
    }
    if (trimmedPhone.length > 20) return 'Номер телефона слишком длинный — не более 20 символов';
    return null;
  }, [trimmedPhone, phoneDigits]);

  const goToPasswordStep = useCallback(() => {
    const problem = validateEmailStep();
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setFoundStep('password');
  }, [validateEmailStep]);

  const goToConfirmPasswordStep = useCallback(() => {
    const problem = validatePasswordStep();
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setFoundStep('confirmPassword');
  }, [validatePasswordStep]);

  const goToPhoneStep = useCallback(() => {
    const problem = validateConfirmPasswordStep();
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setFoundStep('phone');
  }, [validateConfirmPasswordStep]);

  const goBackToEmailStep = useCallback(() => {
    setFormError(null);
    setFoundStep('email');
  }, []);

  const goBackToPasswordStep = useCallback(() => {
    setFormError(null);
    setFoundStep('password');
  }, []);

  const goBackToConfirmPasswordStep = useCallback(() => {
    setFormError(null);
    setFoundStep('confirmPassword');
  }, []);

  const handleAccept = useCallback(async () => {
    if (preview === null || isLoading) return;

    const problem =
      validateEmailStep() ?? validatePasswordStep() ?? validateConfirmPasswordStep() ?? validatePhoneStep();
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
    if (state.error !== null) return;

    /**
     * TWO DESTINATIONS, because the server has two answers — see `acceptInvite`.
     *
     * The verification branch is checked FIRST. Both branches are reachable only
     * after the account has been created and the single-use invite CONSUMED, so
     * failing to navigate is not a retry the invitee can make: the link is gone
     * and only an owner can mint another. Whichever answer arrived, this screen
     * must move.
     */
    if (state.pendingVerification !== null) {
      router.replace('/verify' as never);
      return;
    }
    if (state.user !== null && state.token !== null) {
      router.replace('/(tabs)' as never);
    }
  }, [
    preview, isLoading, validateEmailStep, validatePasswordStep, validateConfirmPasswordStep,
    validatePhoneStep, acceptInvite, trimmedPhone, normalizedEmail, password, router,
  ]);

  const handleCodeChange = useCallback((raw: string) => {
    setCode(raw.toUpperCase().replace(CLAIM_REJECT_PATTERN, '').slice(0, CLAIM_CODE_LENGTH));
    setLookupError(null);
  }, []);

  const handleCodeSubmit = useCallback(async () => {
    if (code.length !== CLAIM_CODE_LENGTH || isLookingUp) return;
    await settleInviteLookup(() => lookupInvite({ via: 'code', claim_code: code }), {
      setIsLookingUp,
      setLookupError,
      applyPreview,
      // A link can arrive and win while this request is in flight; the 409 it
      // leaves behind must not land under the form the link already filled in.
      isStale: () => previewRef.current !== null,
    });
  }, [code, isLookingUp, applyPreview]);

  /** Back to the code screen — the recovery path when an accept token expires. */
  const restartWithCode = useCallback(() => {
    previewRef.current = null;
    setPreview(null);
    setCode('');
    setFormError(null);
    setLookupError(null);
    setSubmitAttempted(false);
    setFoundStep('email');
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
            <Card padded={false} style={styles.card}>
              {/* Frosted-glass backdrop, same as the login screen */}
              <BlurView
                intensity={55}
                tint={isDark ? 'dark' : 'light'}
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
                    color={colors.accent}
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
                        color={colors.accent}
                      />
                      <Text style={styles.roleBadgeText}>{roleLabel(preview.role)}</Text>
                    </View>
                  </View>

                  <Text style={styles.stepIndicator}>
                    {foundStep === 'email' && 'Шаг 1 из 4 — почта'}
                    {foundStep === 'password' && 'Шаг 2 из 4 — пароль'}
                    {foundStep === 'confirmPassword' && 'Шаг 3 из 4 — подтверждение пароля'}
                    {foundStep === 'phone' && 'Шаг 4 из 4 — телефон'}
                  </Text>

                  {/* ------------------------------------------------------ */}
                  {/* 2a. EMAIL                                               */}
                  {/* ------------------------------------------------------ */}
                  {foundStep === 'email' && (
                    <>
                      <Text style={styles.subtitle}>
                        Укажите почту, на которую будете входить.
                      </Text>

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
                          accessibilityLabel="Адрес электронной почты"
                          autoCapitalize="none"
                          autoComplete="email"
                          autoCorrect={false}
                          autoFocus
                          inputMode="email"
                          keyboardType="email-address"
                          onBlur={() => setFocusedField(null)}
                          onChangeText={setEmail}
                          onFocus={() => setFocusedField('email')}
                          onSubmitEditing={goToPasswordStep}
                          placeholder="Электронная почта"
                          placeholderTextColor={colors.placeholder}
                          returnKeyType="next"
                          selectionColor={colors.accent}
                          style={styles.input}
                          value={email}
                        />
                      </View>

                      {visibleError !== null && (
                        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                          {visibleError}
                        </Text>
                      )}

                      <Button
                        title="Далее"
                        accessibilityLabel="Далее — придумать пароль"
                        onPress={goToPasswordStep}
                        block
                        style={styles.primaryButton}
                      />

                      {/* The accept token lives 30 minutes; the claim code outlives a
                          failed submit, so retyping it is the way back in. */}
                      <TouchableOpacity
                        accessibilityRole="button"
                        activeOpacity={0.7}
                        hitSlop={8}
                        onPress={restartWithCode}
                        style={styles.linkButton}
                      >
                        <Text style={styles.linkText}>Ввести код приглашения вручную</Text>
                      </TouchableOpacity>
                    </>
                  )}

                  {/* ------------------------------------------------------ */}
                  {/* 2b. PASSWORD                                            */}
                  {/* ------------------------------------------------------ */}
                  {foundStep === 'password' && (
                    <>
                      <Text style={styles.subtitle}>Придумайте пароль для входа.</Text>

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
                          accessibilityLabel="Новый пароль"
                          autoCapitalize="none"
                          autoComplete="new-password"
                          autoCorrect={false}
                          autoFocus
                          onBlur={() => setFocusedField(null)}
                          onChangeText={setPassword}
                          onFocus={() => setFocusedField('password')}
                          onSubmitEditing={goToConfirmPasswordStep}
                          placeholder="Пароль"
                          placeholderTextColor={colors.placeholder}
                          returnKeyType="next"
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
                          onPress={() => setShowPassword((v) => !v)}
                          style={styles.eyeButton}
                        >
                          <Ionicons
                            name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                            size={26}
                            color={colors.textMuted}
                          />
                        </TouchableOpacity>
                      </View>

                      {/* Live rule checklist — the same five rules the server enforces */}
                      <View accessibilityRole="summary" style={styles.rules}>
                        <Text style={styles.rulesTitle}>
                          Пароль должен содержать:
                        </Text>
                        {PASSWORD_RULES.map((rule) => {
                          const met = rule.test(password);
                          return (
                            <View key={rule.label} style={styles.ruleRow}>
                              <Ionicons
                                name={met ? 'checkmark-circle' : 'ellipse-outline'}
                                size={16}
                                color={met ? colors.success : colors.placeholder}
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

                      {visibleError !== null && (
                        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                          {visibleError}
                        </Text>
                      )}

                      <Button
                        title="Далее"
                        accessibilityLabel="Далее — подтвердить пароль"
                        onPress={goToConfirmPasswordStep}
                        block
                        style={styles.primaryButton}
                      />

                      <TouchableOpacity
                        accessibilityRole="button"
                        activeOpacity={0.7}
                        hitSlop={8}
                        onPress={goBackToEmailStep}
                        style={styles.linkButton}
                      >
                        <Text style={styles.linkText}>‹ Назад</Text>
                      </TouchableOpacity>
                    </>
                  )}

                  {/* ------------------------------------------------------ */}
                  {/* 2c. CONFIRM PASSWORD                                    */}
                  {/* ------------------------------------------------------ */}
                  {foundStep === 'confirmPassword' && (
                    <>
                      <Text style={styles.subtitle}>Повторите пароль ещё раз.</Text>

                      <View
                        style={[
                          styles.inputWrapper,
                          focusedField === 'confirm' && styles.inputWrapperFocused,
                        ]}
                      >
                        <Ionicons
                          name="lock-closed-outline"
                          size={25}
                          color={colors.textMuted}
                          style={styles.inputIcon}
                        />
                        <TextInput
                          accessibilityLabel="Повторите пароль"
                          autoCapitalize="none"
                          autoComplete="new-password"
                          autoCorrect={false}
                          autoFocus
                          onBlur={() => setFocusedField(null)}
                          onChangeText={setConfirmPassword}
                          onFocus={() => setFocusedField('confirm')}
                          onSubmitEditing={goToPhoneStep}
                          placeholder="Повторите пароль"
                          placeholderTextColor={colors.placeholder}
                          returnKeyType="next"
                          secureTextEntry={!showPassword}
                          selectionColor={colors.accent}
                          style={styles.input}
                          value={confirmPassword}
                        />
                        <TouchableOpacity
                          accessibilityLabel={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                          accessibilityRole="button"
                          activeOpacity={0.7}
                          hitSlop={12}
                          onPress={() => setShowPassword((v) => !v)}
                          style={styles.eyeButton}
                        >
                          <Ionicons
                            name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                            size={26}
                            color={colors.textMuted}
                          />
                        </TouchableOpacity>
                      </View>

                      {visibleError !== null && (
                        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                          {visibleError}
                        </Text>
                      )}

                      <Button
                        title="Далее"
                        accessibilityLabel="Далее — указать телефон"
                        onPress={goToPhoneStep}
                        block
                        style={styles.primaryButton}
                      />

                      <TouchableOpacity
                        accessibilityRole="button"
                        activeOpacity={0.7}
                        hitSlop={8}
                        onPress={goBackToPasswordStep}
                        style={styles.linkButton}
                      >
                        <Text style={styles.linkText}>‹ Назад</Text>
                      </TouchableOpacity>
                    </>
                  )}

                  {/* ------------------------------------------------------ */}
                  {/* 2d. PHONE — final step, submits                        */}
                  {/* ------------------------------------------------------ */}
                  {foundStep === 'phone' && (
                    <>
                      <Text style={styles.subtitle}>
                        Остался номер телефона — чтобы коллеги могли с вами связаться.
                      </Text>

                      <View
                        style={[
                          styles.inputWrapper,
                          focusedField === 'phone' && styles.inputWrapperFocused,
                        ]}
                      >
                        <Ionicons
                          name="call-outline"
                          size={25}
                          color={colors.textMuted}
                          style={styles.inputIcon}
                        />
                        <TextInput
                          accessibilityLabel="Номер телефона"
                          autoComplete="tel"
                          autoCorrect={false}
                          autoFocus
                          keyboardType="phone-pad"
                          maxLength={20}
                          onBlur={() => setFocusedField(null)}
                          onChangeText={setPhone}
                          onFocus={() => setFocusedField('phone')}
                          onSubmitEditing={() => {
                            void handleAccept();
                          }}
                          placeholder="Телефон, например +7 999 123-45-67"
                          placeholderTextColor={colors.placeholder}
                          returnKeyType="done"
                          selectionColor={colors.accent}
                          style={styles.input}
                          value={phone}
                        />
                      </View>
                      <View style={styles.noticeRow}>
                        <Ionicons
                          name="information-circle-outline"
                          size={17}
                          color={colors.textMuted}
                          style={styles.noticeIcon}
                        />
                        <Text style={styles.noticeText}>
                          Код по СМС не придёт — приложение не отправляет СМС. Номер нужен только
                          для того, чтобы коллеги могли с вами связаться.
                        </Text>
                      </View>

                      {visibleError !== null && (
                        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                          {visibleError}
                        </Text>
                      )}

                      <Button
                        title="Принять приглашение"
                        accessibilityLabel="Принять приглашение и создать аккаунт"
                        onPress={() => {
                          void handleAccept();
                        }}
                        loading={isLoading}
                        disabled={isLoading}
                        block
                        style={styles.primaryButton}
                      />

                      <TouchableOpacity
                        accessibilityRole="button"
                        activeOpacity={0.7}
                        hitSlop={8}
                        onPress={goBackToConfirmPasswordStep}
                        style={styles.linkButton}
                      >
                        <Text style={styles.linkText}>‹ Назад</Text>
                      </TouchableOpacity>
                    </>
                  )}
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
                      color={colors.textMuted}
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
                      placeholderTextColor={colors.placeholder}
                      returnKeyType="done"
                      selectionColor={colors.accent}
                      style={[styles.input, styles.codeInput]}
                      value={code}
                    />
                  </View>

                  {/* Where the clock started, because it did not start here.
                      CLAIM_TTL_MS is written into claim_expires_at by
                      InviteController.open — that is, when the landing page was
                      loaded, before the store download that got the invitee to
                      this screen. Saying only "the code lasts N minutes" hands
                      them a budget several minutes of which is already spent.
                      Re-opening the link mints a fresh code with a fresh N
                      (the retry loop in `open`), which is the way out and is why
                      it is offered in the same breath.
                      The number is the server's: tests/unit/mobile/invite-screen.test.ts
                      asserts this sentence against CLAIM_TTL_MS, so the two
                      cannot drift apart in silence the way they already did once. */}
                  <Text style={styles.hint}>
                    Буквы и цифры, без пробелов и дефисов. Букв «O» и «I» и цифр «0» и «1» в коде
                    не бывает — их слишком легко перепутать. Код живёт 45 минут с того момента, как
                    открылась страница приглашения, — если он больше не подходит, откройте ссылку
                    заново: код обновится.
                  </Text>

                  {lookupError !== null && (
                    <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                      {lookupError}
                    </Text>
                  )}

                  <Button
                    title="Продолжить"
                    accessibilityLabel="Продолжить с введённым кодом"
                    onPress={() => {
                      void handleCodeSubmit();
                    }}
                    loading={isLookingUp}
                    disabled={isLookingUp || code.length !== CLAIM_CODE_LENGTH}
                    block
                    style={styles.primaryButton}
                  />

                  <TouchableOpacity
                    accessibilityLabel="Перейти ко входу в существующий аккаунт"
                    accessibilityRole="button"
                    activeOpacity={0.7}
                    hitSlop={8}
                    onPress={goToLogin}
                    style={styles.linkButton}
                  >
                    <Text style={styles.linkText}>У меня уже есть аккаунт — войти</Text>
                  </TouchableOpacity>
                </>
              )}
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

  // Headings
  eyebrow: {
    ...type.caption,
    color: c.textMuted,
    letterSpacing: 1.4,
    textAlign: 'center',
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
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
  hint: {
    marginTop: spacing.md,
    ...type.caption,
    color: c.textMuted,
    textAlign: 'center',
  },
  stepIndicator: {
    marginTop: spacing.md,
    ...type.caption,
    color: c.textMuted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    textAlign: 'center',
  },

  // Resolving
  resolvingBlock: {
    alignItems: 'center',
    paddingBottom: spacing.xl,
  },
  resolvingSpinner: {
    marginTop: spacing.xl,
  },

  // Invitee identity
  identityBlock: {
    marginTop: spacing.lg,
    alignItems: 'center',
  },
  inviteeName: {
    ...type.subtitle,
    color: c.text1,
    textAlign: 'center',
  },
  roleBadge: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: c.accentSoft,
  },
  roleBadgeText: {
    ...type.label,
    color: c.text1,
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
  codeInput: {
    ...type.title,
    ...tabular,
    letterSpacing: 6,
    textAlign: 'center',
  },
  eyeButton: {
    marginLeft: spacing.sm,
    minWidth: control.sm + spacing.sm,
    minHeight: control.sm + spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Phone notice
  noticeRow: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  noticeIcon: {
    marginTop: 1,
    marginRight: spacing.sm,
  },
  noticeText: {
    flex: 1,
    ...type.caption,
    color: c.textMuted,
  },

  // Password rules
  rules: {
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: `${c.inputBg}80`,
  },
  rulesTitle: {
    ...type.caption,
    color: c.text1,
    marginBottom: spacing.sm,
  },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  ruleText: {
    flex: 1,
    ...type.caption,
    color: c.textMuted,
  },
  ruleTextMet: {
    color: c.success,
  },

  // Error
  errorText: {
    ...type.label,
    color: c.danger,
    textAlign: 'center',
    marginTop: spacing.md,
  },

  // Buttons
  primaryButton: {
    marginTop: spacing.xl,
  },
  linkButton: {
    marginTop: spacing.sm,
    minHeight: control.sm + spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  linkText: {
    ...type.body,
    color: c.accent,
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
});
