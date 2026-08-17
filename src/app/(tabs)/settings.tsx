import React, { useState, useEffect } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
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
import { useThemeStore } from '../../store/themeStore';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';
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
  const setStaySignedIn = useUserStore((s) => s.setStaySignedIn);
  const disableTotp = useUserStore((s) => s.disableTotp);
  const regenerateBackupCodes = useUserStore((s) => s.regenerateBackupCodes);
  const isDark = useThemeStore((s) => s.theme) === 'dark';
  const toggleTheme = useThemeStore((s) => s.toggle);
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const [canAskNotifications, setCanAskNotifications] = useState<boolean>(true);
  const [isCheckingNotifications, setIsCheckingNotifications] = useState<boolean>(true);
  const [isRegisteringNotifications, setIsRegisteringNotifications] = useState<boolean>(false);
  const [currentLanguage, setCurrentLanguage] = useState<string>(i18n.language ?? 'en');
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [isSavingStaySignedIn, setIsSavingStaySignedIn] = useState(false);
  const [staySignedInError, setStaySignedInError] = useState<string | null>(null);
  const [twoFactorAction, setTwoFactorAction] = useState<'disable' | 'regenerate' | null>(null);
  const [twoFactorPassword, setTwoFactorPassword] = useState('');
  const [isTwoFactorSaving, setIsTwoFactorSaving] = useState(false);
  const [twoFactorError, setTwoFactorError] = useState<string | null>(null);
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);
  const [monthlyTarget, setMonthlyTarget] = useState<string>('');
  const [isSavingTarget, setIsSavingTarget] = useState(false);
  const [targetSaved, setTargetSaved] = useState(false);
  const [orgName, setOrgName] = useState<string>('');

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
          setNotificationMessage(t('settings.notifSignIn'));
        } else if (!projectId) {
          setNotificationMessage(t('settings.notifNotConfigured'));
        } else if (permission.granted) {
          setNotificationMessage(t('settings.notifEnabled'));
        } else if (!permission.canAskAgain) {
          setNotificationMessage(t('settings.notifBlocked'));
        } else {
          setNotificationMessage(t('settings.notifEnable'));
        }
      } catch {
        if (isMounted) {
          setNotificationsEnabled(false);
          setCanAskNotifications(false);
          setNotificationMessage(t('settings.notifUnavailable'));
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
    if (!token) return;
    void fetch(`${API_URL}/org`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then((json: { data: { name?: string; settings: { monthly_revenue_target?: number } | null } } | null) => {
        if (json?.data?.name) setOrgName(json.data.name);
        const target = json?.data?.settings?.monthly_revenue_target;
        if (typeof target === 'number') setMonthlyTarget(String(target));
      })
      .catch(() => undefined);
  }, [token]);

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
    // The full teardown — offline queue and its SecureStore bodies, the react-query cache and
    // the delta-sync watermark — lives inside userStore.logout() rather than here, so that
    // every exit path gets it (this button, the 401 handler in useCreateMutation, anything
    // added later) instead of only the one screen that remembered to do it.
    //
    // Navigation is in `finally`: if any teardown step throws, leaving the user parked on an
    // authenticated screen is strictly worse than sending them to /login with a session that
    // was cleared credentials-first.
    try {
      await logout();
    } finally {
      router.replace('/login');
    }
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

  const handleStaySignedInToggle = async (nextValue: boolean): Promise<void> => {
    setIsSavingStaySignedIn(true);
    setStaySignedInError(null);
    try {
      await setStaySignedIn(nextValue);
    } catch (e: unknown) {
      setStaySignedInError(e instanceof Error ? e.message : t('settings.staySignedInSaveFailed'));
    } finally {
      setIsSavingStaySignedIn(false);
    }
  };

  // Disabling 2FA or rotating backup codes both need a fresh password, not
  // just an active session — either action is a real security regression if
  // a phone left unlocked on a desk could do it with a tap. Both re-auths
  // land here rather than on two near-duplicate inline forms.
  const openTwoFactorAction = (action: 'disable' | 'regenerate'): void => {
    setTwoFactorAction(action);
    setTwoFactorPassword('');
    setTwoFactorError(null);
    setNewBackupCodes(null);
  };

  const cancelTwoFactorAction = (): void => {
    setTwoFactorAction(null);
    setTwoFactorPassword('');
    setTwoFactorError(null);
  };

  const submitTwoFactorAction = async (): Promise<void> => {
    if (twoFactorAction === null || !twoFactorPassword) return;
    setIsTwoFactorSaving(true);
    setTwoFactorError(null);
    try {
      if (twoFactorAction === 'disable') {
        await disableTotp(twoFactorPassword);
        setTwoFactorAction(null);
        setTwoFactorPassword('');
      } else {
        const result = await regenerateBackupCodes(twoFactorPassword);
        setNewBackupCodes(result.backupCodes);
        setTwoFactorAction(null);
        setTwoFactorPassword('');
      }
    } catch (e: unknown) {
      setTwoFactorError(
        e instanceof Error
          ? e.message
          : t(twoFactorAction === 'disable' ? 'settings.twoFactorDisableFailed' : 'settings.twoFactorRegenerateFailed'),
      );
    } finally {
      setIsTwoFactorSaving(false);
    }
  };

  const languageLabel = currentLanguage === 'ru' ? 'RU' : 'EN';
  const savedExportLabel =
    exportResult?.kind === 'contacts' ? t('settings.exportContactsSaved') : t('settings.exportDealsSaved');
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

      <Text style={styles.sectionHeader}>{t('settings.appearance') ?? 'Внешний вид'}</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{t('settings.darkTheme')}</Text>
          <Switch
            value={isDark}
            onValueChange={toggleTheme}
            trackColor={{ false: '#E8DDD6', true: '#CC785C' }}
            thumbColor={isDark ? '#EBDBBC' : '#FFFFFF'}
          />
        </View>
      </View>

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
      <TouchableOpacity
        style={styles.card}
        onPress={() => router.push('/settings/timezone' as never)}
        accessibilityRole="button"
      >
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowLabel}>{t('settings.timezone')}</Text>
            <Text style={styles.comingSoon}>{t('settings.timezoneEntryDesc')}</Text>
          </View>
          <Text style={styles.chevron}>{'>'}</Text>
        </View>
      </TouchableOpacity>

      <Text style={styles.sectionHeader}>{t('settings.organisation')}</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{t('auth.organization')}</Text>
          <Text style={styles.rowValue}>{orgName || (user?.org_id?.slice(0, 8) ?? '')}</Text>
        </View>
      </View>

      {(user?.role === 'owner' || user?.role === 'admin') && (
        <>
          <Text style={styles.sectionHeader}>{t('settings.team')}</Text>
          {/*
            Route stays /settings/team — the Создать sheet and the ?add=1 deep
            link both point at it. Only the wording changes: «Структура команды»
            read as an org-chart viewer, so nobody found the screen that actually
            hands out logins.
          */}
          <TouchableOpacity style={styles.card} onPress={() => router.push('/settings/team' as never)} accessibilityRole="button">
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowLabel}>
                  {t('settings.teamMembers')}
                </Text>
                <Text style={styles.comingSoon}>
                  {t('settings.teamMembersDesc')}
                </Text>
              </View>
              <Text style={styles.chevron}>{'>'}</Text>
            </View>
          </TouchableOpacity>
        </>
      )}

      {(user?.role === 'owner' || user?.role === 'admin') && (
        <>
          <Text style={styles.sectionHeader}>{t('pipelines.sectionHeader')}</Text>
          {/*
            Sits next to «Планирование продаж» rather than under «Интеграции»: the funnel is
            what the plan is measured against, not a connector.
          */}
          <TouchableOpacity
            style={styles.card}
            onPress={() => router.push('/settings/pipelines' as never)}
            accessibilityRole="button"
          >
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowLabel}>{t('pipelines.settingsEntry')}</Text>
                <Text style={styles.comingSoon}>{t('pipelines.settingsEntryDesc')}</Text>
              </View>
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
                placeholderTextColor={colors.placeholder}
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

      {(user?.role === 'owner' || user?.role === 'admin') && (
        <>
          <Text style={styles.sectionHeader}>{t('settings.marketing')}</Text>
          <View style={styles.card}>
            <TouchableOpacity
              onPress={() => router.push('/sequences' as never)}
              accessibilityRole="button"
            >
              <View style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowLabel}>{t('sequences.title')}</Text>
                  <Text style={styles.comingSoon}>{t('sequences.subtitle')}</Text>
                </View>
                <Text style={styles.chevron}>{'>'}</Text>
              </View>
            </TouchableOpacity>
            <View style={styles.divider} />
            <TouchableOpacity
              onPress={() => router.push('/templates' as never)}
              accessibilityRole="button"
            >
              <View style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowLabel}>{t('templates.title')}</Text>
                  <Text style={styles.comingSoon}>{t('templates.subtitle')}</Text>
                </View>
                <Text style={styles.chevron}>{'>'}</Text>
              </View>
            </TouchableOpacity>
          </View>
        </>
      )}

      {(user?.role === 'owner' || user?.role === 'admin') && (
        <>
          <Text style={styles.sectionHeader}>{t('settings.integrations')}</Text>
          <View style={styles.card}>
            <TouchableOpacity
              onPress={() => router.push('/settings/amocrm' as never)}
              accessibilityRole="button"
            >
              <View style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowLabel}>{t('settings.amocrm')}</Text>
                  <Text style={styles.comingSoon}>{t('settings.amocrmDesc')}</Text>
                </View>
                <Text style={styles.chevron}>{'>'}</Text>
              </View>
            </TouchableOpacity>
            <View style={styles.divider} />
            <TouchableOpacity
              onPress={() => router.push('/settings/lead-inbox' as never)}
              accessibilityRole="button"
            >
              <View style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowLabel}>{t('settings.leadInbox')}</Text>
                  <Text style={styles.comingSoon}>{t('settings.leadInboxDesc')}</Text>
                </View>
                <Text style={styles.chevron}>{'>'}</Text>
              </View>
            </TouchableOpacity>
            <View style={styles.divider} />
            <TouchableOpacity
              onPress={() => router.push('/settings/api-keys' as never)}
              accessibilityRole="button"
            >
              <View style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowLabel}>{t('settings.apiKeys')}</Text>
                  <Text style={styles.comingSoon}>{t('settings.apiKeysDesc')}</Text>
                </View>
                <Text style={styles.chevron}>{'>'}</Text>
              </View>
            </TouchableOpacity>
            <View style={styles.divider} />
            <TouchableOpacity
              onPress={() => router.push('/settings/webhooks' as never)}
              accessibilityRole="button"
            >
              <View style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowLabel}>{t('settings.webhooks')}</Text>
                  <Text style={styles.comingSoon}>{t('settings.webhooksDesc')}</Text>
                </View>
                <Text style={styles.chevron}>{'>'}</Text>
              </View>
            </TouchableOpacity>
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
              {isRegisteringNotifications ? t('settings.notifRegistering') : notificationMessage}
            </Text>
          </View>
          <Switch
            value={notificationsEnabled}
            onValueChange={(value) => { void handleNotificationsToggle(value); }}
            disabled={notificationsDisabled}
            trackColor={{ false: 'rgba(232,224,212,0.08)', true: '#CC785C' }}
            thumbColor='#FFFFFF'
          />
        </View>
        {!canAskNotifications ? (
          <TouchableOpacity
            style={styles.notificationSettingsButton}
            onPress={() => { void Linking.openSettings(); }}
            accessibilityRole="button"
          >
            <Text style={styles.notificationSettingsText}>{t('settings.notifOpenSettings')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <Text style={styles.sectionHeader}>{t('settings.dataExport')}</Text>
      <View style={styles.card}>
        <View style={styles.exportIntro}>
          <Text style={styles.rowLabel}>{t('settings.pdfExports')}</Text>
          <Text style={styles.helperText}>{t('settings.pdfExportDesc')}</Text>
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
              <Text style={styles.exportButtonText}>{t('settings.exportContacts')}</Text>
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
              <Text style={styles.exportButtonText}>{t('settings.exportDeals')}</Text>
            )}
          </TouchableOpacity>
        </View>
        {exporting ? (
          <Text style={styles.progressText}>
            {exporting === 'contacts' ? t('settings.exportContactsPreparing') : t('settings.exportDealsPreparing')}
          </Text>
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
              <Text style={styles.openButtonText}>{t('settings.exportOpen')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {exportError ? <Text style={styles.errorText}>{exportError}</Text> : null}
      </View>

      <Text style={styles.sectionHeader}>{t('settings.security')}</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowLabel}>{t('settings.staySignedIn')}</Text>
            <Text style={styles.helperText}>{t('settings.staySignedInDesc')}</Text>
          </View>
          <Switch
            value={user?.stay_signed_in ?? false}
            onValueChange={(value) => { void handleStaySignedInToggle(value); }}
            disabled={isSavingStaySignedIn}
            trackColor={{ false: 'rgba(232,224,212,0.08)', true: '#CC785C' }}
            thumbColor='#FFFFFF'
          />
        </View>
        {staySignedInError !== null ? <Text style={styles.errorText}>{staySignedInError}</Text> : null}

        <View style={styles.divider} />
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowLabel}>{t('settings.twoFactor')}</Text>
            <Text style={styles.helperText}>
              {user?.totp_enabled ? t('settings.twoFactorEnabledDesc') : t('settings.twoFactorDesc')}
            </Text>
          </View>
          {user?.totp_enabled ? (
            <View style={styles.twoFactorBadge}>
              <Text style={styles.twoFactorBadgeText}>{t('settings.twoFactorEnabled')}</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.twoFactorSetupButton}
              onPress={() => router.push('/2fa-setup' as never)}
              accessibilityRole="button"
            >
              <Text style={styles.twoFactorSetupButtonText}>{t('settings.twoFactorSetup')}</Text>
            </TouchableOpacity>
          )}
        </View>

        {user?.totp_enabled ? (
          <View style={styles.twoFactorActionsRow}>
            <TouchableOpacity
              style={styles.twoFactorActionButton}
              onPress={() => openTwoFactorAction('disable')}
              accessibilityRole="button"
            >
              <Text style={styles.twoFactorActionButtonText}>{t('settings.twoFactorDisable')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.twoFactorActionButtonSecondary}
              onPress={() => openTwoFactorAction('regenerate')}
              accessibilityRole="button"
            >
              <Text style={styles.twoFactorActionButtonSecondaryText}>{t('settings.twoFactorRegenerate')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {twoFactorAction !== null ? (
          <View style={styles.twoFactorPanel}>
            <TextInput
              style={styles.twoFactorPasswordInput}
              secureTextEntry
              value={twoFactorPassword}
              onChangeText={(v) => { setTwoFactorPassword(v); setTwoFactorError(null); }}
              placeholder={t('settings.twoFactorPasswordPlaceholder')}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoComplete="current-password"
              accessibilityLabel={t('settings.twoFactorPasswordPlaceholder')}
            />
            <View style={styles.twoFactorPanelActions}>
              <TouchableOpacity
                style={styles.twoFactorCancelButton}
                onPress={cancelTwoFactorAction}
                accessibilityRole="button"
              >
                <Text style={styles.twoFactorCancelButtonText}>{t('settings.twoFactorCancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.twoFactorConfirmButton, (isTwoFactorSaving || !twoFactorPassword) && styles.buttonDisabled]}
                onPress={() => { void submitTwoFactorAction(); }}
                disabled={isTwoFactorSaving || !twoFactorPassword}
                accessibilityRole="button"
              >
                {isTwoFactorSaving ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.twoFactorConfirmButtonText}>{t('settings.twoFactorConfirm')}</Text>
                )}
              </TouchableOpacity>
            </View>
            {twoFactorError !== null ? <Text style={styles.errorText}>{twoFactorError}</Text> : null}
          </View>
        ) : null}

        {newBackupCodes !== null ? (
          <View style={styles.twoFactorPanel}>
            <Text style={styles.rowLabel}>{t('settings.twoFactorNewCodesTitle')}</Text>
            <Text style={styles.helperText}>{t('settings.twoFactorBackupCodesWarning')}</Text>
            <View style={styles.codesList}>
              {newBackupCodes.map((backupCode) => (
                <Text key={backupCode} style={styles.codeItem} selectable>{backupCode}</Text>
              ))}
            </View>
            <TouchableOpacity
              style={styles.twoFactorConfirmButton}
              onPress={() => setNewBackupCodes(null)}
              accessibilityRole="button"
            >
              <Text style={styles.twoFactorConfirmButtonText}>{t('settings.twoFactorSavedButton')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      <TouchableOpacity style={styles.logoutButton} onPress={() => { void handleLogout(); }} accessibilityRole='button'>
        <Text style={styles.logoutText}>{t('settings.logout')}</Text>
      </TouchableOpacity>
    </ScrollView>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: c.bg,
  },
  circle1: {
    position: 'absolute',
    width: 350,
    height: 350,
    borderRadius: 175,
    backgroundColor: c.skeleton,
    top: -80,
    right: -100,
  },
  circle2: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: c.skeleton,
    bottom: 100,
    left: -80,
  },
  circle3: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: c.skeleton,
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
    color: c.text1,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: c.amber,
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: c.bgPanel,
    marginHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
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
    color: c.text1,
  },
  profileEmail: {
    fontSize: 13,
    color: c.amber,
    marginTop: 2,
  },
  roleBadge: {
    backgroundColor: 'rgba(204,120,92,0.08)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginLeft: 8,
  },
  roleBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: c.orange,
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
    color: c.text1,
    fontWeight: '500',
  },
  rowValue: {
    fontSize: 14,
    color: c.amber,
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
    backgroundColor: 'rgba(204,120,92,0.08)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  languageChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: c.orange,
  },
  chevron: {
    fontSize: 20,
    color: c.textMuted,
    lineHeight: 22,
  },
  comingSoon: {
    fontSize: 12,
    color: c.textMuted,
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
    color: c.orange,
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
    color: c.amber,
    marginTop: 4,
    lineHeight: 17,
  },
  divider: {
    height: 1,
    backgroundColor: c.border,
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
    backgroundColor: c.orange,
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
    color: c.amber,
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
    backgroundColor: 'rgba(204,120,92,0.08)',
  },
  successText: {
    fontSize: 13,
    color: c.orange,
    fontWeight: '700',
  },
  savedPath: {
    fontSize: 11,
    color: c.amber,
    marginTop: 2,
  },
  openButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.orange,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  openButtonText: {
    color: c.orange,
    fontSize: 12,
    fontWeight: '700',
  },
  errorText: {
    fontSize: 12,
    color: c.red,
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  logoutButton: {
    marginHorizontal: 12,
    marginTop: 28,
    backgroundColor: c.red,
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
    color: c.wheat,
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
    borderColor: c.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: c.text1,
    backgroundColor: c.inputBg,
  },
  targetSaveButton: {
    backgroundColor: c.orange,
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
  twoFactorBadge: {
    backgroundColor: 'rgba(204,120,92,0.08)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  twoFactorBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: c.orange,
  },
  twoFactorSetupButton: {
    backgroundColor: c.orange,
    borderRadius: 8,
    minHeight: 36,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  twoFactorSetupButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  twoFactorActionsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  twoFactorActionButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.red,
  },
  twoFactorActionButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  twoFactorActionButtonSecondary: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.orange,
  },
  twoFactorActionButtonSecondaryText: {
    color: c.orange,
    fontSize: 13,
    fontWeight: '700',
  },
  twoFactorPanel: {
    marginHorizontal: 14,
    marginBottom: 14,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.inputBg,
    gap: 10,
  },
  twoFactorPasswordInput: {
    borderWidth: 1.5,
    borderColor: c.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: c.text1,
    backgroundColor: c.bg,
  },
  twoFactorPanelActions: {
    flexDirection: 'row',
    gap: 10,
  },
  twoFactorCancelButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  twoFactorCancelButtonText: {
    color: c.text1,
    fontSize: 13,
    fontWeight: '600',
  },
  twoFactorConfirmButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.orange,
  },
  twoFactorConfirmButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  codesList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  codeItem: {
    width: '47%',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    color: c.text1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: c.bg,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 6,
    paddingVertical: 8,
  },
});
