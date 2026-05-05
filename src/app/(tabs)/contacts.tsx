import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ListRenderItemInfo,
} from 'react-native';
import { router } from 'expo-router';
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
      return (
        <TouchableOpacity
          style={styles.row}
          onPress={() =>
            router.push({ pathname: '/contact/[id]', params: { id: item.id } })
          }
          accessibilityRole="button"
        >
          <View style={styles.rowMain}>
            <Text style={styles.rowName}>{name}</Text>
            {item.company ? (
              <Text style={styles.rowSub}>{item.company}</Text>
            ) : null}
          </View>
          {item.phone ? (
            <Text style={styles.rowPhone}>{item.phone}</Text>
          ) : null}
        </TouchableOpacity>
      );
    },
    [],
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
  rowMain: {
    flex: 1,
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
});
