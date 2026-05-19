import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOnboardingStore, WALKTHROUGH_STEPS } from '../store/onboardingStore';
import { useUserStore } from '../store/userStore';

export function OnboardingWalkthrough(): JSX.Element | null {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const { visible, currentStepIndex, completeStep, skipAll } = useOnboardingStore();
  const translateY = useRef(new Animated.Value(120)).current;

  useEffect(() => {
    if (visible) {
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        bounciness: 4,
      }).start();
    } else {
      Animated.timing(translateY, {
        toValue: 120,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, translateY]);

  if (!visible || !token) return null;

  const step = WALKTHROUGH_STEPS[currentStepIndex];
  const total = WALKTHROUGH_STEPS.length;

  const handleGotIt = (): void => {
    void completeStep(token, step);
  };

  const handleSkip = (): void => {
    void skipAll(token);
  };

  return (
    <Animated.View style={[styles.container, { transform: [{ translateY }] }]}>
      <View style={styles.header}>
        <Text style={styles.progress}>
          {t('onboarding.stepOf', { step: currentStepIndex + 1, total })}
        </Text>
        <View style={styles.dots}>
          {WALKTHROUGH_STEPS.map((s, i) => (
            <View
              key={s}
              style={[styles.dot, i === currentStepIndex && styles.dotActive]}
            />
          ))}
        </View>
      </View>

      <Text style={styles.title}>{t(`onboarding.step_${step}_title`)}</Text>
      <Text style={styles.desc}>{t(`onboarding.step_${step}_desc`)}</Text>

      <View style={styles.actions}>
        <TouchableOpacity onPress={handleSkip} style={styles.skipBtn} accessibilityRole="button">
          <Text style={styles.skipText}>{t('onboarding.skipAll')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleGotIt} style={styles.gotItBtn} accessibilityRole="button">
          <Text style={styles.gotItText}>{t('onboarding.gotIt')}</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 90,
    left: 16,
    right: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    zIndex: 9998,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  progress: {
    fontSize: 12,
    color: '#888',
    fontWeight: '500',
  },
  dots: {
    flexDirection: 'row',
    gap: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#DDD',
  },
  dotActive: {
    backgroundColor: '#10b981',
    width: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
    marginBottom: 6,
  },
  desc: {
    fontSize: 14,
    color: '#555',
    lineHeight: 20,
    marginBottom: 16,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  skipBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  skipText: {
    fontSize: 14,
    color: '#888',
    fontWeight: '500',
  },
  gotItBtn: {
    backgroundColor: '#10b981',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 12,
  },
  gotItText: {
    fontSize: 14,
    color: '#FFF',
    fontWeight: '600',
  },
});
