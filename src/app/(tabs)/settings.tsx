import React, { useState, useEffect } from 'react';
import {
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Switch,
} from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { getStoredLanguage } from '../../i18n/storage';

export default function SettingsScreen(): JSX.Element {
  const { t, i18n } = useTranslation();
  const user = useUserStore((s) => s.user);
  const logout = useUserStore((s) => s.logout);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [currentLanguage, setCurrentLanguage] = useState<string>(i18n.language ?? 'en');

  useEffect(() => {
    void getStoredLanguage().then((lang) => {
      if (lang !== null) {
        setCurrentLanguage(lang);
      }
    });
  }, []);

  const handleLogout = async (): Promise<void> => {
    await logout();
    router.replace('/login');
  };

  const languageLabel = currentLanguage === 'ru' ? 'RU' : 'EN';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <Text style={styles.pageTitle}>{t('settings.title')}</Text>

      <Text style={styles.sectionHeader}>{t('settings.profile')}</Text>
      <View style={styles.card}>
        <View style={styles.profileRow}>
          <View style={styles.profileMain}>
            <Text style={styles.profileName}>{user?.name ?? ''}</Text>
            <Text style={styles.profileEmail}>{user?.email ?? ''}</Text>
          </View>
          {user?.role ? (
            <View style={styles.roleBadge}>
              <Text style={styles.roleBadgeText}>{user.role}</Text>
            </View>
          ) : null}
        </View>
      </View>

      <Text style={styles.sectionHeader}>{t('settings.organisation')}</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{t('auth.organization')}</Text>
          <Text style={styles.rowValue}>{user?.org_id ?? ''}</Text>
        </View>
      </View>

      <Text style={styles.sectionHeader}>{t('settings.language')}</Text>
      <TouchableOpacity
        style={styles.card}
        onPress={() => router.push('/language-select' as never)}
        accessibilityRole='button'
      >
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{t('settings.language')}</Text>
          <View style={styles.rowRight}>
            <View style={styles.languageChip}>
              <Text style={styles.languageChipText}>{languageLabel}</Text>
            </View>
            <Text style={styles.chevron}>{'›'}</Text>
          </View>
        </View>
      </TouchableOpacity>

      <Text style={styles.sectionHeader}>{t('settings.notifications')}</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowLabel}>{t('settings.notifications')}</Text>
            <Text style={styles.comingSoon}>{t('settings.notificationsComingSoon')}</Text>
          </View>
          <Switch
            value={notificationsEnabled}
            onValueChange={setNotificationsEnabled}
            trackColor={{ false: '#D0D0D0', true: '#1A73E8' }}
            thumbColor='#FFFFFF'
          />
        </View>
      </View>

      <TouchableOpacity style={styles.logoutButton} onPress={() => { void handleLogout(); }} accessibilityRole='button'>
        <Text style={styles.logoutText}>{t('settings.logout')}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  contentContainer: {
    paddingBottom: 40,
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111111',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666666',
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ECECEC',
    overflow: 'hidden',
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  profileMain: {
    flex: 1,
  },
  profileName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111111',
  },
  profileEmail: {
    fontSize: 13,
    color: '#666666',
    marginTop: 2,
  },
  roleBadge: {
    backgroundColor: '#E8F0FE',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginLeft: 8,
  },
  roleBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1A73E8',
    textTransform: 'capitalize',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    minHeight: 52,
  },
  rowMain: {
    flex: 1,
  },
  rowLabel: {
    fontSize: 15,
    color: '#111111',
    fontWeight: '500',
  },
  rowValue: {
    fontSize: 14,
    color: '#666666',
    marginLeft: 8,
    flex: 1,
    textAlign: 'right',
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  languageChip: {
    backgroundColor: '#E8F0FE',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  languageChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1A73E8',
  },
  chevron: {
    fontSize: 20,
    color: '#666666',
    lineHeight: 22,
  },
  comingSoon: {
    fontSize: 12,
    color: '#666666',
    marginTop: 2,
  },
  logoutButton: {
    marginHorizontal: 12,
    marginTop: 28,
    backgroundColor: '#D93025',
    borderRadius: 10,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoutText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
