// Email sequences — the list. Owner/admin only (the server enforces it too).
//
// Backend: GET /api/v1/sequences?status=
// i18n:    sequences.*
//
// A row answers the two questions an operator has on a phone: is this sequence running,
// and how many people are currently inside it. The count comes from each sequence's detail
// (see useSequenceSummaries) because the list endpoint does not carry it — the same cache
// entry the detail screen reads, so opening a row is instant.
import React, { useCallback, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronRight, Mail, Plus } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import {
  useSequenceList,
  useSequenceSummaries,
  type Sequence,
  type SequenceStatus,
} from '../../hooks/useSequences';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { Screen, Card, Button, Badge, EmptyState, SkeletonText } from '../../components/ui';
import type { BadgeVariant } from '../../components/ui';

const STATUS_FILTERS: (SequenceStatus | 'all')[] = ['all', 'active', 'draft', 'paused', 'archived'];

const STATUS_LABEL_KEYS: Record<SequenceStatus, string> = {
  draft: 'sequences.statusDraft',
  active: 'sequences.statusActive',
  paused: 'sequences.statusPaused',
  archived: 'sequences.statusArchived',
};

/** Only a running sequence gets the accent colour — everything else reads as parked. */
function statusBadgeVariant(status: SequenceStatus): BadgeVariant {
  if (status === 'active') return 'accent';
  if (status === 'paused') return 'warning';
  return 'neutral';
}

function ListSkeleton(): JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  return (
    <View style={styles.list}>
      {Array.from({ length: 4 }).map((_, index) => (
        <Card key={index} style={styles.card}>
          <SkeletonText lines={2} lastLineWidth="55%" />
        </Card>
      ))}
    </View>
  );
}

export default function SequencesScreen(): JSX.Element {
  const { t } = useTranslation();
  const role = useUserStore((s) => s.user?.role);
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const canManage = role === 'owner' || role === 'admin';

  const [filter, setFilter] = useState<SequenceStatus | 'all'>('all');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const listQuery = useSequenceList(filter, canManage);
  const items: Sequence[] = listQuery.data?.data ?? [];
  const summaries = useSequenceSummaries(items.map((item) => item.id));

  const onRefresh = useCallback((): void => {
    setIsRefreshing(true);
    void queryClient
      .invalidateQueries({ queryKey: ['sequences'] })
      .finally(() => setIsRefreshing(false));
  }, [queryClient]);

  if (!canManage) {
    return (
      <>
        <Stack.Screen options={{ title: t('sequences.title') }} />
        <Screen>
          <Text style={styles.pageTitle}>{t('sequences.title')}</Text>
          <Text style={styles.pageSubtitle}>{t('sequences.subtitle')}</Text>
          <Card style={styles.notice}>
            <Text style={styles.noticeText}>{t('sequences.adminOnly')}</Text>
          </Card>
        </Screen>
      </>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t('sequences.title') }} />

      <View style={styles.intro}>
        <Text style={styles.pageSubtitle}>{t('sequences.subtitle')}</Text>
        <Text style={styles.legalNote}>{t('sequences.consentNote')}</Text>
        <TouchableOpacity
          style={styles.linkRow}
          onPress={() => router.push('/templates' as never)}
          accessibilityRole="button"
          activeOpacity={0.7}
        >
          <Text style={styles.linkText}>{t('sequences.openTemplates')}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterBar}
        contentContainerStyle={styles.filters}
      >
        {STATUS_FILTERS.map((value) => {
          const active = filter === value;
          return (
            <TouchableOpacity
              key={value}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setFilter(value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              activeOpacity={0.7}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {value === 'all' ? t('sequences.filterAll') : t(STATUS_LABEL_KEYS[value])}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {listQuery.isPending ? (
        <ListSkeleton />
      ) : listQuery.isError ? (
        <EmptyState
          icon={<AlertCircle size={32} color={colors.danger} />}
          title={t('sequences.failedToLoad')}
          actionLabel={t('sequences.retry')}
          onAction={() => { void listQuery.refetch(); }}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          extraData={summaries}
          contentContainerStyle={items.length === 0 ? styles.emptyList : styles.list}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              tintColor={colors.accent}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon={<Mail size={32} color={colors.textMuted} />}
              title={t('sequences.empty')}
              description={`${t('sequences.emptyHint')}\n${t('sequences.editHint')}`}
              actionLabel={t('sequences.createFirst')}
              onAction={() => router.push('/sequences/new' as never)}
            />
          }
          renderItem={({ item }) => {
            const summary = summaries[item.id];
            return (
              <Card
                style={styles.card}
                onPress={() => router.push(`/sequences/${item.id}` as never)}
                accessibilityLabel={item.name}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{item.name}</Text>
                  <Badge label={t(STATUS_LABEL_KEYS[item.status])} variant={statusBadgeVariant(item.status)} />
                  <ChevronRight size={18} color={colors.textMuted} strokeWidth={2} />
                </View>

                {item.description ? (
                  <Text style={styles.cardDescription} numberOfLines={2}>{item.description}</Text>
                ) : null}

                <Text style={styles.cardMeta}>
                  {summary
                    ? `${t('sequences.stepCount', { count: summary.steps.length })} · ${t('sequences.activeEnrollments', { count: summary.active_enrollments })}`
                    : t('sequences.countsLoading')}
                </Text>
              </Card>
            );
          }}
        />
      )}

      <Button
        title={t('sequences.create')}
        icon={<Plus size={18} color={colors.onAccent} strokeWidth={2.5} />}
        onPress={() => router.push('/sequences/new' as never)}
        block
        style={styles.createButton}
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  pageTitle: { ...type.title, color: c.text1 },
  pageSubtitle: { ...type.body, color: c.textMuted, lineHeight: 20, marginTop: spacing.xs },
  legalNote: { ...type.caption, color: c.textMuted, lineHeight: 17 },
  intro: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.sm },
  linkRow: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  linkText: { color: c.accent, ...type.body, fontWeight: '700' },
  notice: { marginTop: spacing.lg },
  noticeText: { color: c.textMuted, ...type.body, lineHeight: 20 },
  // flexGrow:0 is load-bearing. This ScrollView is a direct child of `screen`
  // (flex:1) and sits above the list, so without it the horizontal ScrollView
  // claims the leftover vertical space and stretches every chip to ~400px tall.
  // nearby.tsx does not need this only because its chip row is wrapped in a
  // content-sized View. alignItems keeps the chips their natural height.
  filterBar: { flexGrow: 0, flexShrink: 0 },
  filters: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm, alignItems: 'center' },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
  },
  chipActive: { backgroundColor: c.accent, borderColor: c.accent },
  chipText: { color: c.textMuted, ...type.label },
  chipTextActive: { color: c.onAccent },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  emptyList: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  card: {
    marginBottom: spacing.sm,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitle: { flex: 1, ...type.heading, color: c.text1 },
  cardDescription: { marginTop: spacing.sm, ...type.label, color: c.textMuted, lineHeight: 18 },
  cardMeta: { marginTop: spacing.sm, ...type.caption, color: c.textMuted, fontVariant: ['tabular-nums'] },
  createButton: {
    margin: spacing.lg,
  },
});
