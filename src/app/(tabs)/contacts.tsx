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
} from 'react-native';
import { router } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

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

export default function ContactsScreen(): JSX.Element {
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
        setError(e instanceof Error ? e.message : 'Failed to load contacts');
      } finally {
        setIsLoading(false);
        setIsFetchingMore(false);
      }
    },
    [token],
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
      setUsersError('You must be signed in to load users');
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
      setUsersError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setIsLoadingUsers(false);
    }
  }, [token]);

  useEffect(() => {
    if (!isAssignModalVisible) return;
    void fetchOrgUsers();
  }, [fetchOrgUsers, isAssignModalVisible]);

  const archiveSelectedContacts = useCallback(
    async (contactIds: string[]): Promise<void> => {
      if (isAssigning) return;

      if (!token) {
        setArchiveError('You must be signed in to archive contacts');
        return;
      }

      try {
        setIsArchiving(true);
        setArchiveError(null);
        setAssignError(null);
        const res = await fetch(`${API_URL}/contacts/bulk-archive`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ contact_ids: contactIds }),
        });

        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);

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
        setArchiveError(e instanceof Error ? e.message : 'Failed to archive contacts');
      } finally {
        setIsArchiving(false);
      }
    },
    [isAssigning, token],
  );

  const handleArchivePress = useCallback((): void => {
    if (isBulkActionRunning || selectedContactIds.length === 0) return;

    const contactIdsToArchive = [...selectedContactIds];
    const contactLabel = contactIdsToArchive.length === 1 ? 'contact' : 'contacts';

    Alert.alert(
      'Archive contacts',
      `Archive ${contactIdsToArchive.length} selected ${contactLabel}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: () => {
            void archiveSelectedContacts(contactIdsToArchive);
          },
        },
      ],
    );
  }, [archiveSelectedContacts, isBulkActionRunning, selectedContactIds]);

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
        setAssignError('You must be signed in to assign contacts');
        return;
      }

      try {
        setIsAssigning(true);
        setAssignError(null);
        setArchiveError(null);
        const res = await fetch(`${API_URL}/contacts/bulk-assign`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contact_ids: contactIds,
            assigned_to: assignedTo,
          }),
        });

        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);

        setSelectedContactIds([]);
        setIsAssignModalVisible(false);
        setSelectedUserId(null);
        setError(null);
        setArchiveError(null);
        setAssignError(null);
        setUsersError(null);
      } catch (e: unknown) {
        setAssignError(e instanceof Error ? e.message : 'Failed to assign contacts');
      } finally {
        setIsAssigning(false);
      }
    },
    [isArchiving, token],
  );

  const handleConfirmAssign = useCallback((): void => {
    if (isBulkActionRunning || selectedContactIds.length === 0) return;

    if (selectedUserId === null) {
      setAssignError('Choose a user to assign contacts');
      return;
    }

    const contactIdsToAssign = [...selectedContactIds];
    void assignSelectedContacts(contactIdsToAssign, selectedUserId);
  }, [
    assignSelectedContacts,
    isBulkActionRunning,
    selectedContactIds,
    selectedUserId,
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
          ) : null}
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
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.searchInput}
        placeholder="Search by name, email or phone..."
        placeholderTextColor="#9B9B9B"
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      {archiveError ? (
        <Text style={styles.archiveErrorText}>{archiveError}</Text>
      ) : null}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        onEndReached={search.trim() ? undefined : loadMore}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              {search.trim() ? 'No contacts match your search' : 'No contacts yet'}
            </Text>
          </View>
        }
        ListFooterComponent={
          isFetchingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" color="#1A73E8" />
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
              Cancel
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
              {`Assign (${selectedContactIds.length})`}
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
                ? 'Archiving...'
                : `Archive (${selectedContactIds.length})`}
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
              <Text style={styles.modalTitle}>Assign contacts</Text>
              <Text style={styles.modalSubtitle} numberOfLines={1}>
                {`${selectedContactIds.length} selected`}
              </Text>
            </View>

            {assignError ? (
              <Text style={styles.assignErrorText}>{assignError}</Text>
            ) : null}

            <View style={styles.userListContainer}>
              {isLoadingUsers ? (
                <View style={styles.modalStateContainer}>
                  <ActivityIndicator size="small" color="#1A73E8" />
                  <Text style={styles.modalStateText}>Loading users...</Text>
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
                    <Text style={styles.modalRetryText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : orgUsers.length === 0 ? (
                <View style={styles.modalStateContainer}>
                  <Text style={styles.modalStateText}>No users available</Text>
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
                  Cancel
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
                  {isAssigning ? 'Assigning...' : 'Assign'}
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
    backgroundColor: '#F5F5F5',
  },
  skeletonContainer: {
    flex: 1,
    backgroundColor: '#F5F5F5',
    padding: 12,
    paddingTop: 16,
  },
  skeletonRow: {
    height: 64,
    backgroundColor: '#E8E8E8',
    borderRadius: 8,
    marginBottom: 8,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#F5F5F5',
  },
  errorText: {
    color: '#D93025',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#1A73E8',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  searchInput: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    fontSize: 14,
    color: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    minHeight: 44,
  },
  row: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
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
    borderColor: '#9B9B9B',
    backgroundColor: '#FFFFFF',
  },
  checkboxSelected: {
    borderWidth: 1.5,
    borderColor: '#1A73E8',
    backgroundColor: '#1A73E8',
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    marginRight: 8,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  rowSub: {
    fontSize: 12,
    color: '#6B6B6B',
    marginTop: 2,
  },
  rowPhone: {
    fontSize: 13,
    color: '#6B6B6B',
    maxWidth: '38%',
  },
  emptyContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: 14,
    color: '#9B9B9B',
  },
  emptyContent: {
    flexGrow: 1,
  },
  footer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  archiveErrorText: {
    color: '#D93025',
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
    borderTopColor: '#E0E0E0',
  },
  cancelSelectionButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DADCE0',
  },
  cancelSelectionText: {
    color: '#1A1A1A',
    fontSize: 14,
    fontWeight: '600',
  },
  assignButton: {
    flex: 1,
    minWidth: 96,
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: '#1A73E8',
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
    borderRadius: 8,
    backgroundColor: '#D93025',
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
    color: '#1A1A1A',
    fontSize: 18,
    fontWeight: '700',
  },
  modalSubtitle: {
    color: '#6B6B6B',
    fontSize: 13,
    marginTop: 4,
  },
  assignErrorText: {
    color: '#D93025',
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
    color: '#6B6B6B',
    fontSize: 14,
    marginTop: 10,
    textAlign: 'center',
  },
  modalErrorText: {
    color: '#D93025',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 12,
  },
  modalRetryButton: {
    minHeight: 40,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: '#1A73E8',
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
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  userRowSelected: {
    borderColor: '#1A73E8',
    backgroundColor: '#EAF2FE',
  },
  userRowText: {
    flex: 1,
    minWidth: 0,
    marginRight: 12,
  },
  userName: {
    color: '#1A1A1A',
    fontSize: 15,
    fontWeight: '600',
  },
  userEmail: {
    color: '#6B6B6B',
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
    borderColor: '#9B9B9B',
    backgroundColor: '#FFFFFF',
  },
  userSelectionIndicatorSelected: {
    borderWidth: 1.5,
    borderColor: '#1A73E8',
    backgroundColor: '#1A73E8',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 12,
  },
  modalCancelButton: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DADCE0',
  },
  modalCancelText: {
    color: '#1A1A1A',
    fontSize: 14,
    fontWeight: '600',
  },
  modalConfirmButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: '#1A73E8',
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
