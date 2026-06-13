import React from 'react';
import { TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';

// Top-left arrow shown on every non-home screen; always returns to the dashboard.
export default function HomeBackButton(): JSX.Element {
  const { t } = useTranslation();
  return (
    <TouchableOpacity
      onPress={() => router.replace('/' as never)}
      style={{ paddingHorizontal: 12, paddingVertical: 6, marginLeft: -4 }}
      accessibilityRole="button"
      accessibilityLabel={t('common.back')}
      hitSlop={8}
    >
      <ArrowLeft size={26} color="#2B2724" strokeWidth={2.4} />
    </TouchableOpacity>
  );
}
