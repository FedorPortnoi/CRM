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
import { ThemeColors } from '../theme';

const RADIUS_OPTIONS = [1000, 3000, 5000, 10000, 25000, 50000, 100000] as const;
const DEFAULT_RADIUS_M = 5000;
const RESULT_LIMIT = 50;
const LOCATION_TIMEOUT_MS = 12000;
const LAST_KNOWN_MAX_AGE_MS = 5 * 60 * 1000;

const AVATAR_COLORS = ['#CC785C', '#6366f1', '#D4A27F', '#CC5247', '#8b5cf6', '#0ea5e9'];

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
      <View style={styles.stateIcon}>
        <MapPin size={22} color={colors.orange} />
      </View>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateMessage}>{message}</Text>
      {primaryLabel && onPrimary ? (
        <TouchableOpacity style={styles.statePrimary} onPress={onPrimary} accessibilityRole="button">
          <Text style={styles.statePrimaryText}>{primaryLabel}</Text>
        </TouchableOpacity>
      ) : null}
      {secondaryLabel && onSecondary ? (
        <TouchableOpacity style={styles.stateSecondary} onPress={onSecondary} accessibilityRole="button">
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
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.cardMain}
        onPress={() => { router.push({ pathname: '/contact/[id]', params: { id: contact.id } }); }}
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${distanceLabel}`}
        activeOpacity={0.8}
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
            <View style={styles.typePill}>
              <Text style={styles.typePillText}>{typeLabel}</Text>
            </View>
            {contact.active_deals_count > 0 ? (
              <View style={styles.dealsPill}>
                <Text style={styles.dealsPillText}>
                  {t('nearby.activeDeals', { count: contact.active_deals_count })}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.cardMeta} numberOfLines={1}>{lastContacted}</Text>
        </View>

        <View style={styles.distanceBox}>
          <Navigation
            size={16}
            color={colors.orange}
            style={{ transform: [{ rotate: `${contact.bearing_degrees}deg` }] }}
            accessibilityLabel={t('nearby.bearing')}
          />
          <Text style={styles.distanceText}>{distanceLabel}</Text>
          <ChevronRight size={18} color={colors.textMuted} />
        </View>
      </TouchableOpacity>

      <TouchableOpacity style={styles.routeButton} onPress={openRoute} accessibilityRole="button">
        <MapPin size={13} color={colors.orange} />
        <Text style={styles.routeButtonText}>{t('nearby.openRoute')}</Text>
      </TouchableOpacity>
    </View>
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

      <View style={styles.controls}>
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
      </View>

      <View style={styles.statusRow}>
        {isBusy ? (
          <>
            <ActivityIndicator size="small" color={colors.orange} />
            <Text style={styles.statusText}>
              {location.kind === 'locating' ? t('nearby.locating') : t('nearby.searching')}
            </Text>
          </>
        ) : contacts.length > 0 ? (
          <Text style={styles.statusText}>{t('nearby.found', { count: contacts.length })}</Text>
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
            >
              {isBusy ? (
                <ActivityIndicator size="small" color={tintColor ?? colors.orange} />
              ) : (
                <RefreshCw size={20} color={tintColor ?? colors.orange} />
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
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={colors.orange} />
        }
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  listContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  subtitle: { fontSize: 13, color: c.amber, marginBottom: 14 },

  controls: {
    backgroundColor: c.bgPanel,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 12,
    paddingLeft: 12,
    gap: 12,
  },
  controlBlock: { gap: 8 },
  controlLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: c.amber,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  controlHint: { fontSize: 11, color: c.textMuted, marginTop: -4 },
  chipRow: { gap: 8, paddingRight: 12 },
  chip: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bg,
    paddingHorizontal: 14,
    paddingVertical: 7,
    minHeight: 34,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: c.orange, borderColor: c.orange },
  chipText: { fontSize: 13, color: c.text1 },
  chipTextActive: { color: '#FFFFFF', fontWeight: '600' },

  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 22,
    marginTop: 14,
    marginBottom: 6,
  },
  statusText: { fontSize: 13, color: c.amber },

  card: {
    backgroundColor: c.bgPanel,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 10,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  cardMain: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  cardInfo: { flex: 1, minWidth: 0 },
  cardName: { fontSize: 15, fontWeight: '700', color: c.text1 },
  cardCompany: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  typePill: {
    backgroundColor: 'rgba(204,120,92,0.10)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typePillText: { fontSize: 11, fontWeight: '600', color: c.orange },
  dealsPill: {
    backgroundColor: 'rgba(212,162,127,0.14)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  dealsPillText: { fontSize: 11, fontWeight: '600', color: c.amber },
  cardMeta: { fontSize: 11, color: c.textMuted, marginTop: 6 },
  distanceBox: { alignItems: 'center', gap: 3, minWidth: 62 },
  distanceText: { fontSize: 13, fontWeight: '700', color: c.orange },

  routeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 38,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  routeButtonText: { fontSize: 12, fontWeight: '600', color: c.orange },

  statePanel: {
    backgroundColor: c.bgPanel,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    padding: 24,
    marginTop: 8,
    alignItems: 'center',
  },
  stateIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(204,120,92,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  stateTitle: { fontSize: 16, fontWeight: '700', color: c.text1, textAlign: 'center' },
  stateMessage: {
    fontSize: 13,
    color: c.textMuted,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: 8,
  },
  statePrimary: {
    marginTop: 18,
    backgroundColor: c.orange,
    borderRadius: 10,
    paddingHorizontal: 20,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statePrimaryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  stateSecondary: { marginTop: 10, paddingHorizontal: 16, minHeight: 38, justifyContent: 'center' },
  stateSecondaryText: { color: c.amber, fontSize: 14, fontWeight: '600' },

  footerNote: {
    fontSize: 11,
    color: c.textMuted,
    textAlign: 'center',
    lineHeight: 16,
    marginTop: 6,
    paddingHorizontal: 8,
  },
});
