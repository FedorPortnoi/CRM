import React from 'react';
import {
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { MoreVertical, ChevronRight, Check, Phone } from 'lucide-react-native';

export type ContactCardType = 'customer' | 'partner' | 'lead' | 'other';

export type ContactCardData = {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  type: ContactCardType;
  typeLabel: string;
  avatarUrl?: string | null;
  initials: string;
  avatarColor: string;
  activityLabel?: string | null;
  activityDaysAgo?: number | null;   // raw day count for color coding
  activeDealsCount?: number | null;  // count of open deals
};

type ContactCardProps = {
  contact: ContactCardData;
  onPress: () => void;
  onLongPress: () => void;
  onMenuPress: () => void;
  selectionMode: boolean;
  selected: boolean;
  disabled?: boolean;
  activityCaption: string;
};

const COLORS = {
  lightCream: '#E8DDD6',
  burntOrange: '#C45A10',
  charcoal: '#333333',
  white: '#FFFFFF',
  black: '#161412',
  textMuted: '#6F625D',
  cardBorder: '#EEE5DF',
  green: '#2F9B61',
  greenSoft: '#EEF7F0',
  blue: '#2D8CDE',
  blueSoft: '#EFF6FD',
  neutral: '#8A7D76',
  neutralSoft: '#F1EBE6',
} as const;

const TYPE_COLORS: Record<ContactCardType, { main: string; soft: string }> = {
  customer: { main: COLORS.burntOrange, soft: 'rgba(196, 90, 16, 0.10)' },
  partner: { main: COLORS.green, soft: COLORS.greenSoft },
  lead: { main: COLORS.blue, soft: COLORS.blueSoft },
  other: { main: COLORS.neutral, soft: COLORS.neutralSoft },
};

function getRuDealsLabel(count: number): string {
  const n = Math.abs(count);
  const lastTwo = n % 100;
  const lastOne = n % 10;
  if (lastTwo >= 11 && lastTwo <= 19) return `${count} сделок`;
  if (lastOne === 1) return `${count} сделка`;
  if (lastOne >= 2 && lastOne <= 4) return `${count} сделки`;
  return `${count} сделок`;
}

function getActivityColor(daysAgo: number | null | undefined): string {
  if (daysAgo == null) return COLORS.textMuted;
  if (daysAgo <= 7) return '#16a34a';
  if (daysAgo <= 30) return '#d97706';
  return '#dc2626';
}

function ContactCardComponent({
  contact,
  onPress,
  onLongPress,
  onMenuPress,
  selectionMode,
  selected,
  disabled,
  activityCaption,
}: ContactCardProps): JSX.Element {
  const typeColors = TYPE_COLORS[contact.type];
  const activityColor = getActivityColor(contact.activityDaysAgo);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.card,
        selected && styles.cardSelected,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.statusStrip, { backgroundColor: typeColors.main }]} />

      <View style={styles.avatarWrap}>
        {selectionMode ? (
          <View style={[styles.checkbox, selected ? styles.checkboxSelected : styles.checkboxEmpty]}>
            {selected ? <Check size={20} color={COLORS.white} strokeWidth={3} /> : null}
          </View>
        ) : contact.avatarUrl ? (
          <Image source={{ uri: contact.avatarUrl }} style={styles.avatarImage} />
        ) : (
          <View style={[styles.avatarFallback, { backgroundColor: contact.avatarColor }]}>
            <Text style={styles.avatarInitials}>{contact.initials}</Text>
          </View>
        )}
      </View>

      <View style={styles.info}>
        <Text numberOfLines={1} style={styles.name}>
          {contact.name}
        </Text>
        {contact.company ? (
          <Text numberOfLines={1} style={styles.company}>
            {contact.company}
          </Text>
        ) : null}

        <View style={[styles.typePill, { backgroundColor: typeColors.soft }]}>
          <View style={[styles.typeDot, { backgroundColor: typeColors.main }]} />
          <Text numberOfLines={1} style={[styles.typeText, { color: typeColors.main }]}>
            {contact.typeLabel}
          </Text>
        </View>

        {(contact.activeDealsCount ?? 0) > 0 && (
          <View style={styles.dealCountPill}>
            <Text style={styles.dealCountText}>{getRuDealsLabel(contact.activeDealsCount as number)}</Text>
          </View>
        )}
      </View>

      <View style={styles.dealInfo}>
        {contact.phone ? (
          <Text numberOfLines={1} style={styles.phone}>
            {contact.phone}
          </Text>
        ) : null}
        {contact.activityLabel ? (
          <>
            <Text style={styles.activityCaption}>{activityCaption}</Text>
            <Text numberOfLines={1} style={[styles.activityValue, { color: activityColor }]}>
              {contact.activityLabel}
            </Text>
          </>
        ) : null}

        {contact.phone != null && !selectionMode && (
          <View style={styles.messengerRow}>
            <TouchableOpacity
              style={styles.messengerPhoneBtn}
              hitSlop={6}
              onPress={() => Linking.openURL('tel:' + contact.phone)}
            >
              <Phone size={14} color="#383432" />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.messengerWaBtn}
              hitSlop={6}
              onPress={() =>
                Linking.openURL('https://wa.me/' + (contact.phone as string).replace(/\D/g, ''))
              }
            >
              <Text style={styles.messengerWaText}>WA</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.messengerTgBtn}
              hitSlop={6}
              onPress={() =>
                Linking.openURL(
                  'https://t.me/+' + (contact.phone as string).replace(/\D/g, ''),
                )
              }
            >
              <Text style={styles.messengerTgText}>TG</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          hitSlop={10}
          onPress={onMenuPress}
          disabled={disabled}
          style={({ pressed }) => [styles.moreButton, pressed && styles.pressed]}
        >
          <MoreVertical size={20} color={COLORS.textMuted} />
        </Pressable>
        <ChevronRight size={26} color={COLORS.textMuted} />
      </View>
    </Pressable>
  );
}

const ContactCard = React.memo(ContactCardComponent);
export default ContactCard;

const styles = StyleSheet.create({
  card: {
    minHeight: 104,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    backgroundColor: COLORS.white,
    shadowColor: COLORS.charcoal,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.045,
    shadowRadius: 12,
    elevation: 2,
  },
  cardSelected: {
    borderColor: COLORS.burntOrange,
    backgroundColor: '#FEF6F0',
  },
  statusStrip: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
  },
  avatarWrap: {
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  avatarImage: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: COLORS.lightCream,
  },
  avatarFallback: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    color: COLORS.white,
    fontSize: 18,
    fontWeight: '700',
  },
  checkbox: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxEmpty: {
    borderWidth: 2,
    borderColor: '#CFADA3',
    backgroundColor: COLORS.white,
  },
  checkboxSelected: {
    borderWidth: 2,
    borderColor: COLORS.burntOrange,
    backgroundColor: COLORS.burntOrange,
  },
  info: {
    flex: 1.16,
    minWidth: 0,
    paddingVertical: 14,
  },
  name: {
    color: COLORS.black,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  company: {
    marginTop: 4,
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '500',
  },
  typePill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    maxWidth: '100%',
  },
  typeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  typeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  dealCountPill: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(196,90,16,0.08)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 6,
  },
  dealCountText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#C45A10',
  },
  dealInfo: {
    flex: 0.86,
    minWidth: 0,
    paddingVertical: 14,
    paddingLeft: 8,
  },
  phone: {
    color: COLORS.black,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  activityCaption: {
    marginTop: 10,
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '500',
  },
  activityValue: {
    marginTop: 3,
    fontSize: 11,
    fontWeight: '500',
  },
  messengerRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
  },
  messengerPhoneBtn: {
    minWidth: 32,
    height: 26,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#D0C4BC',
  },
  messengerWaBtn: {
    minWidth: 32,
    height: 26,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(37,211,102,0.12)',
    paddingHorizontal: 6,
  },
  messengerWaText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#25d366',
  },
  messengerTgBtn: {
    minWidth: 32,
    height: 26,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,136,204,0.12)',
    paddingHorizontal: 6,
  },
  messengerTgText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0088cc',
  },
  actions: {
    width: 34,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    marginRight: 10,
  },
  moreButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.72,
  },
});
