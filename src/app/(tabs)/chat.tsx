import React, { useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, ListRenderItemInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Users } from 'lucide-react-native';
import { useChatStore, Channel } from '../../store/chatStore';
import { useUserStore } from '../../store/userStore';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'сейчас';
  if (mins < 60) return `${mins} мин`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ч`;
  return `${Math.floor(hrs / 24)} д`;
}

export default function ChatListScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const currentUser = useUserStore((s) => s.user);
  const { channels, connected, connect, fetchChannels } = useChatStore();

  useEffect(() => {
    if (token) {
      connect(token);
      void fetchChannels();
    }
  }, [token]);

  const handleOpen = useCallback((ch: Channel) => {
    router.push({
      pathname: '/chat/[channel]',
      params: { channel: ch.channel, name: ch.name },
    } as never);
  }, [router]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<Channel>) => {
    const isGeneral = item.channel === 'general';
    const lastBody = item.last_message?.body;
    const lastSender = item.last_message?.sender_name;
    const lastTime = item.last_message?.created_at ? timeAgo(item.last_message.created_at) : '';
    const preview = lastBody
      ? `${lastSender ? lastSender + ': ' : ''}${lastBody}`
      : t('chat.noMessages');

    return (
      <TouchableOpacity style={styles.row} onPress={() => handleOpen(item)} activeOpacity={0.7}>
        <View style={[styles.avatar, isGeneral ? styles.avatarGeneral : styles.avatarDm]}>
          {isGeneral
            ? <Users size={20} color="#fff" strokeWidth={2} />
            : <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>}
        </View>
        <View style={styles.info}>
          <View style={styles.infoTop}>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            {lastTime ? <Text style={styles.time}>{lastTime}</Text> : null}
          </View>
          <Text style={styles.preview} numberOfLines={1}>{preview}</Text>
        </View>
        {item.unread > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{item.unread > 99 ? '99+' : item.unread}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }, [t, handleOpen]);

  const totalUnread = channels.reduce((sum, c) => sum + c.unread, 0);

  const startDm = useCallback(() => {
    router.push('/chat/new-dm' as never);
  }, [router]);

  return (
    <View style={styles.container}>
      {channels.length === 0 ? (
        <View style={styles.empty}>
          <MessageSquare size={48} color="#E8DDD6" strokeWidth={1.5} />
          <Text style={styles.emptyTitle}>{t('chat.emptyTitle')}</Text>
          <Text style={styles.emptySub}>{t('chat.emptySub')}</Text>
        </View>
      ) : (
        <FlatList
          data={channels}
          keyExtractor={(item) => item.channel}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
        />
      )}

      <TouchableOpacity style={styles.fab} onPress={startDm} activeOpacity={0.85}>
        <Text style={styles.fabText}>+ {t('chat.newDm')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  list: { paddingVertical: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#F5EDE8', gap: 12,
  },
  avatar: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarGeneral: { backgroundColor: '#C45A10' },
  avatarDm: { backgroundColor: '#B07868' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  info: { flex: 1 },
  infoTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  name: { fontSize: 15, fontWeight: '600', color: '#383432', flex: 1 },
  time: { fontSize: 12, color: '#CFADA3', marginLeft: 8 },
  preview: { fontSize: 13, color: '#B07868', lineHeight: 18 },
  badge: {
    backgroundColor: '#C45A10', borderRadius: 10,
    minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#383432' },
  emptySub: { fontSize: 14, color: '#B07868', textAlign: 'center', lineHeight: 20 },
  fab: {
    position: 'absolute', bottom: 24, right: 20,
    backgroundColor: '#C45A10', borderRadius: 24,
    paddingHorizontal: 20, paddingVertical: 12,
    shadowColor: '#C45A10', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35, shadowRadius: 8, elevation: 6,
  },
  fabText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
