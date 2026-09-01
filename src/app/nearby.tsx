// Nearby leads — contacts around the rep's current position, nearest first.
// Backend: GET /api/v1/contacts/nearby?latitude=&longitude=&radius_m=&limit=&type=&status=&scope=
// i18n:    nearby.*
//
// No map is rendered here on purpose: 4КУБ has not chosen a map provider and
// Google Maps is off the table, so the deliverable is a distance-sorted list.
// The one place a map appears is the optional "построить маршрут" hand-off,
// which deep-links into Yandex Карты — a link, not an integration.
//
// The device position is read once per refresh, never stored, and leaves this
// screen only as the two query parameters of the request above. It is part of
// the react-query key, so the key carries the JWT as well to make sure
// shouldDehydrateQuery in utils/queryClient.ts keeps the whole thing out of the
// plaintext AsyncStorage cache.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  ListRenderItemInfo,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router, useFocusEffect } from 'expo-router';
import * as Location from 'expo-location';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, MapPin, Navigation, RefreshCw } from 'lucide-react-native';
import { useUserStore } from '../store/userStore';
import { API_URL } from '../utils/api';
import { formatMarketDate, formatMarketNumber } from '../market/profile';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors, spacing, radius, type, avatarRamp } from '../theme';
import { Card, Badge, EmptyState } from '../components/ui';

const RADIUS_OPTIONS = [1000, 3000, 5000, 10000, 25000, 50000, 100000] as const;
const DEFAULT_RADIUS_M = 5000;
const RESULT_LIMIT = 50;
const LOCATION_TIMEOUT_MS = 12000;
const LAST_KNOWN_MAX_AGE_MS = 5 * 60 * 1000;

// Warm ramp — orange / amber / wheat / muted terracotta / green / warm clay. Keep this in
// sync with the identical array in (tabs)/contacts.tsx (owned separately) so avatar colors
// stay consistent between the two screens.
const AVATAR_COLORS = avatarRamp;

type ContactTypeValue = 'lead' | 'customer' | 'partner' | 'other';
type StatusFilter = 'active' | 'inactive';
type Scope = 'direct' | 'subtree';

type NearbyContact = {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  type: ContactTypeValue | null;
  last_contacted_at: string | null;
  active_deals_count: number;
  latitude: number;
  longitude: number;
  distance_meters: number;
  bearing_degrees: number;
};

type NearbyResponse = {
  data: NearbyContact[];
  meta: { total: number; radius_m: number; limit: number };
};

type Origin = { latitude: number; longitude: number };

type LocationState =
  | { kind: 'locating' }
  | { kind: 'ready'; origin: Origin }
  | { kind: 'denied'; canAskAgain: boolean }
  | { kind: 'unavailable' };

function getInitials(firstName: string, lastName: string | null): string {
  return firstName.charAt(0).toUpperCase() + (lastName ? lastName.charAt(0).toUpperCase() : '');
}

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function normalizeType(type: ContactTypeValue | null): ContactTypeValue {
  return type === 'lead' || type === 'customer' || type === 'partner' ? type : 'other';
}

// ~1 m of precision. Keeps GPS jitter from minting a new query key (and a new
// request) every time the device re-samples while the screen is open.
function roundCoordinate(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('location timeout')), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function samplePosition(): Promise<Origin> {
  const lastKnown = await Location.getLastKnownPositionAsync({
    maxAge: LAST_KNOWN_MAX_AGE_MS,
  }).catch(() => null);

  try {
    const position = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      LOCATION_TIMEOUT_MS,
    );
    return { latitude: position.coords.latitude, longitude: position.coords.longitude };
  } catch (error) {
    if (lastKnown) {
      return { latitude: lastKnown.coords.latitude, longitude: lastKnown.coords.longitude };
    }
    throw error;
  }
}

type ChipOption<T> = { value: T; label: string };

function ChipRow<T extends string | number | undefined>({
  label,
  options,
  selected,
  onSelect,
  colors,
}: {
  label: string;
  options: ChipOption<T>[];
  selected: T;
  onSelect: (value: T) => void;
  colors: ThemeColors;
}): JSX.Element {
  const styles = makeStyles(colors);
  return (
    <View style={styles.controlBlock}>
      <Text style={styles.controlLabel}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        keyboardShouldPersistTaps="handled"
      >
        {options.map((option) => {
          const active = option.value === selected;
          return (
            <TouchableOpacity
              key={String(option.value)}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onSelect(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              activeOpacity={0.7}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

function StatePanel({
  title,
  message,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  colors,
}: {
  title: string;
  message: string;
  primaryLabel?: string;
  onPrimary?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  colors: ThemeColors;
}): JSX.Element {
  const styles = makeStyles(colors);
  return (
    <View style={styles.statePanel} accessibilityLiveRegion="polite">
      <EmptyState
        icon={<MapPin size={22} color={colors.accent} />}
        title={title}
        description={message}
        actionLabel={primaryLabel}
        onAction={onPrimary}
        style={styles.stateEmpty}
      />
      {secondaryLabel && onSecondary ? (
        <TouchableOpacity style={styles.stateSecondary} onPress={onSecondary} accessibilityRole="button" activeOpacity={0.7}>
          <Text style={styles.stateSecondaryText}>{secondaryLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function NearbyRow({
  contact,
  distanceLabel,
  origin,
  colors,
}: {
  contact: NearbyContact;
  distanceLabel: string;
  origin: Origin;
  colors: ThemeColors;
}): JSX.Element {
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  const type = normalizeType(contact.type);
  const typeLabel = t(`contacts.${type}`);
  const lastContacted = contact.last_contacted_at
    ? t('nearby.lastContacted', { date: formatMarketDate(contact.last_contacted_at) })
    : t('nearby.neverContacted');

  const openRoute = useCallback((): void => {
    const from = `${origin.latitude},${origin.longitude}`;
    const to = `${contact.latitude},${contact.longitude}`;
    void Linking.openURL(`https://yandex.ru/maps/?rtext=${from}~${to}&rtt=auto`);
  }, [contact.latitude, contact.longitude, origin.latitude, origin.longitude]);

  return (
    <Card padded={false} style={styles.card}>
      <TouchableOpacity
        style={styles.cardMain}
        onPress={() => { router.push({ pathname: '/contact/[id]', params: { id: contact.id } }); }}
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${distanceLabel}`}
        activeOpacity={0.7}
      >
        <View style={[styles.avatar, { backgroundColor: avatarColor(contact.first_name) }]}>
          <Text style={styles.avatarText}>{getInitials(contact.first_name, contact.last_name)}</Text>
        </View>

        <View style={styles.cardInfo}>
          <Text style={styles.cardName} numberOfLines={1}>{name}</Text>
          {contact.company ? (
            <Text style={styles.cardCompany} numberOfLines={1}>{contact.company}</Text>
          ) : null}
          <View style={styles.pillRow}>
            <Badge label={typeLabel} variant="accent" />
            {contact.active_deals_count > 0 ? (
              <Badge
                label={t('nearby.activeDeals', { count: contact.active_deals_count })}
                variant="neutral"
              />
            ) : null}
          </View>
          <Text style={[styles.cardMeta, styles.tabular]} numberOfLines={1}>{lastContacted}</Text>
        </View>

        <View style={styles.distanceBox}>
          <Navigation
            size={16}
            color={colors.accent}
            style={{ transform: [{ rotate: `${contact.bearing_degrees}deg` }] }}
            accessibilityLabel={t('nearby.bearing')}
          />
          <Text style={[styles.distanceText, styles.tabular]}>{distanceLabel}</Text>
          <ChevronRight size={18} color={colors.textMuted} />
        </View>
      </TouchableOpacity>

      <TouchableOpacity style={styles.routeButton} onPress={openRoute} accessibilityRole="button" activeOpacity={0.7}>
        <MapPin size={13} color={colors.accent} />
        <Text style={styles.routeButtonText}>{t('nearby.openRoute')}</Text>
      </TouchableOpacity>
    </Card>
  );
}

export default function NearbyScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const token = useUserStore((s) => s.token);

  const [location, setLocation] = useState<LocationState>({ kind: 'locating' });
  const [radiusM, setRadiusM] = useState<number>(DEFAULT_RADIUS_M);
  const [typeFilter, setTypeFilter] = useState<ContactTypeValue | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<StatusFilter | undefined>(undefined);
  const [scope, setScope] = useState<Scope>('direct');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const locationKindRef = useRef<LocationState['kind']>('locating');

  useEffect(() => {
    locationKindRef.current = location.kind;
  }, [location.kind]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const resolveLocation = useCallback(async (askIfPossible: boolean): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrent = (): boolean => mountedRef.current && requestIdRef.current === requestId;

    setLocation({ kind: 'locating' });

    try {
      let permission = await Location.getForegroundPermissionsAsync();
      if (askIfPossible && permission.status !== 'granted' && permission.canAskAgain) {
        permission = await Location.requestForegroundPermissionsAsync();
      }
      if (!isCurrent()) return;

      if (permission.status !== 'granted') {
        setLocation({ kind: 'denied', canAskAgain: permission.canAskAgain });
        return;
      }

      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!isCurrent()) return;
      if (!servicesEnabled) {
        setLocation({ kind: 'unavailable' });
        return;
      }

      const origin = await samplePosition();
      if (!isCurrent()) return;
      setLocation({
        kind: 'ready',
        origin: {
          latitude: roundCoordinate(origin.latitude),
          longitude: roundCoordinate(origin.longitude),
        },
      });
    } catch {
      if (isCurrent()) setLocation({ kind: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    void resolveLocation(true);
  }, [resolveLocation]);

  // Coming back from the OS settings screen is the only way a hard denial gets
  // reversed, so re-check on focus — but only then, to avoid a GPS sample on
  // every navigation back to this tab.
  useFocusEffect(
    useCallback(() => {
      if (locationKindRef.current === 'denied') {
        void resolveLocation(false);
      }
      return undefined;
    }, [resolveLocation]),
  );

  const origin = location.kind === 'ready' ? location.origin : null;

  const nearbyQuery = useQuery<NearbyResponse, Error>({
    // The JWT is part of the key on purpose: it makes shouldDehydrateQuery drop
    // this query (contact PII + a live GPS fix) from the persisted cache.
    queryKey: [
      'contacts-nearby',
      origin?.latitude,
      origin?.longitude,
      radiusM,
      typeFilter ?? 'all',
      statusFilter ?? 'default',
      scope,
      token,
    ],
    enabled: Boolean(token) && origin !== null,
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
    queryFn: async (): Promise<NearbyResponse> => {
      if (!token || !origin) throw new Error(t('errors.unauthorized'));

      const params = new URLSearchParams({
        latitude: String(origin.latitude),
        longitude: String(origin.longitude),
        radius_m: String(radiusM),
        limit: String(RESULT_LIMIT),
        scope,
      });
      if (typeFilter) params.set('type', typeFilter);
      if (statusFilter) params.set('status', statusFilter);

      const res = await fetch(`${API_URL}/contacts/nearby?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      return (await res.json()) as NearbyResponse;
    },
  });

  const contacts = nearbyQuery.data?.data ?? [];

  const formatDistance = useCallback((meters: number): string => {
    if (meters < 1000) {
      return t('nearby.distanceMeters', { count: Math.round(meters) });
    }
    const km = meters / 1000;
    return t('nearby.distanceKm', {
      value: formatMarketNumber(km, { maximumFractionDigits: km < 10 ? 1 : 0 }),
    });
  }, [t]);

  const onRefresh = useCallback((): void => {
    setIsRefreshing(true);
    void (async () => {
      await resolveLocation(location.kind === 'denied');
      if (!mountedRef.current) return;
      await nearbyQuery.refetch();
      if (mountedRef.current) setIsRefreshing(false);
    })();
  }, [location.kind, nearbyQuery, resolveLocation]);

  const radiusOptions = useMemo<ChipOption<number>[]>(
    () => RADIUS_OPTIONS.map((meters) => ({
      value: meters,
      label: t('nearby.radiusValue', {
        km: formatMarketNumber(meters / 1000, { maximumFractionDigits: 0 }),
      }),
    })),
    [t],
  );

  const typeOptions = useMemo<ChipOption<ContactTypeValue | undefined>[]>(
    () => [
      { value: undefined, label: t('nearby.filterAll') },
      { value: 'lead', label: t('contacts.lead') },
      { value: 'customer', label: t('contacts.customer') },
      { value: 'partner', label: t('contacts.partner') },
      { value: 'other', label: t('contacts.other') },
    ],
    [t],
  );

  const statusOptions = useMemo<ChipOption<StatusFilter | undefined>[]>(
    () => [
      { value: undefined, label: t('nearby.filterAll') },
      { value: 'active', label: t('contacts.statusActive') },
      { value: 'inactive', label: t('contacts.statusInactive') },
    ],
    [t],
  );

  const scopeOptions = useMemo<ChipOption<Scope>[]>(
    () => [
      { value: 'direct', label: t('nearby.scopeDirect') },
      { value: 'subtree', label: t('nearby.scopeSubtree') },
    ],
    [t],
  );

  const isBusy = location.kind === 'locating' || (origin !== null && nearbyQuery.isPending);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<NearbyContact>): JSX.Element => (
      <NearbyRow
        contact={item}
        distanceLabel={formatDistance(item.distance_meters)}
        origin={origin ?? { latitude: item.latitude, longitude: item.longitude }}
        colors={colors}
      />
    ),
    [colors, formatDistance, origin],
  );

  const listHeader = (
    <View>
      <Text style={styles.subtitle}>{t('nearby.subtitle')}</Text>

      <Card padded={false} style={styles.controls}>
        <ChipRow
          label={t('nearby.radius')}
          options={radiusOptions}
          selected={radiusM}
          onSelect={setRadiusM}
          colors={colors}
        />
        <Text style={styles.controlHint}>{t('nearby.radiusHint')}</Text>
        <ChipRow
          label={t('nearby.filterType')}
          options={typeOptions}
          selected={typeFilter}
          onSelect={setTypeFilter}
          colors={colors}
        />
        <ChipRow
          label={t('nearby.filterStatus')}
          options={statusOptions}
          selected={statusFilter}
          onSelect={setStatusFilter}
          colors={colors}
        />
        <ChipRow
          label={t('nearby.scope')}
          options={scopeOptions}
          selected={scope}
          onSelect={setScope}
          colors={colors}
        />
      </Card>

      <View style={styles.statusRow}>
        {isBusy ? (
          <>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.statusText}>
              {location.kind === 'locating' ? t('nearby.locating') : t('nearby.searching')}
            </Text>
          </>
        ) : contacts.length > 0 ? (
          <Text style={[styles.statusText, styles.tabular]}>{t('nearby.found', { count: contacts.length })}</Text>
        ) : null}
      </View>
    </View>
  );

  const renderEmptyPanel = (): JSX.Element | null => {
    if (location.kind === 'locating') return null;

    if (location.kind === 'denied') {
      return (
        <StatePanel
          title={t('nearby.permissionTitle')}
          message={t('nearby.permissionDenied')}
          primaryLabel={location.canAskAgain ? t('common.retry') : t('nearby.permissionOpenSettings')}
          onPrimary={location.canAskAgain
            ? () => { void resolveLocation(true); }
            : () => { void Linking.openSettings(); }}
          secondaryLabel={location.canAskAgain ? t('nearby.permissionOpenSettings') : undefined}
          onSecondary={location.canAskAgain ? () => { void Linking.openSettings(); } : undefined}
          colors={colors}
        />
      );
    }

    if (location.kind === 'unavailable') {
      return (
        <StatePanel
          title={t('nearby.locationUnavailable')}
          message={t('nearby.locationUnavailableHint')}
          primaryLabel={t('common.retry')}
          onPrimary={() => { void resolveLocation(true); }}
          secondaryLabel={t('nearby.permissionOpenSettings')}
          onSecondary={() => { void Linking.openSettings(); }}
          colors={colors}
        />
      );
    }

    if (nearbyQuery.isPending) return null;

    if (nearbyQuery.isError) {
      return (
        <StatePanel
          title={t('nearby.failedToLoad')}
          message={nearbyQuery.error.message}
          primaryLabel={t('common.retry')}
          onPrimary={() => { void nearbyQuery.refetch(); }}
          colors={colors}
        />
      );
    }

    return (
      <StatePanel
        title={t('nearby.empty')}
        message={t('nearby.emptyHint')}
        primaryLabel={t('nearby.refresh')}
        onPrimary={onRefresh}
        colors={colors}
      />
    );
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: t('nearby.title'),
          headerRight: ({ tintColor }) => (
            <TouchableOpacity
              style={styles.headerButton}
              onPress={onRefresh}
              disabled={isBusy}
              accessibilityRole="button"
              accessibilityLabel={t('nearby.refresh')}
              accessibilityState={{ disabled: isBusy }}
              hitSlop={8}
              activeOpacity={0.7}
            >
              {isBusy ? (
                <ActivityIndicator size="small" color={tintColor ?? colors.accent} />
              ) : (
                <RefreshCw size={20} color={tintColor ?? colors.accent} />
              )}
            </TouchableOpacity>
          ),
        }}
      />

      <FlatList
        data={contacts}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={renderEmptyPanel()}
        ListFooterComponent={contacts.length > 0 ? (
          <Text style={styles.footerNote}>{t('nearby.noCoordinatesHint')}</Text>
        ) : null}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  listContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxl + spacing.sm },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  subtitle: { ...type.body, color: c.textMuted, marginBottom: 14 },
  tabular: { fontVariant: ['tabular-nums'] },

  controls: {
    paddingVertical: spacing.md,
    paddingLeft: spacing.md,
    gap: spacing.md,
  },
  controlBlock: { gap: spacing.sm },
  controlLabel: {
    ...type.micro,
    color: c.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  controlHint: { fontSize: 11, color: c.textMuted, marginTop: -4 },
  chipRow: { gap: spacing.sm, paddingRight: spacing.md },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bg,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    minHeight: 34,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: c.accent, borderColor: c.accent },
  chipText: { fontSize: 13, color: c.text1 },
  chipTextActive: { color: c.onAccent, fontWeight: '600' },

  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 22,
    marginTop: 14,
    marginBottom: spacing.xs,
  },
  statusText: { ...type.body, color: c.textMuted },

  card: {
    marginBottom: spacing.sm,
    overflow: 'hidden',
  },
  cardMain: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: spacing.md },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: c.onAccent, fontSize: 16, fontWeight: '700' },
  cardInfo: { flex: 1, minWidth: 0 },
  cardName: { fontSize: 16, fontWeight: '700', color: c.text1 },
  cardCompany: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  cardMeta: { fontSize: 11, color: c.textMuted, marginTop: spacing.sm },
  distanceBox: { alignItems: 'center', gap: 3, minWidth: 62 },
  distanceText: { fontSize: 13, fontWeight: '700', color: c.accent },

  routeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 38,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  routeButtonText: { fontSize: 12, fontWeight: '600', color: c.accent },

  statePanel: {
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    marginTop: spacing.sm,
  },
  stateEmpty: { paddingVertical: spacing.xl },
  stateSecondary: { alignSelf: 'center', paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, minHeight: 38, justifyContent: 'center' },
  stateSecondaryText: { color: c.textMuted, fontSize: 14, fontWeight: '600' },

  footerNote: {
    fontSize: 11,
    color: c.textMuted,
    textAlign: 'center',
    lineHeight: 16,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
});
