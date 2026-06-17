import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ListRenderItemInfo,
  Alert,
  Modal,
  RefreshControl,
  StatusBar,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Search, Plus, SlidersHorizontal, Check, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { sendOrQueueMutation } from '../../utils/offlineMutation';
import ContactCard, { ContactCardData, ContactCardType } from '../../components/ContactCard';

type ContactTypeValue = 'lead' | 'customer' | 'partner' | 'other';

type Contact = {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  type?: ContactTypeValue | null;
  avatar_url?: string | null;
  last_contacted_at?: string | null;
  active_deals_count?: number | null;
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

type SegmentKey = 'all' | 'customer' | 'partner' | 'lead';

type SortKey = 'created_at' | 'updated_at' | 'first_name';

type ListItem = { _type: 'contact'; data: Contact } | { _type: 'header'; letter: string };

const PER_PAGE = 20;

const COLORS = {
  cream: '#F7F1EC',
  lightCream: '#E8DDD6',
  burntOrange: '#C45A10',
  charcoal: '#333333',
  white: '#FFFFFF',
  black: '#161412',
  textMuted: '#6F625D',
  cardBorder: '#EEE5DF',
  darkBrown: '#8B3A00',
} as const;

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

function normalizeType(type?: ContactTypeValue | null): ContactCardType {
  if (type === 'customer' || type === 'partner' || type === 'lead') return type;
  return 'other';
}

export default function ContactsScreen(): JSX.Element {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { token } = useUserStore();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [segment, setSegment] = useState<SegmentKey>('all');
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [isAssignModalVisible, setIsAssignModalVisible] = useState(false);
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [showNoContact30d, setShowNoContact30d] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const filter = showNoContact30d ? 'no-contact-30d' : 'all';
  const typeParam = segment === 'all' ? undefined : segment;

  const contactsQuery = useQuery<ContactsResponse, Error>({
    queryKey: ['contacts', page, search, filter, typeParam, sortKey, token],
    queryFn: async (): Promise<ContactsResponse> => {
      if (!token) {
        throw new Error(t('errors.unauthorized'));
      }

      const query = search.trim();

      const fetchPage = async (currentPage: number): Promise<ContactsResponse> => {
        const sortOrder = sortKey === 'first_name' ? 'asc' : 'desc';
        const params = new URLSearchParams({
          page: String(currentPage),
          per_page: String(PER_PAGE),
          sort: sortKey,
          order: sortOrder,
        });

        if (query) {
          params.set('q', query);
        }

        if (typeParam) {
          params.set('type', typeParam);
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

  // Lightweight per-segment totals (page 1, single row) so the tab counts
  // reflect the real backend totals regardless of the loaded page / filter.
  const countsQuery = useQuery<Record<SegmentKey, number>, Error>({
    queryKey: ['contacts-counts', search, token],
    enabled: Boolean(token),
    queryFn: async (): Promise<Record<SegmentKey, number>> => {
      if (!token) {
        throw new Error(t('errors.unauthorized'));
      }

      const query = search.trim();

      const fetchTotal = async (type?: ContactTypeValue): Promise<number> => {
        const params = new URLSearchParams({ page: '1', per_page: '1' });
        if (query) params.set('q', query);
        if (type) params.set('type', type);

        const res = await fetch(
          `${API_URL}/contacts?${params.toString()}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        const json = (await res.json()) as ContactsResponse;
        return json.meta.total;
      };

      const [all, customer, partner, lead] = await Promise.all([
        fetchTotal(),
        fetchTotal('customer'),
        fetchTotal('partner'),
        fetchTotal('lead'),
      ]);

      return { all, customer, partner, lead };
    },
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
      void queryClient.invalidateQueries({ queryKey: ['contacts-counts'] });
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
            typeParam,
            sortKey,
            token,
          ]),
        ).filter((value): value is ContactsResponse => value !== undefined);

  const contacts = contactPages.flatMap((contactPage) => contactPage.data);
  const totalCount = contactsQuery.data?.meta.total ?? 0;
  const hasMore =
    filter !== 'no-contact-30d' &&
    contactsQuery.data !== undefined &&
    contactsQuery.data.data.length === PER_PAGE &&
    contacts.length < contactsQuery.data.meta.total;
  const isLoading = contactsQuery.isPending && contacts.length === 0;
  const isFetchingMore = page > 1 && contactsQuery.isPending;
  const isRefreshing = contactsQuery.isRefetching && page === 1;
  const error = contactsQuery.isError ? contactsQuery.error.message : null;

  const counts = countsQuery.data;
  const headerTotal = counts?.all ?? totalCount;

  const selectedContactIdSet = useMemo(
    () => new Set(selectedContactIds),
    [selectedContactIds],
  );
  const isSelectionMode = selectedContactIds.length > 0;
  const isArchiving = archiveMutation.isPending;
  const isAssigning = assignMutation.isPending;
  const isBulkActionRunning = isArchiving || isAssigning;

  const dateLocale = i18n.language === 'en' ? enUS : ru;

  const loadMore = useCallback((): void => {
    if (contactsQuery.isFetching || !hasMore) return;
    setPage((currentPage) => currentPage + 1);
  }, [contactsQuery.isFetching, hasMore]);

  const handleRetry = useCallback((): void => {
    setPage(1);
    void queryClient.invalidateQueries({ queryKey: ['contacts'] });
    void queryClient.invalidateQueries({ queryKey: ['contacts-counts'] });
  }, [queryClient]);

  const handleRefresh = useCallback((): void => {
    setPage(1);
    setSelectedContactIds([]);
    void queryClient.invalidateQueries({ queryKey: ['contacts'] });
    void queryClient.invalidateQueries({ queryKey: ['contacts-counts'] });
  }, [queryClient]);

  const handleSearchChange = useCallback((text: string): void => {
    setSearch(text);
    setPage(1);
    setSelectedContactIds([]);
  }, []);

  const handleToggleSearch = useCallback((): void => {
    setSearchOpen((open) => {
      const next = !open;
      if (!next && search.length > 0) {
        setSearch('');
        setPage(1);
      }
      return next;
    });
  }, [search.length]);

  const handleSelectSegment = useCallback((next: SegmentKey): void => {
    setSegment(next);
    setPage(1);
    setSelectedContactIds([]);
  }, []);

  const handleSelectSort = useCallback((next: SortKey): void => {
    setSortKey(next);
    setPage(1);
    void queryClient.invalidateQueries({ queryKey: ['contacts'] });
  }, [queryClient]);

  const handleAddPress = useCallback((): void => {
    Alert.alert(t('contacts.add'), undefined, [
      { text: t('contacts.new'), onPress: () => { router.push('/contact/new'); } },
      { text: t('contacts.scanCard'), onPress: () => { router.push('/contact/scan-card'); } },
      { text: '📲 Импорт из приложений', onPress: () => { router.push('/import-hub' as never); } },
      { text: t('contacts.importPhone'), onPress: () => { router.push('/contact/import-phone'); } },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  }, [t]);

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

  const listItems = useMemo((): ListItem[] => {
    if (search.trim() || showNoContact30d || sortKey !== 'first_name') {
      return filtered.map(c => ({ _type: 'contact' as const, data: c }));
    }
    const result: ListItem[] = [];
    let lastLetter = '';
    for (const c of filtered) {
      const letter = (c.first_name.charAt(0) || '#').toUpperCase();
      if (letter !== lastLetter) {
        result.push({ _type: 'header', letter });
        lastLetter = letter;
      }
      result.push({ _type: 'contact', data: c });
    }
    return result;
  }, [filtered, search, showNoContact30d, sortKey]);

  const activityCaption = t('contacts.activityPrefix');

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Contact>): JSX.Element => {
      const name = [item.first_name, item.last_name].filter(Boolean).join(' ');
      const cardType = normalizeType(item.type);
      const activityDaysAgo = item.last_contacted_at
        ? Math.floor((Date.now() - new Date(item.last_contacted_at).getTime()) / 86_400_000)
        : null;
      const data: ContactCardData = {
        id: item.id,
        name,
        company: item.company,
        phone: item.phone,
        type: cardType,
        typeLabel: t(`contacts.${cardType}`),
        avatarUrl: item.avatar_url,
        initials: getInitials(item.first_name, item.last_name),
        avatarColor: avatarColor(item.first_name),
        activityLabel: item.last_contacted_at
          ? formatDistanceToNow(new Date(item.last_contacted_at), { addSuffix: true, locale: dateLocale })
          : null,
        activityDaysAgo,
        activeDealsCount: item.active_deals_count ?? null,
      };

      return (
        <ContactCard
          contact={data}
          selectionMode={isSelectionMode}
          selected={selectedContactIdSet.has(item.id)}
          disabled={isBulkActionRunning}
          activityCaption={activityCaption}
          onPress={() => {
            if (isSelectionMode) {
              handleToggleSelection(item.id);
              return;
            }
            router.push({ pathname: '/contact/[id]', params: { id: item.id } });
          }}
          onLongPress={() => handleLongPressContact(item.id)}
          onMenuPress={() => handleLongPressContact(item.id)}
        />
      );
    },
    [
      activityCaption,
      dateLocale,
      handleLongPressContact,
      handleToggleSelection,
      isBulkActionRunning,
      isSelectionMode,
      selectedContactIdSet,
      t,
    ],
  );

  const renderListItem = useCallback(
    ({ item }: ListRenderItemInfo<ListItem>): JSX.Element => {
      if (item._type === 'header') {
        return <Text style={styles.sectionHeader}>{item.letter}</Text>;
      }
      return renderItem({ item: item.data } as ListRenderItemInfo<Contact>);
    },
    [renderItem],
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

  const segments: { key: SegmentKey; label: string; count: number | undefined }[] = [
    { key: 'all', label: t('contacts.tabAll'), count: counts?.all },
    { key: 'customer', label: t('contacts.tabCustomers'), count: counts?.customer },
    { key: 'partner', label: t('contacts.tabPartners'), count: counts?.partner },
    { key: 'lead', label: t('contacts.tabLeads'), count: counts?.lead },
  ];

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'first_name', label: 'По имени' },
    { key: 'created_at', label: 'По дате' },
    { key: 'updated_at', label: 'По активности' },
  ];

  const renderHeader = (): JSX.Element => (
    <LinearGradient
      colors={[COLORS.charcoal, '#222222']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.header, { paddingTop: insets.top + 10 }]}
    >
      <View style={styles.headerContent}>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>{t('contacts.title')}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {t('contacts.totalCount', { count: headerTotal })}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('contacts.search')}
          hitSlop={10}
          onPress={handleToggleSearch}
          style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}
        >
          {searchOpen ? (
            <X size={25} color={COLORS.white} strokeWidth={2.2} />
          ) : (
            <Search size={24} color={COLORS.white} strokeWidth={2.2} />
          )}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('contacts.add')}
          onPress={handleAddPress}
          style={({ pressed }) => [styles.addButtonWrap, pressed && styles.pressed]}
        >
          <LinearGradient
            colors={[COLORS.burntOrange, '#FA6A1E']}
            start={{ x: 0.15, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.addButton}
          >
            <Plus size={26} color={COLORS.white} strokeWidth={2.6} />
          </LinearGradient>
        </Pressable>
      </View>

      {searchOpen ? (
        <View style={styles.searchWrapper}>
          <Search size={18} color="#CFADA3" />
          <TextInput
            style={styles.searchInput}
            placeholder={t('contacts.searchPlaceholder')}
            placeholderTextColor="#CFADA3"
            value={search}
            onChangeText={handleSearchChange}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            clearButtonMode="while-editing"
          />
        </View>
      ) : null}
    </LinearGradient>
  );

  const renderTabs = (): JSX.Element => (
    <View>
      <View style={styles.tabsRow}>
        <View style={styles.tabsCard}>
          {segments.map((seg) => {
            const isActive = segment === seg.key;
            return (
              <Pressable
                key={seg.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
                onPress={() => handleSelectSegment(seg.key)}
                style={({ pressed }) => [
                  styles.tab,
                  isActive && styles.activeTab,
                  pressed && styles.pressed,
                ]}
              >
                <Text numberOfLines={1} style={[styles.tabLabel, isActive && styles.activeTabLabel]}>
                  {seg.label}
                </Text>
                <Text style={[styles.tabCount, isActive && styles.activeTabCount]}>
                  {seg.count ?? '—'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.filter')}
          accessibilityState={{ selected: showNoContact30d }}
          onPress={handleToggleNoContactFilter}
          style={({ pressed }) => [
            styles.filterButton,
            showNoContact30d && styles.filterButtonActive,
            pressed && styles.pressed,
          ]}
        >
          <SlidersHorizontal
            size={22}
            color={showNoContact30d ? COLORS.burntOrange : COLORS.textMuted}
          />
        </Pressable>
      </View>

      <View style={styles.sortRow}>
        {sortOptions.map((opt) => {
          const isActive = sortKey === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              onPress={() => handleSelectSort(opt.key)}
              style={[styles.sortPill, isActive && styles.sortPillActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
            >
              <Text style={[styles.sortPillText, isActive && styles.sortPillTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {showNoContact30d ? (
        <View style={styles.filterChip}>
          <Text style={styles.filterChipText}>Нет контакта 30+ дней</Text>
          <TouchableOpacity onPress={handleToggleNoContactFilter} hitSlop={8}>
            <X size={14} color="#C45A10" />
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );

  const listContent = (
    <FlatList<ListItem>
      data={listItems}
      keyExtractor={(item) => item._type === 'header' ? 'hdr-' + item.letter : item.data.id}
      renderItem={renderListItem}
      ListHeaderComponent={renderTabs}
      ItemSeparatorComponent={ItemSeparator}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={handleRefresh}
          colors={[COLORS.burntOrange]}
          tintColor={COLORS.burntOrange}
        />
      }
      onEndReached={loadMore}
      onEndReachedThreshold={0.3}
      showsVerticalScrollIndicator={false}
      ListEmptyComponent={
        showNoContact30d && !search.trim() ? (
          <View style={styles.filterEmptyState}>
            <Text style={styles.filterEmptyIcon}>✓</Text>
            <Text style={styles.filterEmptyTitle}>Все клиенты на связи!</Text>
            <Text style={styles.filterEmptySubtitle}>Никто не остался без внимания 30+ дней</Text>
          </View>
        ) : (
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
                  onPress={() => router.push('/contact/scan-card')}
                  accessibilityRole="button"
                >
                  <Text style={styles.emptySecondaryText}>{t('contacts.scanCard')}</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        )
      }
      ListFooterComponent={
        isFetchingMore ? (
          <View style={styles.footer}>
            <ActivityIndicator size="small" color={COLORS.burntOrange} />
          </View>
        ) : null
      }
      contentContainerStyle={[
        styles.listContent,
        { paddingBottom: insets.bottom + (isSelectionMode ? 96 : 28) },
        filtered.length === 0 ? styles.listContentEmpty : null,
      ]}
    />
  );

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      {renderHeader()}

      {isLoading ? (
        <View style={styles.body}>
          {renderTabs()}
          <View style={styles.skeletonList}>
            {Array.from({ length: 6 }).map((_, i) => (
              <View key={i} style={styles.skeletonCard} />
            ))}
          </View>
        </View>
      ) : error ? (
        <View style={styles.stateContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryText}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.body}>
          {archiveError ? <Text style={styles.archiveErrorText}>{archiveError}</Text> : null}
          {listContent}
        </View>
      )}

      {isSelectionMode ? (
        <View style={[styles.actionBar, { paddingBottom: insets.bottom + 12 }]}>
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
                  <ActivityIndicator size="small" color={COLORS.burntOrange} />
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

function ItemSeparator(): JSX.Element {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.cream,
  },
  header: {
    paddingBottom: 22,
    paddingHorizontal: 20,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    shadowColor: COLORS.charcoal,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
    elevation: 12,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerIconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleBlock: {
    flex: 1,
  },
  title: {
    color: COLORS.white,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  subtitle: {
    marginTop: 3,
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 13,
    fontWeight: '500',
  },
  addButtonWrap: {
    marginLeft: 12,
    borderRadius: 24,
    shadowColor: COLORS.darkBrown,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 12,
    elevation: 9,
  },
  addButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    marginTop: 16,
    paddingHorizontal: 14,
    borderRadius: 14,
    minHeight: 46,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: '#383432',
    paddingVertical: 10,
  },
  body: {
    flex: 1,
  },
  tabsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  tabsCard: {
    flex: 1,
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    backgroundColor: COLORS.white,
    shadowColor: COLORS.charcoal,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.04,
    shadowRadius: 14,
    elevation: 2,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 2,
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  activeTab: {
    borderBottomColor: COLORS.burntOrange,
  },
  tabLabel: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  activeTabLabel: {
    color: COLORS.burntOrange,
  },
  tabCount: {
    marginTop: 4,
    color: COLORS.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  activeTabCount: {
    color: COLORS.burntOrange,
  },
  filterButton: {
    width: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    backgroundColor: COLORS.white,
    shadowColor: COLORS.charcoal,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.04,
    shadowRadius: 14,
    elevation: 2,
  },
  filterButtonActive: {
    borderColor: COLORS.burntOrange,
    backgroundColor: '#FEF0E8',
  },
  sortRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  sortPill: {
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#EEE5DF',
    backgroundColor: COLORS.white,
  },
  sortPillActive: {
    backgroundColor: '#C45A10',
    borderColor: '#C45A10',
  },
  sortPillText: {
    fontSize: 13,
    color: '#6F625D',
    fontWeight: '500',
  },
  sortPillTextActive: {
    color: COLORS.white,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#FEF0E8',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: '#FBBF87',
  },
  filterChipText: {
    fontSize: 13,
    color: '#C45A10',
    fontWeight: '500',
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    color: '#B07868',
    paddingHorizontal: 4,
    paddingTop: 12,
    paddingBottom: 4,
    letterSpacing: 0.5,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  listContentEmpty: {
    flexGrow: 1,
  },
  separator: {
    height: 12,
  },
  skeletonList: {
    paddingHorizontal: 16,
  },
  skeletonCard: {
    height: 104,
    backgroundColor: '#FBF6F2',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    marginBottom: 12,
  },
  stateContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: COLORS.burntOrange,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 40,
    paddingHorizontal: 16,
  },
  emptyText: {
    fontSize: 15,
    color: '#9A8C84',
    textAlign: 'center',
  },
  emptyActions: {
    width: '100%',
    marginTop: 20,
    gap: 10,
  },
  emptyPrimaryButton: {
    backgroundColor: COLORS.burntOrange,
    borderRadius: 14,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  emptyPrimaryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  emptySecondaryButton: {
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 14,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    backgroundColor: COLORS.white,
  },
  emptySecondaryText: {
    color: COLORS.burntOrange,
    fontSize: 15,
    fontWeight: '600',
  },
  filterEmptyState: {
    alignItems: 'center',
    paddingTop: 40,
    paddingHorizontal: 24,
  },
  filterEmptyIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  filterEmptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#383432',
    textAlign: 'center',
  },
  filterEmptySubtitle: {
    fontSize: 14,
    color: '#9A8C84',
    textAlign: 'center',
    marginTop: 8,
  },
  footer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  archiveErrorText: {
    color: '#ef4444',
    fontSize: 13,
    marginHorizontal: 16,
    marginTop: 12,
  },
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: COLORS.cardBorder,
  },
  cancelSelectionButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
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
    backgroundColor: COLORS.burntOrange,
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
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
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
    backgroundColor: COLORS.burntOrange,
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
    borderColor: COLORS.cardBorder,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  userRowSelected: {
    borderColor: COLORS.burntOrange,
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
    borderColor: COLORS.burntOrange,
    backgroundColor: COLORS.burntOrange,
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
    borderColor: COLORS.cardBorder,
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
    backgroundColor: COLORS.burntOrange,
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
  pressed: {
    opacity: 0.72,
  },
});
