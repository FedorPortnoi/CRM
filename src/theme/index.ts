export const dark = {
  bg:           '#0E0E0D',
  bgDark:       '#111110',
  bgPanel:      '#1A1A18',
  text1:        '#E8E0D4',
  wheat:        '#EBDBBC',
  amber:        '#D4A27F',
  orange:       '#CC785C',
  red:          '#D6483C',
  green:        '#5BAF7A',
  border:       'rgba(232,224,212,0.08)',
  borderStrong: 'rgba(232,224,212,0.15)',
  textMuted:    'rgba(232,224,212,0.35)',
  textFaint:    'rgba(232,224,212,0.22)',
  inputBg:      '#1A1A18',
  inputBorder:  'rgba(232,224,212,0.12)',
  placeholder:  'rgba(232,224,212,0.3)',
  skeleton:     'rgba(232,224,212,0.08)',
  overlay:      'rgba(14,14,13,0.7)',

  // Semantic roles. Prefer these in new code — the raw hue names above stay
  // for the screens that already reference them.
  surface:      '#1A1A18',
  surfaceAlt:   '#111110',
  accent:       '#CC785C',
  accentSoft:   'rgba(204,120,92,0.12)',
  onAccent:     '#FFFFFF',
  danger:       '#D6483C',
  dangerSoft:   'rgba(214,72,60,0.12)',
  success:      '#5BAF7A',
  successSoft:  'rgba(91,175,122,0.12)',
  warning:      '#E8A000',
  warningSoft:  'rgba(232,160,0,0.12)',
  neutralSoft:  'rgba(232,224,212,0.06)',
};

export const light: typeof dark = {
  bg:           '#FFFFFF',
  bgDark:       '#2B2724',
  bgPanel:      '#FFFFFF',
  text1:        '#383432',
  wheat:        '#E8DDD6',
  amber:        '#B07868',
  orange:       '#C45A10',
  red:          '#dc2626',
  green:        '#3F8F5B',
  border:       '#E8DDD6',
  borderStrong: '#CFADA3',
  textMuted:    '#B07868',
  textFaint:    '#CFADA3',
  inputBg:      '#FFFFFF',
  inputBorder:  '#E8DDD6',
  placeholder:  '#CFADA3',
  skeleton:     '#E8DDD6',
  overlay:      'rgba(0,0,0,0.5)',

  surface:      '#FFFFFF',
  surfaceAlt:   '#FAF7F5',
  accent:       '#C45A10',
  accentSoft:   'rgba(196,90,16,0.10)',
  onAccent:     '#FFFFFF',
  danger:       '#dc2626',
  dangerSoft:   'rgba(220,38,38,0.10)',
  success:      '#3F8F5B',
  successSoft:  'rgba(63,143,91,0.10)',
  warning:      '#B45309',
  warningSoft:  'rgba(180,83,9,0.10)',
  neutralSoft:  '#F3EEEA',
};

/**
 * Spacing scale. Snapped to the step sizes already dominant in the app
 * (12 / 16 / 8 / 10 lead by a wide margin), so adopting it moves nothing.
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** Corner radii. `lg` (12) is the app's default card/button radius. */
export const radius = {
  sm: 6,
  md: 10,
  lg: 12,
  xl: 16,
  xxl: 20,
  pill: 999,
} as const;

/**
 * Geist (OFL) — embedded natively via the expo-font config plugin in app.json,
 * so the faces are registered before the first frame: no runtime useFonts(),
 * no load gate, and therefore no interaction with the splash sequence.
 *
 * Files are named after each face's POSTSCRIPT name on purpose: Android
 * resolves a font in assets/fonts by FILE BASENAME while iOS resolves by
 * PostScript name, and naming them this way is what makes one fontFamily
 * string resolve identically on both platforms. Renaming these files breaks
 * iOS silently (system-font fallback, no error).
 *
 * Faces are registered under per-weight family names. Pair a face with its
 * matching `fontWeight` and Android renders FAUX BOLD on top of an already
 * bold face, so the `type` steps below pin the family and set
 * `fontWeight: 'normal'`. Spread a type step and DO NOT re-add fontWeight.
 *
 * Verified before adoption: all five faces carry the complete Russian
 * alphabet plus the ruble sign (U+20BD) — this app ships an `ru` locale.
 */
export const fonts = {
  regular:  'Geist-Regular',
  medium:   'Geist-Medium',
  semibold: 'Geist-SemiBold',
  bold:     'Geist-Bold',
  mono:     'GeistMono-Regular',
} as const;

/**
 * Spread onto any style whose digits change in place — money, counts, timers,
 * table columns — so glyph advance stays constant and numbers stop wobbling.
 *
 * Deliberately not `as const`: RN's `TextStyle.fontVariant` is a mutable
 * `FontVariant[]`, and a `readonly` tuple fails every call site with a
 * TS2769 overload error.
 */
export const tabular: { fontVariant: NonNullable<import('react-native').TextStyle['fontVariant']> } = {
  fontVariant: ['tabular-nums'],
};

/**
 * Type scale. Seven steps replacing the eighteen ad-hoc sizes in use;
 * each maps onto the size that was already most common for that role.
 */
export const type = {
  display:  { fontSize: 26, fontWeight: 'normal', lineHeight: 32, fontFamily: fonts.bold },
  title:    { fontSize: 20, fontWeight: 'normal', lineHeight: 26, fontFamily: fonts.bold },
  subtitle: { fontSize: 18, fontWeight: 'normal', lineHeight: 24, fontFamily: fonts.bold },
  heading:  { fontSize: 16, fontWeight: 'normal', lineHeight: 22, fontFamily: fonts.bold },
  body:     { fontSize: 14, fontWeight: 'normal', lineHeight: 20, fontFamily: fonts.medium },
  label:    { fontSize: 13, fontWeight: 'normal', lineHeight: 18, fontFamily: fonts.semibold },
  caption:  { fontSize: 12, fontWeight: 'normal', lineHeight: 16, fontFamily: fonts.semibold },
  micro:    { fontSize: 11, fontWeight: 'normal', lineHeight: 14, fontFamily: fonts.semibold },
  mono:     { fontSize: 13, fontWeight: 'normal', lineHeight: 18, fontFamily: fonts.mono },
} as const;

/**
 * Control heights. Buttons, inputs, selects and chips must agree on these
 * or rows of mixed controls sit at different heights.
 */
export const control = {
  sm: 36,
  md: 52,
} as const;

/**
 * Avatar hue ramp. Indexed by a stable hash of the contact name, so a person
 * keeps the same colour everywhere they appear. Lives here because it is used
 * by more than one screen and silently drifted when it did not.
 */
export const avatarRamp = [
  '#CC785C', // terracotta (accent)
  '#D4A27F', // amber
  '#8A5A3B', // deep brown
  '#B8894B', // ochre
  '#5BAF7A', // green
  '#A34A3C', // brick
] as const;

export type ThemeColors = typeof dark;
export type ThemeName = 'dark' | 'light';
export type Spacing = keyof typeof spacing;
export type Radius = keyof typeof radius;
export type TypeStep = keyof typeof type;
export type Control = keyof typeof control;
export type FontFace = keyof typeof fonts;
