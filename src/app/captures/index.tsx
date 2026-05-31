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
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { formatMarketDateTime } from '../../market/profile';

type PendingCapture = {
  id: string;
  type: 'call' | 'sms' | 'email';
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
  const token = useUserStore((s) => s.token);

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
      case 'sms':
        return t('captures.sms');
      default:
        return type.toUpperCase();
    }
  }, [t]);

  const renderCapture = useCallback(
    ({ item }: ListRenderItemInfo<PendingCapture>): JSX.Element => {
      const busy = actionId === item.id;
      return (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.typeBadge}>
              <Text style={styles.typeBadgeText}>{typeLabel(item.type)}</Text>
            </View>
            <Text style={styles.phoneText}>
              {item.phone_number ?? t('captures.unknown')}
            </Text>
            <Text style={styles.timestampText}>{formatTimestamp(item.created_at)}</Text>
          </View>
          <View style={styles.cardActions}>
            <TouchableOpacity
              style={[styles.cardButton, styles.cardButtonPrimary, busy && styles.cardButtonDisabled]}
              onPress={() => { openMatchModal(item.id); }}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.cardButtonPrimaryText}>{t('captures.match')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.cardButton, styles.cardButtonSecondary, busy && styles.cardButtonDisabled]}
              onPress={() => { handleCreateContact(item.id, item.phone_number); }}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.cardButtonSecondaryText}>{t('captures.createContact')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.cardButton, styles.cardButtonDanger, busy && styles.cardButtonDisabled]}
              onPress={() => { void handleDismiss(item.id); }}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.cardButtonDangerText}>{t('captures.dismiss')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    },
    [actionId, t, typeLabel, openMatchModal, handleCreateContact, handleDismiss],
  );

  const renderContactResult = useCallback(
    ({ item }: ListRenderItemInfo<ContactResult>): JSX.Element => (
      <TouchableOpacity
        style={styles.contactRow}
        onPress={() => { void handleMatchToContact(item.id); }}
        accessibilityRole="button"
      >
        <View style={styles.contactRowMain}>
          <Text style={styles.contactRowName}>{contactDisplayName(item)}</Text>
          {item.phone ? (
            <Text style={styles.contactRowPhone}>{item.phone}</Text>
          ) : null}
        </View>
        <Text style={styles.selectLabel}>{t('captures.selectContact')}</Text>
      </TouchableOpacity>
    ),
    [handleMatchToContact, t],
  );

  const keyExtractorCapture = useCallback((item: PendingCapture): string => item.id, []);
  const keyExtractorContact = useCallback((item: ContactResult): string => item.id, []);

  const ListEmpty = useCallback((): JSX.Element | null => {
    if (isLoading) return null;
    return <Text style={styles.emptyText}>{t('captures.empty')}</Text>;
  }, [isLoading, t]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('captures.title') }} />

      {isLoading && captures.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#C4704F" />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => { void fetchCaptures(); }}
            accessibilityRole="button"
          >
            <Text style={styles.retryButtonText}>{t('common.retry')}</Text>
          </TouchableOpacity>
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
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t('captures.matchTitle')}</Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={closeMatchModal}
              accessibilityRole="button"
            >
              <Text style={styles.closeButtonText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>

          <TextInput
            style={styles.searchInput}
            value={contactSearch}
            onChangeText={handleSearchContacts}
            placeholder={t('captures.searchPlaceholder')}
            placeholderTextColor="#CFADA3"
            autoFocus
            returnKeyType="search"
          />

          {isSearching ? (
            <ActivityIndicator style={styles.searchSpinner} color="#C4704F" />
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FEF0E8',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  listContent: {
    padding: 12,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E8DDD6',
    marginBottom: 10,
    padding: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  typeBadge: {
    backgroundColor: '#FEF0E8',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typeBadgeText: {
    color: '#C4704F',
    fontSize: 12,
    fontWeight: '600',
  },
  phoneText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: '#383432',
  },
  timestampText: {
    fontSize: 12,
    color: '#CFADA3',
  },
  cardActions: {
    flexDirection: 'row',
    gap: 8,
  },
  cardButton: {
    flex: 1,
    minHeight: 36,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  cardButtonPrimary: {
    backgroundColor: '#C4704F',
  },
  cardButtonSecondary: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#C4704F',
  },
  cardButtonDanger: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  cardButtonDisabled: {
    opacity: 0.5,
  },
  cardButtonPrimaryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  cardButtonSecondaryText: {
    color: '#C4704F',
    fontSize: 13,
    fontWeight: '600',
  },
  cardButtonDangerText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '600',
  },
  emptyText: {
    color: '#CFADA3',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 24,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 12,
  },
  retryButton: {
    backgroundColor: '#C4704F',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  // Modal
  modalContainer: {
    flex: 1,
    backgroundColor: '#FEF0E8',
    paddingTop: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#383432',
  },
  closeButton: {
    padding: 8,
  },
  closeButtonText: {
    color: '#C4704F',
    fontSize: 15,
    fontWeight: '600',
  },
  searchInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: '#383432',
    marginBottom: 12,
  },
  searchSpinner: {
    marginTop: 24,
  },
  modalListContent: {
    paddingHorizontal: 12,
  },
  contactRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E8DDD6',
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  contactRowMain: {
    flex: 1,
    paddingRight: 12,
  },
  contactRowName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#383432',
  },
  contactRowPhone: {
    fontSize: 12,
    color: '#B07868',
    marginTop: 2,
  },
  selectLabel: {
    color: '#C4704F',
    fontSize: 13,
    fontWeight: '600',
  },
});
