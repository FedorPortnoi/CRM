import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { formatMarketDateTime } from '../../market/profile';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { Card, Button, Badge, EmptyState, Skeleton } from '../../components/ui';

type PendingCapture = {
  id: string;
  type: 'call' | 'email';
  phone_number: string | null;
  status: 'pending' | 'matched' | 'dismissed';
  contact_id: string | null;
  created_at: string;
  contact: { id: string; first_name: string; last_name: string | null; phone: string | null } | null;
};

type ContactResult = {
  id: string;
  first_name: string;
  last_name: string | null;
  phone: string | null;
};

function formatTimestamp(iso: string): string {
  return formatMarketDateTime(iso, {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  });
}

function contactDisplayName(c: ContactResult): string {
  return [c.first_name, c.last_name].filter(Boolean).join(' ');
}

export default function CapturesScreen(): JSX.Element {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const token = useUserStore((s) => s.token);
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const [captures, setCaptures] = useState<PendingCapture[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);

  const [matchModalVisible, setMatchModalVisible] = useState<boolean>(false);
  const [matchTargetId, setMatchTargetId] = useState<string | null>(null);
  const [contactSearch, setContactSearch] = useState<string>('');
  const [contactResults, setContactResults] = useState<ContactResult[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);

  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchCaptures = useCallback(async (): Promise<void> => {
    if (!token) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/captures?status=pending`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Captures failed with status ${res.status}`);
      const json = (await res.json()) as { data: PendingCapture[]; meta: { total: number } };
      setCaptures(json.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('errors.failedToLoadCaptures'));
    } finally {
      setIsLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void fetchCaptures();
  }, [fetchCaptures]);

  const handleDismiss = useCallback(
    async (captureId: string): Promise<void> => {
      if (!token) return;
      setActionId(captureId);
      try {
        const res = await fetch(`${API_URL}/captures/${captureId}/dismiss`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Dismiss failed with status ${res.status}`);
        setCaptures((prev) => prev.filter((c) => c.id !== captureId));
      } catch {
        // silently fail — list stays unchanged
      } finally {
        setActionId(null);
      }
    },
    [token],
  );

  const handleCreateContact = useCallback(
    (captureId: string, phone: string | null): void => {
      const params: { capture_id: string; phone?: string } = { capture_id: captureId };
      const trimmedPhone = phone?.trim();
      if (trimmedPhone) params.phone = trimmedPhone;

      router.push({ pathname: '/contact/new', params });
    },
    [],
  );

  const openMatchModal = useCallback((captureId: string): void => {
    setMatchTargetId(captureId);
    setContactSearch('');
    setContactResults([]);
    setMatchModalVisible(true);
  }, []);

  const closeMatchModal = useCallback((): void => {
    setMatchModalVisible(false);
    setMatchTargetId(null);
    setContactSearch('');
    setContactResults([]);
  }, []);

  const handleSearchContacts = useCallback(
    (query: string): void => {
      setContactSearch(query);
      if (searchTimeoutRef.current !== null) {
        clearTimeout(searchTimeoutRef.current);
      }
      if (!query.trim()) {
        setContactResults([]);
        return;
      }
      searchTimeoutRef.current = setTimeout(() => {
        if (!token) return;
        setIsSearching(true);
        void fetch(`${API_URL}/contacts?q=${encodeURIComponent(query.trim())}&per_page=10`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((res) => {
            if (!res.ok) return Promise.reject(new Error('Search failed'));
            return res.json() as Promise<{ data: ContactResult[] }>;
          })
          .then((json) => {
            setContactResults(json.data);
          })
          .catch(() => {
            // silently fail search
          })
          .finally(() => {
            setIsSearching(false);
          });
      }, 300);
    },
    [token],
  );

  const handleMatchToContact = useCallback(
    async (contactId: string): Promise<void> => {
      if (!token || !matchTargetId) return;
      setActionId(matchTargetId);
      try {
        const res = await fetch(`${API_URL}/captures/${matchTargetId}/match`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ contact_id: contactId }),
        });
        if (!res.ok) throw new Error(`Match failed with status ${res.status}`);
        closeMatchModal();
        await fetchCaptures();
      } catch {
        // silently fail — modal stays open so user can retry
      } finally {
        setActionId(null);
      }
    },
    [token, matchTargetId, closeMatchModal, fetchCaptures],
  );

  const typeLabel = useCallback((type: PendingCapture['type']): string => {
    switch (type) {
      case 'call':
        return t('captures.call');
      default:
        return type.toUpperCase();
    }
  }, [t]);

  const renderCapture = useCallback(
    ({ item }: ListRenderItemInfo<PendingCapture>): JSX.Element => {
      const busy = actionId === item.id;
      return (
        <Card style={styles.cardSpacing}>
          <View style={styles.cardHeader}>
            <Badge label={typeLabel(item.type)} variant="neutral" />
            <Text style={[styles.phoneText, styles.tabular]}>
              {item.phone_number ?? t('captures.unknown')}
            </Text>
            <Text style={[styles.timestampText, styles.tabular]}>{formatTimestamp(item.created_at)}</Text>
          </View>
          <View style={styles.cardActions}>
            <Button
              title={t('captures.match')}
              onPress={() => { openMatchModal(item.id); }}
              disabled={busy}
              size="sm"
              style={styles.cardButton}
            />
            <Button
              title={t('captures.createContact')}
              onPress={() => { handleCreateContact(item.id, item.phone_number); }}
              disabled={busy}
              size="sm"
              variant="secondary"
              style={styles.cardButton}
            />
            <Button
              title={t('captures.dismiss')}
              onPress={() => { void handleDismiss(item.id); }}
              disabled={busy}
              size="sm"
              variant="danger"
              style={styles.cardButton}
            />
          </View>
        </Card>
      );
    },
    [actionId, t, typeLabel, openMatchModal, handleCreateContact, handleDismiss, styles],
  );

  const renderContactResult = useCallback(
    ({ item }: ListRenderItemInfo<ContactResult>): JSX.Element => (
      <Card
        onPress={() => { void handleMatchToContact(item.id); }}
        style={styles.contactRow}
      >
        <View style={styles.contactRowInner}>
          <View style={styles.contactRowMain}>
            <Text style={styles.contactRowName}>{contactDisplayName(item)}</Text>
            {item.phone ? (
              <Text style={[styles.contactRowPhone, styles.tabular]}>{item.phone}</Text>
            ) : null}
          </View>
          <Text style={styles.selectLabel}>{t('captures.selectContact')}</Text>
        </View>
      </Card>
    ),
    [handleMatchToContact, t, styles],
  );

  const keyExtractorCapture = useCallback((item: PendingCapture): string => item.id, []);
  const keyExtractorContact = useCallback((item: ContactResult): string => item.id, []);

  const ListEmpty = useCallback((): JSX.Element | null => {
    if (isLoading) return null;
    return <EmptyState title={t('captures.empty')} />;
  }, [isLoading, t]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('captures.title') }} />

      {isLoading && captures.length === 0 ? (
        <View style={styles.listContent}>
          <Skeleton height={92} rounded={radius.lg} style={styles.skeletonGap} />
          <Skeleton height={92} rounded={radius.lg} style={styles.skeletonGap} />
          <Skeleton height={92} rounded={radius.lg} style={styles.skeletonGap} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <EmptyState
            title={error}
            actionLabel={t('common.retry')}
            onAction={() => { void fetchCaptures(); }}
          />
        </View>
      ) : (
        <FlatList
          data={captures}
          keyExtractor={keyExtractorCapture}
          renderItem={renderCapture}
          ListEmptyComponent={ListEmpty}
          contentContainerStyle={styles.listContent}
        />
      )}

      <Modal
        visible={matchModalVisible}
        animationType="slide"
        onRequestClose={closeMatchModal}
      >
        <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t('captures.matchTitle')}</Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={closeMatchModal}
              accessibilityRole="button"
              activeOpacity={0.7}
            >
              <Text style={styles.closeButtonText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>

          <TextInput
            style={styles.searchInput}
            value={contactSearch}
            onChangeText={handleSearchContacts}
            placeholder={t('captures.searchPlaceholder')}
            placeholderTextColor={colors.placeholder}
            autoFocus
            returnKeyType="search"
          />

          {isSearching ? (
            <ActivityIndicator style={styles.searchSpinner} color={colors.accent} />
          ) : (
            <FlatList
              data={contactResults}
              keyExtractor={keyExtractorContact}
              renderItem={renderContactResult}
              contentContainerStyle={styles.modalListContent}
              keyboardShouldPersistTaps="handled"
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  listContent: {
    padding: spacing.md,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  skeletonGap: {
    marginBottom: spacing.sm,
  },
  cardSpacing: {
    marginBottom: spacing.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    flexWrap: 'wrap',
  },
  phoneText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: c.text1,
  },
  timestampText: {
    ...type.caption,
    color: c.textMuted,
  },
  cardActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  cardButton: {
    flex: 1,
  },
  // Modal
  modalContainer: {
    flex: 1,
    backgroundColor: c.bg,
    paddingTop: spacing.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  modalTitle: {
    ...type.subtitle,
    color: c.text1,
  },
  closeButton: {
    padding: spacing.sm,
  },
  closeButtonText: {
    color: c.accent,
    fontSize: 16,
    fontWeight: '600',
  },
  searchInput: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 16,
    color: c.text1,
    marginBottom: spacing.md,
  },
  searchSpinner: {
    marginTop: spacing.xl,
  },
  modalListContent: {
    paddingHorizontal: spacing.md,
  },
  contactRow: {
    marginBottom: spacing.sm,
  },
  contactRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  contactRowMain: {
    flex: 1,
    paddingRight: spacing.md,
  },
  contactRowName: {
    fontSize: 16,
    fontWeight: '600',
    color: c.text1,
  },
  contactRowPhone: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 2,
  },
  selectLabel: {
    color: c.accent,
    fontSize: 13,
    fontWeight: '600',
  },
});
