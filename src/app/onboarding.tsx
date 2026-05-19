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
import { CheckCircle2, Kanban, Users, Zap } from 'lucide-react-native';
import { useUserStore } from '../store/userStore';

const slides = [
  {
    Icon: Zap,
    title: 'Welcome to CRM',
    subtitle: 'Your mobile sales command center',
  },
  {
    Icon: Users,
    title: 'Capture every lead',
    subtitle: 'Add contacts and track conversations in one tap',
  },
  {
    Icon: Kanban,
    title: 'Close deals faster',
    subtitle: 'Move deals through your pipeline with a swipe',
  },
  {
    Icon: CheckCircle2,
    title: "You're all set",
    subtitle: "Let's build your pipeline",
  },
];

export default function OnboardingScreen(): JSX.Element {
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
      setError(e instanceof Error ? e.message : 'Could not save onboarding');
    } finally {
      setIsSaving(false);
    }
  };

  const { Icon, title, subtitle } = slides[step]!;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.slide}>
          <View style={styles.iconWrap}>
            <Icon size={56} color="#10b981" />
          </View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
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
            <Text style={styles.primaryText}>{isLast ? 'Get Started' : 'Next'}</Text>
          )}
        </TouchableOpacity>

        {!isLast && (
          <TouchableOpacity
            style={styles.skip}
            onPress={() => { void finish(); }}
            accessibilityRole="button"
          >
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F7F8FA' },
  container: { flex: 1, padding: 24, justifyContent: 'flex-end', paddingBottom: 48 },
  slide: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  iconWrap: {
    width: 112,
    height: 112,
    borderRadius: 28,
    backgroundColor: '#ecfdf5',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  title: { fontSize: 28, fontWeight: '700', color: '#111827', textAlign: 'center', marginBottom: 12 },
  subtitle: { fontSize: 16, color: '#6B7280', textAlign: 'center', lineHeight: 24 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 32 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#E5E7EB' },
  dotActive: { backgroundColor: '#10b981', width: 24 },
  error: { color: '#C5221F', textAlign: 'center', marginBottom: 12 },
  primary: {
    height: 52,
    borderRadius: 12,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  primaryText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  skip: { alignItems: 'center', paddingVertical: 8 },
  skipText: { color: '#6B7280', fontSize: 14 },
});
