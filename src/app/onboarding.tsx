import React, { useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Kanban, Users, Zap } from 'lucide-react-native';
import { useUserStore } from '../store/userStore';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';

const slides = [
  {
    Icon: Zap,
    titleKey: 'onboarding.welcomeTitle',
    subtitleKey: 'onboarding.welcomeSubtitle',
  },
  {
    Icon: Users,
    titleKey: 'onboarding.captureTitle',
    subtitleKey: 'onboarding.captureSubtitle',
  },
  {
    Icon: Kanban,
    titleKey: 'onboarding.closeTitle',
    subtitleKey: 'onboarding.closeSubtitle',
  },
  {
    Icon: CheckCircle2,
    titleKey: 'onboarding.readyTitle',
    subtitleKey: 'onboarding.readySubtitle',
  },
];

export default function OnboardingScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const completeOnboarding = useUserStore((s) => s.completeOnboarding);
  const [step, setStep] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLast = step === slides.length - 1;

  const finish = async (): Promise<void> => {
    try {
      setIsSaving(true);
      setError(null);
      await completeOnboarding();
      router.replace('/(tabs)');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить данные');
    } finally {
      setIsSaving(false);
    }
  };

  const { Icon, titleKey, subtitleKey } = slides[step]!;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.slide}>
          <View style={styles.iconWrap}>
            <Icon size={56} color={colors.orange} />
          </View>
          <Text style={styles.title}>{t(titleKey)}</Text>
          <Text style={styles.subtitle}>{t(subtitleKey)}</Text>
        </View>

        <View style={styles.dots}>
          {slides.map((_, i) => (
            <View key={i} style={[styles.dot, i === step && styles.dotActive]} />
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={styles.primary}
          onPress={() => {
            if (isLast) { void finish(); }
            else { setStep(step + 1); }
          }}
          disabled={isSaving}
          accessibilityRole="button"
        >
          {isSaving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.primaryText}>{isLast ? t('onboarding.getStarted') : t('common.next')}</Text>
          )}
        </TouchableOpacity>

        {!isLast && (
          <TouchableOpacity
            style={styles.skip}
            onPress={() => { void finish(); }}
            accessibilityRole="button"
          >
            <Text style={styles.skipText}>{t('onboarding.skipAll')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  container: { flex: 1, padding: 24, justifyContent: 'flex-end', paddingBottom: 48 },
  slide: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  iconWrap: {
    width: 112,
    height: 112,
    borderRadius: 28,
    backgroundColor: 'rgba(204,120,92,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  title: { fontSize: 28, fontWeight: '700', color: c.text1, textAlign: 'center', marginBottom: 12 },
  subtitle: { fontSize: 16, color: c.amber, textAlign: 'center', lineHeight: 24 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 32 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.border },
  dotActive: { backgroundColor: c.orange, width: 24 },
  error: { color: '#C5221F', textAlign: 'center', marginBottom: 12 },
  primary: {
    height: 52,
    borderRadius: 12,
    backgroundColor: c.orange,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  primaryText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  skip: { alignItems: 'center', paddingVertical: 8 },
  skipText: { color: c.amber, fontSize: 14 },
});
