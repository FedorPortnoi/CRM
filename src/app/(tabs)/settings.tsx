import React, { useState, useEffect } from 'react';
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Switch,
} from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { getStoredLanguage } from '../../i18n/storage';
import { API_URL } from '../../utils/api';
import { downloadAuthenticatedPdf } from '../../utils/exportFile';
import {
  getExpoPushProjectId,
  getNotificationPermissionSnapshot,
  registerDevicePushTokenDetailed,
} from '../../utils/notifications';

type ExportKind = 'contacts' | 'deals';

type ExportResult = {
  kind: ExportKind;
  uri: string;
};

export default function SettingsScreen(): JSX.Element {
  const { t, i18n } = useTranslation();
  const user = useUserStore((s) => s.user);
  const token = useUserStore((s) => s.token);
  const logout = useUserStore((s) => s.logout);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const [canAskNotifications, setCanAskNotifications] = useState<boolean>(true);
  const [isCheckingNotifications, setIsCheckingNotifications] = useState<boolean>(true);
  const [isRegisteringNotifications, setIsRegisteringNotifications] = useState<boolean>(false);
  const [currentLanguage, setCurrentLanguage] = useState<string>(i18n.language ?? 'en');
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [monthlyTarget, setMonthlyTarget] = useState<string>('');
  const [isSavingTarget, setIsSavingTarget] = useState(false);
  const [targetSaved, setTargetSaved] = useState(false);

  useEffect(() => {
    void getStoredLanguage().then((lang) => {
      if (lang !== null) {
        setCurrentLanguage(lang);
      }
    });
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadNotificationState = async (): Promise<void> => {
      setIsCheckingNotifications(true);
      try {
        const permission = await getNotificationPermissionSnapshot();
        if (!isMounted) return;

        const projectId = getExpoPushProjectId();
        setNotificationsEnabled(permission.granted);
        setCanAskNotifications(permission.canAskAgain);

        if (!token) {
          setNotificationMessage('Sign in to enable push notifications.');
        } else if (!projectId) {
          setNotificationMessage('Push notifications are not configured for this build.');
        } else if (permission.granted) {
          setNotificationMessage('Push notifications are enabled. Disable them in system settings.');
        } else if (!permission.canAskAgain) {
          setNotificationMessage('Notifications are blocked. Enable them in system settings.');
        } else {
          setNotificationMessage('Enable push reminders and CRM alerts.');
        }
      } catch {
        if (isMounted) {
          setNotificationsEnabled(false);
          setCanAskNotifications(false);
          setNotificationMessage('Notification permissions are unavailable on this device.');
        }
      } finally {
        if (isMounted) {
          setIsCheckingNotifications(false);
        }
      }
    };

    void loadNotificationState();

    return (): void => {
      isMounted = false;
    };
  }, [token]);

  useEffect(() => {
    if (!token || (user?.role !== 'owner' && user?.role !== 'admin')) return;
    void fetch(`${API_URL}/org`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then((json: { data: { settings: { monthly_revenue_target?: number } | null } } | null) => {
        const target = json?.data?.settings?.monthly_revenue_target;
        if (typeof target === 'number') setMonthlyTarget(String(target));
      })
      .catch(() => undefined);
  }, [token, user?.role]);

  const handleSaveTarget = async (): Promise<void> => {
    if (!token) return;
    const parsed = parseFloat(monthlyTarget.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    setIsSavingTarget(true);
    setTargetSaved(false);
    try {
      await fetch(`${API_URL}/org/settings`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthly_revenue_target: parsed }),
      });
      setTargetSaved(true);
    } finally {
      setIsSavingTarget(false);
    }
  };

  const handleLogout = async (): Promise<void> => {
    await logout();
    router.replace('/login');
  };

  const handleExport = async (kind: ExportKind): Promise<void> => {
    if (!token) {
      setExportError(t('errors.unauthorized'));
      return;
    }

    setExporting(kind);
    setExportError(null);
    setExportResult(null);

    try {
      const uri = await downloadAuthenticatedPdf({
        url: `${API_URL}/export/${kind}/pdf`,
        token,
        filename: `${kind}.pdf`,
      });
      setExportResult({ kind, uri });
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : t('errors.serverError'));
    } finally {
      setExporting(null);
    }
  };

  const handleOpenExport = async (): Promise<void> => {
    if (!exportResult) return;
    try {
      await Linking.openURL(exportResult.uri);
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : t('errors.serverError'));
    }
  };

  const handleNotificationsToggle = async (nextValue: boolean): Promise<void> => {
    if (!nextValue) {
      setNotificationMessage('Disable notifications in system settings.');
      return;
    }

    if (!token) {
      setNotificationMessage('Sign in to enable push notifications.');
      return;
    }

    setIsRegisteringNotifications(true);
    setNotificationMessage(null);

    try {
      const result = await registerDevicePushTokenDetailed(token);
      setNotificationsEnabled(result.ok);
      setNotificationMessage(result.message);
      if (!result.ok) {
        const permission = await getNotificationPermissionSnapshot().catch(() => null);
        if (permission) {
          setCanAskNotifications(permission.canAskAgain);
        }
      }
    } finally {
      setIsRegisteringNotifications(false);
    }
  };

  const languageLabel = currentLanguage === 'ru' ? 'RU' : 'EN';
  const savedExportLabel =
    exportResult?.kind === 'contacts' ? 'Contacts PDF saved' : 'Deals PDF saved';
  const notificationsDisabled =
    isCheckingNotifications ||
    isRegisteringNotifications ||
    !token ||
    !getExpoPushProjectId() ||
    notificationsEnabled ||
    !canAskNotifications;

  return (
    <View style={styles.wrapper}>
      <View style={styles.circle1} pointerEvents="none" />
      <View style={styles.circle2} pointerEvents="none" />
      <View style={styles.circle3} pointerEvents="none" />
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

      {(user?.role === 'owner' || user?.role === 'admin') && (
        <>
          <Text style={styles.sectionHeader}>Команда</Text>
          <TouchableOpacity style={styles.card} onPress={() => router.push('/settings/team' as never)} accessibilityRole="button">
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Структура команды</Text>
              <Text style={styles.chevron}>{'>'}</Text>
            </View>
          </TouchableOpacity>
        </>
      )}

      {(user?.role === 'owner' || user?.role === 'admin') && (
        <>
          <Text style={styles.sectionHeader}>{t('settings.salesPlan')}</Text>
          <View style={styles.card}>
            <View style={styles.targetRow}>
              <Text style={styles.rowLabel}>{t('settings.monthlyTarget')}</Text>
              {targetSaved && <Text style={styles.targetSavedText}>{t('settings.monthlyTargetSaved')}</Text>}
            </View>
            <View style={styles.targetInputRow}>
              <TextInput
                style={styles.targetInput}
                value={monthlyTarget}
                onChangeText={(v) => { setMonthlyTarget(v); setTargetSaved(false); }}
                keyboardType="numeric"
                placeholder={t('settings.monthlyTargetPlaceholder')}
                placeholderTextColor="#CFADA3"
                returnKeyType="done"
              />
              <TouchableOpacity
                style={[styles.targetSaveButton, isSavingTarget && styles.buttonDisabled]}
                onPress={() => { void handleSaveTarget(); }}
                disabled={isSavingTarget}
                accessibilityRole="button"
              >
                {isSavingTarget ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.targetSaveText}>{t('settings.save')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </>
      )}

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
            <Text style={styles.chevron}>{'>'}</Text>
          </View>
        </View>
      </TouchableOpacity>

      <Text style={styles.sectionHeader}>{t('settings.notifications')}</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowLabel}>{t('settings.notifications')}</Text>
            <Text style={styles.comingSoon}>
              {isRegisteringNotifications ? 'Registering device...' : notificationMessage}
            </Text>
          </View>
          <Switch
            value={notificationsEnabled}
            onValueChange={(value) => { void handleNotificationsToggle(value); }}
            disabled={notificationsDisabled}
            trackColor={{ false: '#E8DDD6', true: '#C45A10' }}
            thumbColor='#FFFFFF'
          />
        </View>
        {!canAskNotifications ? (
          <TouchableOpacity
            style={styles.notificationSettingsButton}
            onPress={() => { void Linking.openSettings(); }}
            accessibilityRole="button"
          >
            <Text style={styles.notificationSettingsText}>Open notification settings</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <Text style={styles.sectionHeader}>Data export</Text>
      <View style={styles.card}>
        <View style={styles.exportIntro}>
          <Text style={styles.rowLabel}>PDF exports</Text>
          <Text style={styles.helperText}>Download current contacts or deals as a PDF report.</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.exportActions}>
          <TouchableOpacity
            style={[styles.exportButton, exporting !== null && styles.buttonDisabled]}
            onPress={() => { void handleExport('contacts'); }}
            disabled={exporting !== null}
            accessibilityRole="button"
          >
            {exporting === 'contacts' ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.exportButtonText}>Export contacts</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.exportButton, exporting !== null && styles.buttonDisabled]}
            onPress={() => { void handleExport('deals'); }}
            disabled={exporting !== null}
            accessibilityRole="button"
          >
            {exporting === 'deals' ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.exportButtonText}>Export deals</Text>
            )}
          </TouchableOpacity>
        </View>
        {exporting ? (
          <Text style={styles.progressText}>Preparing {exporting} PDF...</Text>
        ) : null}
        {exportResult ? (
          <View style={styles.exportResult}>
            <View style={styles.rowMain}>
              <Text style={styles.successText}>{savedExportLabel}</Text>
              <Text style={styles.savedPath} numberOfLines={1}>{exportResult.uri}</Text>
            </View>
            <TouchableOpacity
              style={styles.openButton}
              onPress={() => { void handleOpenExport(); }}
              accessibilityRole="button"
            >
              <Text style={styles.openButtonText}>Open</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {exportError ? <Text style={styles.errorText}>{exportError}</Text> : null}
      </View>

      <TouchableOpacity style={styles.logoutButton} onPress={() => { void handleLogout(); }} accessibilityRole='button'>
        <Text style={styles.logoutText}>{t('settings.logout')}</Text>
      </TouchableOpacity>
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  circle1: {
    position: 'absolute',
    width: 350,
    height: 350,
    borderRadius: 175,
    backgroundColor: 'rgba(6,95,70,0.04)',
    top: -80,
    right: -100,
  },
  circle2: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: 'rgba(6,95,70,0.03)',
    bottom: 100,
    left: -80,
  },
  circle3: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(6,95,70,0.03)',
    top: '40%',
    right: -60,
  },
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  contentContainer: {
    paddingBottom: 40,
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#383432',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: '#B07868',
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E8DDD6',
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
    color: '#383432',
  },
  profileEmail: {
    fontSize: 13,
    color: '#B07868',
    marginTop: 2,
  },
  roleBadge: {
    backgroundColor: '#f0fdf4',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginLeft: 8,
  },
  roleBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#C45A10',
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
    color: '#383432',
    fontWeight: '500',
  },
  rowValue: {
    fontSize: 14,
    color: '#B07868',
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
    backgroundColor: '#f0fdf4',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  languageChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#C45A10',
  },
  chevron: {
    fontSize: 20,
    color: '#CFADA3',
    lineHeight: 22,
  },
  comingSoon: {
    fontSize: 12,
    color: '#CFADA3',
    marginTop: 2,
  },
  notificationSettingsButton: {
    alignSelf: 'flex-start',
    marginHorizontal: 14,
    marginBottom: 12,
    minHeight: 34,
    justifyContent: 'center',
  },
  notificationSettingsText: {
    color: '#C45A10',
    fontSize: 13,
    fontWeight: '700',
  },
  exportIntro: {
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 12,
  },
  helperText: {
    fontSize: 12,
    color: '#B07868',
    marginTop: 4,
    lineHeight: 17,
  },
  divider: {
    height: 1,
    backgroundColor: '#FAF6F3',
  },
  exportActions: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 10,
  },
  exportButton: {
    flex: 1,
    backgroundColor: '#C45A10',
    borderRadius: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  exportButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  buttonDisabled: {
    opacity: 0.65,
  },
  progressText: {
    fontSize: 12,
    color: '#B07868',
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  exportResult: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 14,
    marginBottom: 12,
    padding: 10,
    borderRadius: 10,
    backgroundColor: '#f0fdf4',
  },
  successText: {
    fontSize: 13,
    color: '#C45A10',
    fontWeight: '700',
  },
  savedPath: {
    fontSize: 11,
    color: '#B07868',
    marginTop: 2,
  },
  openButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C45A10',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  openButtonText: {
    color: '#C45A10',
    fontSize: 12,
    fontWeight: '700',
  },
  errorText: {
    fontSize: 12,
    color: '#ef4444',
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  logoutButton: {
    marginHorizontal: 12,
    marginTop: 28,
    backgroundColor: '#ef4444',
    borderRadius: 12,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoutText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  targetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 8,
  },
  targetSavedText: {
    fontSize: 12,
    color: '#16a34a',
    fontWeight: '600',
  },
  targetInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  targetInput: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#E8DDD6',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#383432',
    backgroundColor: '#FAFAF9',
  },
  targetSaveButton: {
    backgroundColor: '#C45A10',
    borderRadius: 10,
    minHeight: 44,
    minWidth: 80,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  targetSaveText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});
