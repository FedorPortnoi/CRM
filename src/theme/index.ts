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
 * Type scale. Seven steps replacing the eighteen ad-hoc sizes in use;
 * each maps onto the size that was already most common for that role.
 */
export const type = {
  display:  { fontSize: 26, fontWeight: '700', lineHeight: 32 },
  title:    { fontSize: 20, fontWeight: '700', lineHeight: 26 },
  subtitle: { fontSize: 18, fontWeight: '700', lineHeight: 24 },
  heading:  { fontSize: 16, fontWeight: '700', lineHeight: 22 },
  body:     { fontSize: 14, fontWeight: '500', lineHeight: 20 },
  label:    { fontSize: 13, fontWeight: '600', lineHeight: 18 },
  caption:  { fontSize: 12, fontWeight: '600', lineHeight: 16 },
  micro:    { fontSize: 11, fontWeight: '600', lineHeight: 14 },
} as const;

/**
 * Control heights. Buttons, inputs, selects and chips must agree on these
 * or rows of mixed controls sit at different heights.
 */
export const control = {
  sm: 36,
  md: 52,
} as const;

export type ThemeColors = typeof dark;
export type ThemeName = 'dark' | 'light';
export type Spacing = keyof typeof spacing;
export type Radius = keyof typeof radius;
export type TypeStep = keyof typeof type;
export type Control = keyof typeof control;
