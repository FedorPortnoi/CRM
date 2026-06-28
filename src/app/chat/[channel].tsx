import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
  ListRenderItemInfo,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react-native';
import { useChatStore, ChatMessage } from '../../store/chatStore';
import { useUserStore } from '../../store/userStore';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} ${time}`;
}

export default function ChatRoomScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const { channel, name } = useLocalSearchParams<{ channel: string; name: string }>();
  const navigation = useNavigation();
  const currentUser = useUserStore((s) => s.user);
  const { messages, hasMore, fetchMessages, sendMessage, markRead } = useChatStore();

  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const listRef = useRef<FlatList>(null);

  const channelMessages = messages[channel] ?? [];

  useEffect(() => {
    navigation.setOptions({ title: name ?? channel });
  }, [name, channel]);

  useEffect(() => {
    void fetchMessages(channel);
    void markRead(channel);
  }, [channel]);

  const handleSend = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setBody('');
    setSending(true);
    try {
      await sendMessage(channel, text);
    } catch { /* show nothing — message will retry on next attempt */ }
    finally { setSending(false); }
  };

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore[channel]) return;
    const oldest = channelMessages[channelMessages.length - 1];
    if (!oldest) return;
    setLoadingMore(true);
    await fetchMessages(channel, oldest.created_at);
    setLoadingMore(false);
  };

  const renderItem = useCallback(({ item, index }: ListRenderItemInfo<ChatMessage>) => {
    const isMine = item.sender.id === currentUser?.id;
    // Show sender name above first message in a sequence from the same sender
    const prev = channelMessages[index + 1]; // +1 because list is inverted
    const showName = !isMine && (!prev || prev.sender.id !== item.sender.id);

    return (
      <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleOther]}>
        {showName && (
          <Text style={styles.senderName}>{item.sender.name}</Text>
        )}
        <View style={[styles.bubbleInner, isMine ? styles.bubbleInnerMine : styles.bubbleInnerOther]}>
          <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>{item.body}</Text>
          <Text style={[styles.bubbleTime, isMine && styles.bubbleTimeMine]}>{formatTime(item.created_at)}</Text>
        </View>
      </View>
    );
  }, [channelMessages, currentUser?.id, styles]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <FlatList
        ref={listRef}
        data={channelMessages}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        inverted
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.3}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ margin: 16 }} color={colors.orange} /> : null}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>{t('chat.startConversation')}</Text>
          </View>
        }
      />

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={body}
          onChangeText={setBody}
          placeholder={t('chat.inputPlaceholder')}
          placeholderTextColor={colors.placeholder}
          multiline
          maxLength={2000}
          returnKeyType="default"
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!body.trim() || sending) && styles.sendBtnDisabled]}
          onPress={() => { void handleSend(); }}
          disabled={!body.trim() || sending}
          activeOpacity={0.8}
        >
          {sending
            ? <ActivityIndicator size="small" color="#fff" />
            : <Send size={18} color="#fff" strokeWidth={2} />}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  list: { paddingHorizontal: 12, paddingVertical: 8 },
  bubble: { marginVertical: 2 },
  bubbleMine: { alignItems: 'flex-end' },
  bubbleOther: { alignItems: 'flex-start' },
  senderName: { fontSize: 12, color: c.amber, fontWeight: '600', marginBottom: 3, marginLeft: 4 },
  bubbleInner: {
    maxWidth: '78%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8,
    flexDirection: 'row', alignItems: 'flex-end', gap: 6, flexWrap: 'wrap',
  },
  bubbleInnerMine: { backgroundColor: c.orange, borderBottomRightRadius: 4 },
  bubbleInnerOther: { backgroundColor: c.bgPanel, borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 15, color: c.text1, lineHeight: 20, flexShrink: 1 },
  bubbleTextMine: { color: '#fff' },
  bubbleTime: { fontSize: 11, color: c.textMuted, alignSelf: 'flex-end' },
  bubbleTimeMine: { color: 'rgba(255,255,255,0.7)' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyText: { color: c.textMuted, fontSize: 14 },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    backgroundColor: c.bgPanel, paddingHorizontal: 12, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: c.border, gap: 8,
  },
  input: {
    flex: 1, minHeight: 40, maxHeight: 120,
    backgroundColor: c.bg, borderRadius: 20, borderWidth: 1,
    borderColor: c.border, paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 15, color: c.text1,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: c.orange, alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: c.skeleton },
});
