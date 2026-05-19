import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ListRenderItemInfo,
  Alert,
  Modal,
  RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { Check, Search } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { sendOrQueueMutation } from '../../utils/offlineMutation';

type Contact = {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  status: string;
};

type OrgUser = {
  id: string;
  email: string;
  name: string;
  role: string;
};

type OrgUsersResponse = {
  data: OrgUser[];
  meta: {
    total: number;
  };
};

const PER_PAGE = 20;

const AVATAR_COLORS = ['#065f46', '#6366f1', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9'];

function getInitials(firstName: string, lastName: string | null): string {
  const f = firstName.charAt(0).toUpperCase();
  const l = lastName ? lastName.charAt(0).toUpperCase() : '';
  return f + l;
}

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function ContactsScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [isArchiving, setIsArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [isAssignModalVisible, setIsAssignModalVisible] = useState(false);
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [isAssigning, setIsAssigning] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  const selectedContactIdSet = useMemo(
    () => new Set(selectedContactIds),
    [selectedContactIds],
  );
  const isSelectionMode = selectedContactIds.length > 0;
  const isBulkActionRunning = isArchiving || isAssigning;

  const fetchContacts = useCallback(
    async (pageNum: number, reset: boolean): Promise<void> => {
      if (!token) return;
      try {
        setError(null);
        const res = await fetch(
          `${API_URL}/contacts?page=${pageNum}&per_page=${PER_PAGE}&sort=created_at&order=desc`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        const json = (await res.json()) as { data: Contact[]; meta: { total: number } };
        setContacts((prev) => (reset ? json.data : [...prev, ...json.data]));
        setHasMore(json.data.length === PER_PAGE);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : t('errors.serverError'));
      } finally {
        setIsLoading(false);
        setIsFetchingMore(false);
      }
    },
    [token, t],
  );

  useEffect(() => {
    setIsLoading(true);
    setPage(1);
    void fetchContacts(1, true);
  }, [fetchContacts]);

  const loadMore = useCallback((): void => {
    if (isFetchingMore || !hasMore) return;
    const nextPage = page + 1;
    setIsFetchingMore(true);
    setPage(nextPage);
    void fetchContacts(nextPage, false);
  }, [isFetchingMore, hasMore, page, fetchContacts]);

  const handleRetry = useCallback((): void => {
    setIsLoading(true);
    setPage(1);
    void fetchContacts(1, true);
  }, [fetchContacts]);

  const handleRefresh = useCallback((): void => {
    setIsRefreshing(true);
    setPage(1);
    setSelectedContactIds([]);
    void fetchContacts(1, true).finally(() => setIsRefreshing(false));
  }, [fetchContacts]);

  const handleLongPressContact = useCallback(
    (contactId: string): void => {
      if (isBulkActionRunning) return;
      setArchiveError(null);
      setAssignError(null);
      setSelectedContactIds((prev) =>
        prev.includes(contactId) ? prev : [...prev, contactId],
      );
    },
    [isBulkActionRunning],
  );

  const handleToggleSelection = useCallback(
    (contactId: string): void => {
      if (isBulkActionRunning) return;
      setArchiveError(null);
      setAssignError(null);
      setSelectedContactIds((prev) =>
        prev.includes(contactId)
          ? prev.filter((selectedId) => selectedId !== contactId)
          : [...prev, contactId],
      );
    },
    [isBulkActionRunning],
  );

  const handleCancelSelection = useCallback((): void => {
    if (isBulkActionRunning) return;
    setSelectedContactIds([]);
    setArchiveError(null);
    setAssignError(null);
    setUsersError(null);
    setSelectedUserId(null);
    setIsAssignModalVisible(false);
  }, [isBulkActionRunning]);

  const fetchOrgUsers = useCallback(async (): Promise<void> => {
    if (!token) {
      setOrgUsers([]);
      setUsersError(t('errors.unauthorized'));
      return;
    }

    try {
      setIsLoadingUsers(true);
      setUsersError(null);
      setOrgUsers([]);
      const res = await fetch(`${API_URL}/auth/users`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);

      const json = (await res.json()) as OrgUsersResponse;
      setOrgUsers(json.data);
      setSelectedUserId((currentUserId) =>
        currentUserId !== null &&
        json.data.some((user) => user.id === currentUserId)
          ? currentUserId
          : null,
      );
    } catch (e: unknown) {
      setOrgUsers([]);
      setUsersError(e instanceof Error ? e.message : t('errors.serverError'));
    } finally {
      setIsLoadingUsers(false);
    }
  }, [token, t]);

  useEffect(() => {
    if (!isAssignModalVisible) return;
    void fetchOrgUsers();
  }, [fetchOrgUsers, isAssignModalVisible]);

  const archiveSelectedContacts = useCallback(
    async (contactIds: string[]): Promise<void> => {
      if (isAssigning) return;

      if (!token) {
        setArchiveError(t('errors.unauthorized'));
        return;
      }

      try {
        setIsArchiving(true);
        setArchiveError(null);
        setAssignError(null);
        const result = await sendOrQueueMutation({
          url: `${API_URL}/contacts/bulk-archive`,
          method: 'POST',
          token,
          body: { contact_ids: contactIds },
        });

        if (!result.queued && !result.response.ok) {
          throw new Error(`Request failed with status ${result.response.status}`);
        }

        const archivedContactIds = new Set(contactIds);
        setContacts((prev) =>
          prev.filter((contact) => !archivedContactIds.has(contact.id)),
        );
        setSelectedContactIds([]);
        setError(null);
        setArchiveError(null);
        setAssignError(null);
        setUsersError(null);
        setSelectedUserId(null);
        setIsAssignModalVisible(false);
      } catch (e: unknown) {
        setArchiveError(e instanceof Error ? e.message : t('errors.serverError'));
      } finally {
        setIsArchiving(false);
      }
    },
    [isAssigning, token, t],
  );

  const handleArchivePress = useCallback((): void => {
    if (isBulkActionRunning || selectedContactIds.length === 0) return;

    const contactIdsToArchive = [...selectedContactIds];
    const contactLabel = contactIdsToArchive.length === 1 ? t('contacts.name').toLowerCase() : t('contacts.title').toLowerCase();

    Alert.alert(
      t('contacts.archive'),
      `${t('contacts.archive')} ${contactIdsToArchive.length} ${t('contacts.selected')} ${contactLabel}?`,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('contacts.archive'),
          style: 'destructive',
          onPress: () => {
            void archiveSelectedContacts(contactIdsToArchive);
          },
        },
      ],
    );
  }, [archiveSelectedContacts, isBulkActionRunning, selectedContactIds, t]);

  const handleAssignPress = useCallback((): void => {
    if (isBulkActionRunning || selectedContactIds.length === 0) return;

    setArchiveError(null);
    setAssignError(null);
    setUsersError(null);
    setSelectedUserId(null);
    setIsAssignModalVisible(true);
  }, [isBulkActionRunning, selectedContactIds.length]);

  const handleCloseAssignModal = useCallback((): void => {
    if (isAssigning) return;

    setIsAssignModalVisible(false);
    setSelectedUserId(null);
    setAssignError(null);
    setUsersError(null);
  }, [isAssigning]);

  const assignSelectedContacts = useCallback(
    async (contactIds: string[], assignedTo: string): Promise<void> => {
      if (isArchiving) return;

      if (!token) {
        setAssignError(t('errors.unauthorized'));
        return;
      }

      try {
        setIsAssigning(true);
        setAssignError(null);
        setArchiveError(null);
        const result = await sendOrQueueMutation({
          url: `${API_URL}/contacts/bulk-assign`,
          method: 'POST',
          token,
          body: {
            contact_ids: contactIds,
            assigned_to: assignedTo,
          },
        });

        if (!result.queued && !result.response.ok) {
          throw new Error(`Request failed with status ${result.response.status}`);
        }

        setSelectedContactIds([]);
        setIsAssignModalVisible(false);
        setSelectedUserId(null);
        setError(null);
        setArchiveError(null);
        setAssignError(null);
        setUsersError(null);
      } catch (e: unknown) {
        setAssignError(e instanceof Error ? e.message : t('errors.serverError'));
      } finally {
        setIsAssigning(false);
      }
    },
    [isArchiving, token, t],
  );

  const handleConfirmAssign = useCallback((): void => {
    if (isBulkActionRunning || selectedContactIds.length === 0) return;

    if (selectedUserId === null) {
      setAssignError(t('contacts.assignContacts'));
      return;
    }

    const contactIdsToAssign = [...selectedContactIds];
    void assignSelectedContacts(contactIdsToAssign, selectedUserId);
  }, [
    assignSelectedContacts,
    isBulkActionRunning,
    selectedContactIds,
    selectedUserId,
    t,
  ]);

  const filtered: Contact[] = search.trim()
    ? contacts.filter((c) => {
        const q = search.toLowerCase();
        return (
          c.first_name.toLowerCase().includes(q) ||
          (c.last_name?.toLowerCase().includes(q) ?? false) ||
          (c.email?.toLowerCase().includes(q) ?? false) ||
          (c.phone?.includes(q) ?? false)
        );
      })
    : contacts;

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Contact>): JSX.Element => {
      const name = [item.first_name, item.last_name].filter(Boolean).join(' ');
      const isSelected = selectedContactIdSet.has(item.id);
      const initials = getInitials(item.first_name, item.last_name);
      const bgColor = avatarColor(item.first_name);
      return (
        <TouchableOpacity
          style={styles.row}
          onPress={() => {
            if (isSelectionMode) {
              handleToggleSelection(item.id);
              return;
            }
            router.push({ pathname: '/contact/[id]', params: { id: item.id } });
          }}
          onLongPress={() => handleLongPressContact(item.id)}
          disabled={isBulkActionRunning}
          accessibilityRole="button"
          accessibilityState={{
            selected: isSelected,
            disabled: isBulkActionRunning,
          }}
        >
          {isSelectionMode ? (
            <View
              style={[
                styles.checkbox,
                isSelected ? styles.checkboxSelected : styles.checkboxEmpty,
              ]}
            >
              {isSelected ? <Check size={16} color="#FFFFFF" strokeWidth={3} /> : null}
            </View>
          ) : (
            <View style={[styles.avatar, { backgroundColor: bgColor }]}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
          )}
          <View style={styles.rowMain}>
            <Text style={styles.rowName} numberOfLines={1}>
              {name}
            </Text>
            {item.company ? (
              <Text style={styles.rowSub} numberOfLines={1}>
                {item.company}
              </Text>
            ) : null}
          </View>
          {item.phone ? (
            <Text style={styles.rowPhone} numberOfLines={1}>
              {item.phone}
            </Text>
          ) : null}
        </TouchableOpacity>
      );
    },
    [
      handleLongPressContact,
      handleToggleSelection,
      isBulkActionRunning,
      isSelectionMode,
      selectedContactIdSet,
    ],
  );

  const renderOrgUserItem = useCallback(
    ({ item }: ListRenderItemInfo<OrgUser>): JSX.Element => {
      const isSelected = item.id === selectedUserId;

      return (
        <TouchableOpacity
          style={[styles.userRow, isSelected ? styles.userRowSelected : null]}
          onPress={() => {
            if (isAssigning) return;
            setSelectedUserId(item.id);
            setAssignError(null);
          }}
          disabled={isAssigning}
          accessibilityRole="button"
          accessibilityState={{ selected: isSelected, disabled: isAssigning }}
        >
          <View style={styles.userRowText}>
            <Text style={styles.userName} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.userEmail} numberOfLines={1}>
              {item.email}
            </Text>
          </View>
          <View
            style={[
              styles.userSelectionIndicator,
              isSelected
                ? styles.userSelectionIndicatorSelected
                : styles.userSelectionIndicatorEmpty,
            ]}
          >
            {isSelected ? <Check size={14} color="#FFFFFF" strokeWidth={3} /> : null}
          </View>
        </TouchableOpacity>
      );
    },
    [isAssigning, selectedUserId],
  );

  if (isLoading) {
    return (
      <View style={styles.skeletonContainer}>
        {Array.from({ length: 8 }).map((_, i) => (
          <View key={i} style={styles.skeletonRow} />
        ))}
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
          <Text style={styles.retryText}>{t('common.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.circle1} pointerEvents="none" />
      <View style={styles.circle2} pointerEvents="none" />
      <View style={styles.circle3} pointerEvents="none" />
      <View style={styles.searchWrapper}>
        <Search size={16} color="#9ca3af" />
        <TextInput
          style={styles.searchInput}
          placeholder={t('contacts.searchPlaceholder')}
          placeholderTextColor="#9ca3af"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>
      {!isSelectionMode ? (
        <TouchableOpacity
          style={styles.importRow}
          onPress={() => router.push('/contacts/import' as never)}
          accessibilityRole="button"
        >
          <Text style={styles.importRowText}>{t('contacts.importCsv')}</Text>
        </TouchableOpacity>
      ) : null}
      {archiveError ? (
        <Text style={styles.archiveErrorText}>{archiveError}</Text>
      ) : null}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            colors={['#065f46']}
            tintColor="#065f46"
          />
        }
        onEndReached={search.trim() ? undefined : loadMore}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              {search.trim() ? t('contacts.noSearchResults') : t('contacts.noContacts')}
            </Text>
          </View>
        }
        ListFooterComponent={
          isFetchingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" color="#065f46" />
            </View>
          ) : null
        }
        contentContainerStyle={
          filtered.length === 0 ? styles.emptyContent : undefined
        }
      />
      {isSelectionMode ? (
        <View style={styles.actionBar}>
          <TouchableOpacity
            style={styles.cancelSelectionButton}
            onPress={handleCancelSelection}
            disabled={isBulkActionRunning}
            accessibilityRole="button"
          >
            <Text style={styles.cancelSelectionText} numberOfLines={1}>
              {t('common.cancel')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.assignButton,
              isBulkActionRunning ? styles.assignButtonDisabled : null,
            ]}
            onPress={handleAssignPress}
            disabled={isBulkActionRunning}
            accessibilityRole="button"
          >
            <Text style={styles.assignButtonText} numberOfLines={1}>
              {`${t('contacts.assign')} (${selectedContactIds.length})`}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.archiveButton,
              isBulkActionRunning ? styles.archiveButtonDisabled : null,
            ]}
            onPress={handleArchivePress}
            disabled={isBulkActionRunning}
            accessibilityRole="button"
          >
            {isArchiving ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : null}
            <Text style={styles.archiveButtonText} numberOfLines={1}>
              {isArchiving
                ? t('common.loading')
                : `${t('contacts.archive')} (${selectedContactIds.length})`}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <Modal
        animationType="slide"
        transparent
        visible={isAssignModalVisible}
        onRequestClose={handleCloseAssignModal}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.assignModal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('contacts.assignContacts')}</Text>
              <Text style={styles.modalSubtitle} numberOfLines={1}>
                {`${selectedContactIds.length} ${t('contacts.selected')}`}
              </Text>
            </View>

            {assignError ? (
              <Text style={styles.assignErrorText}>{assignError}</Text>
            ) : null}

            <View style={styles.userListContainer}>
              {isLoadingUsers ? (
                <View style={styles.modalStateContainer}>
                  <ActivityIndicator size="small" color="#065f46" />
                  <Text style={styles.modalStateText}>{t('contacts.loadingUsers')}</Text>
                </View>
              ) : usersError ? (
                <View style={styles.modalStateContainer}>
                  <Text style={styles.modalErrorText}>{usersError}</Text>
                  <TouchableOpacity
                    style={styles.modalRetryButton}
                    onPress={() => {
                      void fetchOrgUsers();
                    }}
                    disabled={isAssigning}
                    accessibilityRole="button"
                  >
                    <Text style={styles.modalRetryText}>{t('common.retry')}</Text>
                  </TouchableOpacity>
                </View>
              ) : orgUsers.length === 0 ? (
                <View style={styles.modalStateContainer}>
                  <Text style={styles.modalStateText}>{t('contacts.noUsers')}</Text>
                </View>
              ) : (
                <FlatList
                  data={orgUsers}
                  keyExtractor={(item) => item.id}
                  renderItem={renderOrgUserItem}
                  keyboardShouldPersistTaps="handled"
                />
              )}
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={handleCloseAssignModal}
                disabled={isAssigning}
                accessibilityRole="button"
              >
                <Text style={styles.modalCancelText} numberOfLines={1}>
                  {t('common.cancel')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalConfirmButton,
                  isAssigning || selectedUserId === null || isLoadingUsers
                    ? styles.modalConfirmButtonDisabled
                    : null,
                ]}
                onPress={handleConfirmAssign}
                disabled={
                  isAssigning || selectedUserId === null || isLoadingUsers
                }
                accessibilityRole="button"
              >
                {isAssigning ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : null}
                <Text style={styles.modalConfirmText} numberOfLines={1}>
                  {isAssigning ? t('common.loading') : t('contacts.assign')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
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
  skeletonContainer: {
    flex: 1,
    backgroundColor: '#ffffff',
    padding: 12,
    paddingTop: 16,
  },
  skeletonRow: {
    height: 64,
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    marginBottom: 8,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#ffffff',
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#065f46',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  searchWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    minHeight: 44,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#111827',
    paddingVertical: 10,
  },
  importRow: {
    marginHorizontal: 12,
    marginBottom: 4,
    alignItems: 'flex-end',
  },
  importRowText: {
    fontSize: 13,
    color: '#065f46',
    fontWeight: '500',
    paddingVertical: 4,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  row: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 4,
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxEmpty: {
    borderWidth: 1.5,
    borderColor: '#9ca3af',
    backgroundColor: '#FFFFFF',
  },
  checkboxSelected: {
    borderWidth: 1.5,
    borderColor: '#065f46',
    backgroundColor: '#065f46',
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    marginRight: 8,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  rowSub: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  rowPhone: {
    fontSize: 13,
    color: '#6b7280',
    maxWidth: '38%',
  },
  emptyContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: 14,
    color: '#9ca3af',
  },
  emptyContent: {
    flexGrow: 1,
  },
  footer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  archiveErrorText: {
    color: '#ef4444',
    fontSize: 13,
    marginHorizontal: 12,
    marginBottom: 8,
  },
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
  },
  cancelSelectionButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  cancelSelectionText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '600',
  },
  assignButton: {
    flex: 1,
    minWidth: 96,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: '#065f46',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 10,
  },
  assignButtonDisabled: {
    opacity: 0.7,
  },
  assignButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  archiveButton: {
    flex: 1,
    minWidth: 96,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 10,
  },
  archiveButtonDisabled: {
    opacity: 0.7,
  },
  archiveButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    justifyContent: 'flex-end',
  },
  assignModal: {
    maxHeight: '78%',
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 14,
  },
  modalHeader: {
    marginBottom: 12,
  },
  modalTitle: {
    color: '#111827',
    fontSize: 18,
    fontWeight: '700',
  },
  modalSubtitle: {
    color: '#6b7280',
    fontSize: 13,
    marginTop: 4,
  },
  assignErrorText: {
    color: '#ef4444',
    fontSize: 13,
    marginBottom: 10,
  },
  userListContainer: {
    minHeight: 180,
    maxHeight: 360,
  },
  modalStateContainer: {
    minHeight: 180,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  modalStateText: {
    color: '#6b7280',
    fontSize: 14,
    marginTop: 10,
    textAlign: 'center',
  },
  modalErrorText: {
    color: '#ef4444',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 12,
  },
  modalRetryButton: {
    minHeight: 40,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: '#065f46',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalRetryText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  userRow: {
    minHeight: 64,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  userRowSelected: {
    borderColor: '#065f46',
    backgroundColor: '#ecfdf5',
  },
  userRowText: {
    flex: 1,
    minWidth: 0,
    marginRight: 12,
  },
  userName: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '600',
  },
  userEmail: {
    color: '#6b7280',
    fontSize: 13,
    marginTop: 3,
  },
  userSelectionIndicator: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  userSelectionIndicatorEmpty: {
    borderWidth: 1.5,
    borderColor: '#9ca3af',
    backgroundColor: '#FFFFFF',
  },
  userSelectionIndicatorSelected: {
    borderWidth: 1.5,
    borderColor: '#065f46',
    backgroundColor: '#065f46',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 12,
  },
  modalCancelButton: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  modalCancelText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '600',
  },
  modalConfirmButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: '#065f46',
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
  },
  modalConfirmButtonDisabled: {
    opacity: 0.7,
  },
  modalConfirmText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
