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

function dmChannel(uid1: string, uid2: string): string {
  return uid1 < uid2 ? `dm:${uid1}:${uid2}` : `dm:${uid2}:${uid1}`;
}

type Member = { id: string; name: string; email: string; role: string };

export default function NewDmScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const currentUser = useUserStore((s) => s.user);
  const { fetchChannels } = useChatStore();

  const { data: members = [], isLoading } = useQuery<Member[]>({
    queryKey: ['org-users', token],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/auth/users`, { headers: { Authorization: `Bearer ${token}` } });
      const json = (await res.json()) as { data: Member[] };
      return json.data.filter((m) => m.id !== currentUser?.id);
    },
    enabled: !!token,
  });

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
        <Text style={styles.email}>{item.email}</Text>
      </View>
    </TouchableOpacity>
  ), [handleSelect]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('chat.newDmTitle') }} />
      {isLoading
        ? <ActivityIndicator style={{ marginTop: 40 }} color="#C45A10" />
        : (
          <FlatList
            data={members}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            ListHeaderComponent={<Text style={styles.header}>{t('chat.selectMember')}</Text>}
          />
        )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  list: { paddingVertical: 8 },
  header: { fontSize: 13, color: '#B07868', paddingHorizontal: 16, paddingVertical: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#F5EDE8', gap: 12,
  },
  avatar: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: '#B07868', alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: '600', color: '#383432' },
  email: { fontSize: 13, color: '#B07868', marginTop: 2 },
});
