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
import { formatDistanceToNow } from 'date-fns';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  last_contacted_at?: string | null;
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

type ContactsResponse = {
  data: Contact[];
  meta: {
    total: number;
  };
};

const PER_PAGE = 20;

const AVATAR_COLORS = ['#C45A10', '#6366f1', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9'];

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
  const queryClient = useQueryClient();
  const { token } = useUserStore();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [isAssignModalVisible, setIsAssignModalVisible] = useState(false);
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [showNoContact30d, setShowNoContact30d] = useState(false);
  const filter = showNoContact30d ? 'no-contact-30d' : 'all';

  const contactsQuery = useQuery<ContactsResponse, Error>({
    queryKey: ['contacts', page, search, filter, token],
    queryFn: async (): Promise<ContactsResponse> => {
      if (!token) {
        throw new Error(t('errors.unauthorized'));
      }

      const query = search.trim();

      const fetchPage = async (currentPage: number): Promise<ContactsResponse> => {
        const params = new URLSearchParams({
          page: String(currentPage),
          per_page: String(PER_PAGE),
          sort: 'created_at',
          order: 'desc',
        });

        if (query) {
          params.set('q', query);
        }

        const res = await fetch(
          `${API_URL}/contacts?${params.toString()}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );

        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);

        return (await res.json()) as ContactsResponse;
      };

      if (filter === 'no-contact-30d') {
        const allContacts: Contact[] = [];
        let currentPage = 1;
        let total: number | null = null;

        while (total === null || allContacts.length < total) {
          const json = await fetchPage(currentPage);
          allContacts.push(...json.data);
          total = json.meta.total;

          if (json.data.length < PER_PAGE) {
            break;
          }

          currentPage += 1;
        }

        return {
          data: allContacts,
          meta: { total: total ?? allContacts.length },
        };
      }

      return fetchPage(page);
    },
    retry: (failureCount) => Boolean(token) && failureCount < 3,
  });

  const archiveMutation = useMutation<void, Error, string[]>({
    mutationFn: async (contactIds: string[]): Promise<void> => {
      if (!token) {
        throw new Error(t('errors.unauthorized'));
      }

      const result = await sendOrQueueMutation({
        url: `${API_URL}/contacts/bulk-archive`,
        method: 'POST',
        token,
        body: { contact_ids: contactIds },
      });

      if (!result.queued && !result.response.ok) {
        throw new Error(`Request failed with status ${result.response.status}`);
      }
    },
    onSuccess: (_data, contactIds) => {
      const archivedContactIds = new Set(contactIds);
      queryClient.setQueriesData<ContactsResponse>(
        { queryKey: ['contacts'] },
        (current) => {
          if (!current) return current;

          const nextData = current.data.filter(
            (contact) => !archivedContactIds.has(contact.id),
          );
          const removedCount = current.data.length - nextData.length;

          if (removedCount === 0) return current;

          return {
            ...current,
            data: nextData,
            meta: {
              ...current.meta,
              total: Math.max(0, current.meta.total - removedCount),
            },
          };
        },
      );
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setSelectedContactIds([]);
      setArchiveError(null);
      setAssignError(null);
      setUsersError(null);
      setSelectedUserId(null);
      setIsAssignModalVisible(false);
    },
    onError: (e) => {
      setArchiveError(e.message);
    },
  });

  const assignMutation = useMutation<void, Error, { contactIds: string[]; assignedTo: string }>({
    mutationFn: async ({ contactIds, assignedTo }): Promise<void> => {
      if (!token) {
        throw new Error(t('errors.unauthorized'));
      }

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
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setSelectedContactIds([]);
      setIsAssignModalVisible(false);
      setSelectedUserId(null);
      setArchiveError(null);
      setAssignError(null);
      setUsersError(null);
    },
    onError: (e) => {
      setAssignError(e.message);
    },
  });

  const contactPages =
    filter === 'no-contact-30d'
      ? contactsQuery.data
        ? [contactsQuery.data]
        : []
      : Array.from({ length: page }, (_, index) =>
          queryClient.getQueryData<ContactsResponse>([
            'contacts',
            index + 1,
            search,
            filter,
            token,
          ]),
        ).filter((value): value is ContactsResponse => value !== undefined);

  const contacts = contactPages.flatMap((contactPage) => contactPage.data);
  const hasMore =
    filter !== 'no-contact-30d' &&
    contactsQuery.data !== undefined &&
    contactsQuery.data.data.length === PER_PAGE &&
    contacts.length < contactsQuery.data.meta.total;
  const isLoading = contactsQuery.isPending && contacts.length === 0;
  const isFetchingMore = page > 1 && contactsQuery.isPending;
  const isRefreshing = contactsQuery.isRefetching && page === 1;
  const error = contactsQuery.isError ? contactsQuery.error.message : null;

  const selectedContactIdSet = useMemo(
    () => new Set(selectedContactIds),
    [selectedContactIds],
  );
  const isSelectionMode = selectedContactIds.length > 0;
  const isArchiving = archiveMutation.isPending;
  const isAssigning = assignMutation.isPending;
  const isBulkActionRunning = isArchiving || isAssigning;

  const loadMore = useCallback((): void => {
    if (contactsQuery.isFetching || !hasMore) return;
    setPage((currentPage) => currentPage + 1);
  }, [contactsQuery.isFetching, hasMore]);

  const handleRetry = useCallback((): void => {
    setPage(1);
    void queryClient.invalidateQueries({ queryKey: ['contacts'] });
  }, [queryClient]);

  const handleRefresh = useCallback((): void => {
    setPage(1);
    setSelectedContactIds([]);
    void queryClient.invalidateQueries({ queryKey: ['contacts'] });
  }, [queryClient]);

  const handleSearchChange = useCallback((text: string): void => {
    setSearch(text);
    setPage(1);
    setSelectedContactIds([]);
  }, []);

  const handleToggleNoContactFilter = useCallback((): void => {
    setShowNoContact30d((current) => !current);
    setPage(1);
    setSelectedContactIds([]);
  }, []);

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
    (contactIds: string[]): void => {
      if (isAssigning) return;

      setArchiveError(null);
      setAssignError(null);
      archiveMutation.mutate(contactIds);
    },
    [archiveMutation, isAssigning],
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
            archiveSelectedContacts(contactIdsToArchive);
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
    (contactIds: string[], assignedTo: string): void => {
      if (isArchiving) return;

      setAssignError(null);
      setArchiveError(null);
      assignMutation.mutate({ contactIds, assignedTo });
    },
    [assignMutation, isArchiving],
  );

  const handleConfirmAssign = useCallback((): void => {
    if (isBulkActionRunning || selectedContactIds.length === 0) return;

    if (selectedUserId === null) {
      setAssignError(t('contacts.assignContacts'));
      return;
    }

    const contactIdsToAssign = [...selectedContactIds];
    assignSelectedContacts(contactIdsToAssign, selectedUserId);
  }, [
    assignSelectedContacts,
    isBulkActionRunning,
    selectedContactIds,
    selectedUserId,
    t,
  ]);

  const thirtyDaysAgo = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return date;
  }, []);

  const filtered = showNoContact30d
    ? contacts.filter((c) => !c.last_contacted_at || new Date(c.last_contacted_at) < thirtyDaysAgo)
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
            {item.last_contacted_at ? (
              <Text style={styles.lastContactText}>
                Last contact: {formatDistanceToNow(new Date(item.last_contacted_at), { addSuffix: true })}
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
        <Search size={16} color="#CFADA3" />
        <TextInput
          style={styles.searchInput}
          placeholder={t('contacts.searchPlaceholder')}
          placeholderTextColor="#CFADA3"
          value={search}
          onChangeText={handleSearchChange}
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
      {!isSelectionMode ? (
        <View style={styles.filterBar}>
          <TouchableOpacity
            style={[styles.filterChip, showNoContact30d ? styles.filterChipActive : null]}
            onPress={handleToggleNoContactFilter}
            accessibilityRole="button"
            accessibilityState={{ selected: showNoContact30d }}
          >
            <Text style={[styles.filterChipText, showNoContact30d ? styles.filterChipTextActive : null]}>
              No contact 30d+
            </Text>
          </TouchableOpacity>
        </View>
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
            colors={['#C45A10']}
            tintColor="#C45A10"
          />
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              {search.trim() ? t('contacts.noSearchResults') : t('contacts.noContacts')}
            </Text>
            {!search.trim() && !showNoContact30d ? (
              <View style={styles.emptyActions}>
                <TouchableOpacity
                  style={styles.emptyPrimaryButton}
                  onPress={() => router.push('/contact/new')}
                  accessibilityRole="button"
                >
                  <Text style={styles.emptyPrimaryText}>{t('contacts.add')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.emptySecondaryButton}
                  onPress={() => router.push('/contacts/import' as never)}
                  accessibilityRole="button"
                >
                  <Text style={styles.emptySecondaryText}>{t('contacts.importCsv')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.emptySecondaryButton}
                  onPress={() => router.push('/contact/scan-card' as never)}
                  accessibilityRole="button"
                >
                  <Text style={styles.emptySecondaryText}>{t('contacts.scanCard')}</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        }
        ListFooterComponent={
          isFetchingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" color="#C45A10" />
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
                  <ActivityIndicator size="small" color="#C45A10" />
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
    backgroundColor: '#FAF6F3',
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
    backgroundColor: '#C45A10',
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
    borderColor: '#E8DDD6',
    minHeight: 44,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#383432',
    paddingVertical: 10,
  },
  importRow: {
    marginHorizontal: 12,
    marginBottom: 4,
    alignItems: 'flex-end',
  },
  importRowText: {
    fontSize: 13,
    color: '#C45A10',
    fontWeight: '500',
    paddingVertical: 4,
  },
  filterBar: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginBottom: 8,
  },
  filterChip: {
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#FFFFFF',
  },
  filterChipActive: {
    borderColor: '#C45A10',
    backgroundColor: '#FEF0E8',
  },
  filterChipText: {
    color: '#B07868',
    fontSize: 12,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: '#C45A10',
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
    borderColor: '#CFADA3',
    backgroundColor: '#FFFFFF',
  },
  checkboxSelected: {
    borderWidth: 1.5,
    borderColor: '#C45A10',
    backgroundColor: '#C45A10',
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    marginRight: 8,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#383432',
  },
  rowSub: {
    fontSize: 12,
    color: '#B07868',
    marginTop: 2,
  },
  lastContactText: {
    fontSize: 11,
    color: '#CFADA3',
    marginTop: 2,
  },
  rowPhone: {
    fontSize: 13,
    color: '#B07868',
    maxWidth: '38%',
  },
  emptyContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: 14,
    color: '#CFADA3',
    textAlign: 'center',
  },
  emptyActions: {
    width: '100%',
    marginTop: 18,
    gap: 10,
  },
  emptyPrimaryButton: {
    backgroundColor: '#C45A10',
    borderRadius: 12,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  emptyPrimaryText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  emptySecondaryButton: {
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    backgroundColor: '#FFFFFF',
  },
  emptySecondaryText: {
    color: '#C45A10',
    fontSize: 14,
    fontWeight: '600',
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
    borderTopColor: '#FAF6F3',
  },
  cancelSelectionButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E8DDD6',
  },
  cancelSelectionText: {
    color: '#383432',
    fontSize: 14,
    fontWeight: '600',
  },
  assignButton: {
    flex: 1,
    minWidth: 96,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: '#C45A10',
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
    color: '#383432',
    fontSize: 18,
    fontWeight: '700',
  },
  modalSubtitle: {
    color: '#B07868',
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
    color: '#B07868',
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
    backgroundColor: '#C45A10',
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
    borderColor: '#E8DDD6',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  userRowSelected: {
    borderColor: '#C45A10',
    backgroundColor: '#FEF0E8',
  },
  userRowText: {
    flex: 1,
    minWidth: 0,
    marginRight: 12,
  },
  userName: {
    color: '#383432',
    fontSize: 15,
    fontWeight: '600',
  },
  userEmail: {
    color: '#B07868',
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
    borderColor: '#CFADA3',
    backgroundColor: '#FFFFFF',
  },
  userSelectionIndicatorSelected: {
    borderWidth: 1.5,
    borderColor: '#C45A10',
    backgroundColor: '#C45A10',
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
    borderColor: '#E8DDD6',
  },
  modalCancelText: {
    color: '#383432',
    fontSize: 14,
    fontWeight: '600',
  },
  modalConfirmButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: '#C45A10',
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
