import React from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MoreVertical, ChevronRight, Check } from 'lucide-react-native';

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
  cream: '#F7F1EC',
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
            <Text numberOfLines={1} style={styles.activityValue}>
              {contact.activityLabel}
            </Text>
          </>
        ) : null}
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
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '500',
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
