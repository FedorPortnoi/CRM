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
  const { channels, loadingChannels, connect, fetchChannels } = useChatStore();

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

  const openGeneral = useCallback(() => {
    router.push({
      pathname: '/chat/[channel]',
      params: { channel: 'general', name: t('chat.generalChannel') },
    } as never);
  }, [router, t]);

  const openNewDm = useCallback(() => {
    router.push('/chat/new-dm' as never);
  }, [router]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<Channel>) => {
    const isGeneral = item.channel === 'general';
    const lastBody = item.last_message?.body;
    const lastSender = item.last_message?.sender_name;
    const lastTime = item.last_message?.created_at ? timeAgo(item.last_message.created_at) : '';
    const preview = lastBody
      ? `${lastSender ? lastSender + ': ' : ''}${lastBody}`
      : isGeneral ? t('chat.generalSubtitle') : t('chat.noMessages');

    return (
      <TouchableOpacity style={styles.row} onPress={() => handleOpen(item)} activeOpacity={0.7}>
        <View style={[styles.avatar, isGeneral ? styles.avatarGeneral : styles.avatarDm]}>
          {isGeneral
            ? <Users size={20} color="#fff" strokeWidth={2} />
            : <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>}
        </View>
        <View style={styles.info}>
          <View style={styles.infoTop}>
            <View style={styles.nameLine}>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              {!isGeneral && (
                <View style={styles.dmPill}>
                  <Text style={styles.dmPillText}>{t('chat.privatePill')}</Text>
                </View>
              )}
            </View>
            {lastTime ? <Text style={styles.time}>{lastTime}</Text> : null}
          </View>
          <Text
            style={[styles.preview, !lastBody && isGeneral && styles.previewHint]}
            numberOfLines={1}
          >
            {preview}
          </Text>
        </View>
        {item.unread > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{item.unread > 99 ? '99+' : item.unread}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }, [t, handleOpen]);

  if (loadingChannels && channels.length === 0) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color="#C45A10" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={channels}
        keyExtractor={(item) => item.channel}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, { paddingBottom: 96 }]}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <MessageSquare size={48} color="#E8DDD6" strokeWidth={1.5} />
            <Text style={styles.emptyTitle}>{t('chat.emptyTitle')}</Text>
            <Text style={styles.emptySub}>{t('chat.emptySub')}</Text>
          </View>
        }
      />

      {/* Bottom action bar: two clear buttons */}
      <View style={styles.actionBar}>
        <TouchableOpacity style={[styles.actionBtn, styles.actionBtnGeneral]} onPress={openGeneral} activeOpacity={0.85}>
          <Users size={16} color="#fff" strokeWidth={2.5} />
          <Text style={styles.actionBtnText}>{t('chat.openGeneral')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionBtn, styles.actionBtnDm]} onPress={openNewDm} activeOpacity={0.85}>
          <MessageSquare size={16} color="#C45A10" strokeWidth={2.5} />
          <Text style={[styles.actionBtnText, styles.actionBtnDmText]}>{t('chat.newDm')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
  infoTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  nameLine: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 6 },
  name: { fontSize: 15, fontWeight: '600', color: '#383432' },
  dmPill: {
    backgroundColor: '#F5EDE8', borderRadius: 4,
    paddingHorizontal: 5, paddingVertical: 1,
  },
  dmPillText: { fontSize: 10, color: '#B07868', fontWeight: '600' },
  time: { fontSize: 12, color: '#CFADA3', marginLeft: 8 },
  preview: { fontSize: 13, color: '#B07868', lineHeight: 18 },
  previewHint: { color: '#CFADA3', fontStyle: 'italic' },
  badge: {
    backgroundColor: '#C45A10', borderRadius: 10,
    minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12, marginTop: 80 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#383432' },
  emptySub: { fontSize: 14, color: '#B07868', textAlign: 'center', lineHeight: 20 },
  actionBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', gap: 10,
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 12,
    borderTopWidth: 1, borderTopColor: '#F5EDE8',
    paddingBottom: 24,
  },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, height: 44, borderRadius: 10,
  },
  actionBtnGeneral: { backgroundColor: '#C45A10' },
  actionBtnDm: { backgroundColor: '#FAF6F3', borderWidth: 1, borderColor: '#E8DDD6' },
  actionBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  actionBtnDmText: { color: '#C45A10' },
});
