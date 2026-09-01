import React, { useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ListRenderItemInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Users } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { useChatStore } from '../../store/chatStore';
import { API_URL } from '../../utils/api';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { EmptyState, Skeleton } from '../../components/ui';

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

/** Loading placeholder shaped like a real member row. */
function SkeletonRow({ styles }: { styles: ReturnType<typeof makeStyles> }): JSX.Element {
  return (
    <View style={styles.row}>
      <Skeleton width={46} height={46} rounded={radius.xl} />
      <View style={styles.info}>
        <Skeleton width="45%" height={15} />
        <Skeleton width="30%" height={13} style={styles.skeletonEmail} />
      </View>
    </View>
  );
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
        <View style={styles.list}>
          {Array.from({ length: 8 }, (_, i) => <SkeletonRow key={i} styles={styles} />)}
        </View>
      ) : isError ? (
        <EmptyState
          icon={<AlertCircle size={40} color={colors.danger} strokeWidth={1.6} />}
          title={t('chat.membersLoadError')}
          actionLabel={t('common.retry')}
          onAction={() => { void refetch(); }}
        />
      ) : (
          <FlatList
            data={members ?? []}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            ListHeaderComponent={<Text style={styles.header}>{t('chat.selectMember')}</Text>}
            ListEmptyComponent={isSuccess ? (
              <EmptyState
                icon={<Users size={44} color={colors.skeleton} strokeWidth={1.5} />}
                title={t('chat.noDmMembersTitle')}
                description={t('chat.noDmMembersBody')}
              />
            ) : null}
          />
      )}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  list: { flexGrow: 1, paddingVertical: spacing.sm },
  header: { ...type.caption, color: c.textMuted, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.surface, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: c.border, gap: spacing.md,
  },
  avatar: {
    width: 46, height: 46, borderRadius: radius.xl,
    backgroundColor: c.amber, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { ...type.subtitle, color: c.onAccent },
  info: { flex: 1 },
  skeletonEmail: { marginTop: spacing.sm },
  name: { ...type.heading, color: c.text1 },
  email: { ...type.label, color: c.textMuted, marginTop: spacing.xs },
});
