import React, { useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, ListRenderItemInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useUserStore } from '../../store/userStore';
import { useChatStore } from '../../store/chatStore';
import { API_URL } from '../../utils/api';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

function dmChannel(uid1: string, uid2: string): string {
  return uid1 < uid2 ? `dm:${uid1}:${uid2}` : `dm:${uid2}:${uid1}`;
}

type Member = {
  id: string;
  name: string;
  email?: string | null;
  username?: string | null;
  role: string;
};

function isMember(value: unknown): value is Member {
  if (typeof value !== 'object' || value === null) return false;

  const member = value as Record<string, unknown>;
  return typeof member.id === 'string'
    && typeof member.name === 'string'
    && typeof member.role === 'string'
    && (member.email === undefined || member.email === null || typeof member.email === 'string')
    && (member.username === undefined || member.username === null || typeof member.username === 'string');
}

export default function NewDmScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const currentUser = useUserStore((s) => s.user);
  const { fetchChannels } = useChatStore();

  const {
    data: members,
    isPending,
    isError,
    isSuccess,
    isFetching,
    refetch,
  } = useQuery<Member[]>({
    queryKey: ['org-users', token, 'dm-recipients', currentUser?.id],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/auth/users`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Failed to load team members: status ${res.status}`);

      const json: unknown = await res.json();
      if (typeof json !== 'object' || json === null) {
        throw new Error('Invalid team members response');
      }

      const data = (json as { data?: unknown }).data;
      if (!Array.isArray(data) || !data.every(isMember)) {
        throw new Error('Invalid team members response');
      }

      return data.filter((m) => m.id !== currentUser?.id);
    },
    enabled: !!token && !!currentUser?.id,
  });

  const getRoleLabel = useCallback((role: string) => {
    if (role === 'owner') return t('chat.roleOwner');
    if (role === 'admin') return t('chat.roleAdmin');
    if (role === 'viewer') return t('chat.roleViewer');
    return t('chat.roleMember');
  }, [t]);

  const handleSelect = useCallback(async (member: Member) => {
    if (!currentUser?.id) return;
    const channel = dmChannel(currentUser.id, member.id);
    await fetchChannels();
    router.replace({
      pathname: '/chat/[channel]',
      params: { channel, name: member.name },
    } as never);
  }, [currentUser?.id, fetchChannels, router]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<Member>) => (
    <TouchableOpacity style={styles.row} onPress={() => { void handleSelect(item); }} activeOpacity={0.7}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.name}>{item.name}</Text>
        <Text style={styles.email}>{item.email ?? item.username ?? getRoleLabel(item.role)}</Text>
      </View>
    </TouchableOpacity>
  ), [getRoleLabel, handleSelect, styles]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('chat.newDmTitle') }} />
      {isPending ? (
        <ActivityIndicator style={styles.loading} color={colors.orange} />
      ) : isError ? (
        <View style={styles.feedback}>
          <Text style={styles.feedbackTitle}>{t('chat.membersLoadError')}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => { void refetch(); }}
            disabled={isFetching}
            activeOpacity={0.8}
          >
            <Text style={styles.retryButtonText}>
              {isFetching ? t('common.loading') : t('common.retry')}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
          <FlatList
            data={members ?? []}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            ListHeaderComponent={<Text style={styles.header}>{t('chat.selectMember')}</Text>}
            ListEmptyComponent={isSuccess ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>{t('chat.noDmMembersTitle')}</Text>
                <Text style={styles.emptyBody}>{t('chat.noDmMembersBody')}</Text>
              </View>
            ) : null}
          />
      )}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  list: { flexGrow: 1, paddingVertical: 8 },
  loading: { marginTop: 40 },
  header: { fontSize: 13, color: c.amber, paddingHorizontal: 16, paddingVertical: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.bgPanel, paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: c.border, gap: 12,
  },
  avatar: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: c.amber, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: c.bgDark, fontSize: 17, fontWeight: '700' },
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: '600', color: c.text1 },
  email: { fontSize: 13, color: c.amber, marginTop: 2 },
  feedback: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 80 },
  feedbackTitle: { color: c.red, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  retryButton: {
    marginTop: 16, borderRadius: 8, borderWidth: 1, borderColor: c.orange,
    paddingHorizontal: 18, paddingVertical: 10,
  },
  retryButtonText: { color: c.orange, fontSize: 14, fontWeight: '600' },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 72 },
  emptyTitle: { color: c.text1, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  emptyBody: { color: c.amber, fontSize: 14, lineHeight: 20, marginTop: 8, textAlign: 'center' },
});
