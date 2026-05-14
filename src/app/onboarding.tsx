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
import { CheckCircle2, ClipboardList, UserPlus, Workflow } from 'lucide-react-native';
import { useUserStore } from '../store/userStore';

const steps = [
  { icon: UserPlus, title: 'Add your first contact' },
  { icon: Workflow, title: 'Move a deal through the board' },
  { icon: ClipboardList, title: 'Set the next follow-up' },
];

export default function OnboardingScreen(): JSX.Element {
  const completeOnboarding = useUserStore((s) => s.completeOnboarding);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.title}>Start clean</Text>
        <View style={styles.steps}>
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <View key={step.title} style={styles.step}>
                <View style={styles.stepIcon}>
                  <Icon size={22} color="#1A73E8" />
                </View>
                <Text style={styles.stepNumber}>{index + 1}</Text>
                <Text style={styles.stepTitle}>{step.title}</Text>
              </View>
            );
          })}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => { void finish(); }}
          disabled={isSaving}
          accessibilityRole="button"
        >
          {isSaving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <>
              <CheckCircle2 size={20} color="#FFFFFF" />
              <Text style={styles.primaryText}>Enter CRM</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#F7F8FA',
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 24,
  },
  steps: {
    gap: 12,
  },
  step: {
    minHeight: 72,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepIcon: {
    width: 42,
    height: 42,
    borderRadius: 8,
    backgroundColor: '#E8F0FE',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  stepNumber: {
    width: 24,
    color: '#6B7280',
    fontWeight: '700',
  },
  stepTitle: {
    flex: 1,
    color: '#111827',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    marginTop: 16,
    color: '#C5221F',
  },
  primaryButton: {
    height: 52,
    borderRadius: 8,
    backgroundColor: '#1A73E8',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 24,
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
