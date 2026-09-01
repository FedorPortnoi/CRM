import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
  ListRenderItemInfo,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Send } from 'lucide-react-native';
import { useChatStore, ChatMessage } from '../../store/chatStore';
import { useUserStore } from '../../store/userStore';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type, tabular } from '../../theme';
import { EmptyState } from '../../components/ui';

// TODO(i18n): hardcoded 'ru-RU' locale — English users see Russian month names and a
// day/month order that does not follow their locale. See report for the full inventory.
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
        ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.accent} style={styles.footer} /> : null}
        ListEmptyComponent={
          <EmptyState
            icon={<MessageSquare size={48} color={colors.skeleton} strokeWidth={1.5} />}
            title={t('chat.startConversation')}
          />
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
          activeOpacity={0.7}
        >
          {sending
            ? <ActivityIndicator size="small" color={colors.onAccent} />
            : <Send size={18} color={colors.onAccent} strokeWidth={2} />}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  list: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, flexGrow: 1 },
  footer: { margin: spacing.lg },
  bubble: { marginVertical: spacing.xs / 2 },
  bubbleMine: { alignItems: 'flex-end' },
  bubbleOther: { alignItems: 'flex-start' },
  senderName: { ...type.caption, color: c.amber, marginBottom: spacing.xs, marginLeft: spacing.xs },
  bubbleInner: {
    maxWidth: '78%', borderRadius: radius.xl, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs, flexWrap: 'wrap',
  },
  bubbleInnerMine: { backgroundColor: c.accent, borderBottomRightRadius: 4 },
  bubbleInnerOther: { backgroundColor: c.surface, borderBottomLeftRadius: 4 },
  bubbleText: { ...type.body, color: c.text1, flexShrink: 1 },
  bubbleTextMine: { color: c.onAccent },
  bubbleTime: { ...type.micro, color: c.textMuted, alignSelf: 'flex-end', ...tabular },
  bubbleTimeMine: { color: 'rgba(255,255,255,0.7)' }, // fixed: translucent onAccent, white in both themes
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    backgroundColor: c.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderTopWidth: 1, borderTopColor: c.border, gap: spacing.sm,
  },
  input: {
    flex: 1, minHeight: 40, maxHeight: 120,
    backgroundColor: c.inputBg, borderRadius: radius.xxl, borderWidth: 1,
    borderColor: c.inputBorder, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    ...type.body, color: c.text1,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: radius.xxl,
    backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: c.skeleton },
});
