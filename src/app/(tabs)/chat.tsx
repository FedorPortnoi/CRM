import React, { useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ListRenderItemInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Users } from 'lucide-react-native';
import { useChatStore, Channel } from '../../store/chatStore';
import { useUserStore } from '../../store/userStore';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type, control } from '../../theme';
import { Badge, Button, EmptyState, Skeleton } from '../../components/ui';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'сейчас';
  if (mins < 60) return `${mins} мин`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ч`;
  return `${Math.floor(hrs / 24)} д`;
}

/** Loading placeholder shaped like a real channel row. */
function SkeletonRow({ styles }: { styles: ReturnType<typeof makeStyles> }): JSX.Element {
  return (
    <View style={styles.row}>
      <Skeleton width={46} height={46} rounded={radius.xl} />
      <View style={styles.info}>
        <Skeleton width="45%" height={15} />
        <Skeleton width="75%" height={13} style={styles.skeletonPreview} />
      </View>
    </View>
  );
}

export default function ChatListScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
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
            ? <Users size={20} color={colors.onAccent} strokeWidth={2} />
            : <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>}
        </View>
        <View style={styles.info}>
          <View style={styles.infoTop}>
            <View style={styles.nameLine}>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              {!isGeneral && <Badge label={t('chat.privatePill')} />}
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
  }, [t, handleOpen, styles, colors.onAccent]);

  if (loadingChannels && channels.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.list}>
          {Array.from({ length: 7 }, (_, i) => <SkeletonRow key={i} styles={styles} />)}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={channels}
        keyExtractor={(item) => item.channel}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, styles.listPad]}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <EmptyState
            icon={<MessageSquare size={48} color={colors.skeleton} strokeWidth={1.5} />}
            title={t('chat.emptyTitle')}
            description={t('chat.emptySub')}
          />
        }
      />

      {/* Bottom action bar: one primary action, one secondary. */}
      <View style={styles.actionBar}>
        <View style={styles.actionSlot}>
          <Button
            title={t('chat.openGeneral')}
            onPress={openGeneral}
            block
            icon={<Users size={16} color={colors.onAccent} strokeWidth={2.5} />}
          />
        </View>
        <View style={styles.actionSlot}>
          <Button
            title={t('chat.newDm')}
            onPress={openNewDm}
            variant="secondary"
            block
            icon={<MessageSquare size={16} color={colors.text1} strokeWidth={2.5} />}
          />
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  list: { paddingVertical: spacing.sm },
  listPad: { paddingBottom: control.md * 2 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.surface, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: c.border, gap: spacing.md,
  },
  avatar: {
    width: 46, height: 46, borderRadius: radius.xl,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarGeneral: { backgroundColor: c.accent },
  avatarDm: { backgroundColor: c.amber },
  avatarText: { ...type.subtitle, color: c.onAccent },
  info: { flex: 1 },
  skeletonPreview: { marginTop: spacing.sm },
  infoTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  nameLine: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: spacing.sm },
  name: { ...type.heading, fontWeight: '600', color: c.text1 },
  time: { ...type.caption, color: c.textMuted, marginLeft: spacing.sm, fontVariant: ['tabular-nums'] },
  preview: { ...type.label, fontWeight: '500', color: c.amber },
  previewHint: { color: c.textMuted, fontStyle: 'italic' },
  badge: {
    backgroundColor: c.accent, borderRadius: radius.pill,
    minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xs,
  },
  badgeText: { ...type.micro, color: c.onAccent, fontWeight: '700', fontVariant: ['tabular-nums'] },
  actionBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', gap: spacing.md,
    backgroundColor: c.surface, paddingHorizontal: spacing.lg, paddingTop: spacing.md,
    borderTopWidth: 1, borderTopColor: c.border,
    paddingBottom: spacing.xl,
  },
  actionSlot: { flex: 1 },
});
