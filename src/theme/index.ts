export const dark = {
  bg:           '#0E0E0D',
  bgDark:       '#111110',
  bgPanel:      '#1A1A18',
  text1:        '#E8E0D4',
  wheat:        '#EBDBBC',
  amber:        '#D4A27F',
  orange:       '#CC785C',
  red:          '#CC5247',
  border:       'rgba(232,224,212,0.08)',
  borderStrong: 'rgba(232,224,212,0.15)',
  textMuted:    'rgba(232,224,212,0.35)',
  textFaint:    'rgba(232,224,212,0.22)',
  inputBg:      '#1A1A18',
  inputBorder:  'rgba(232,224,212,0.12)',
  placeholder:  'rgba(232,224,212,0.3)',
  skeleton:     'rgba(232,224,212,0.08)',
  overlay:      'rgba(14,14,13,0.7)',
};

export const light = {
  bg:           '#FFFFFF',
  bgDark:       '#2B2724',
  bgPanel:      '#FFFFFF',
  text1:        '#383432',
  wheat:        '#E8DDD6',
  amber:        '#B07868',
  orange:       '#C45A10',
  red:          '#dc2626',
  border:       '#E8DDD6',
  borderStrong: '#CFADA3',
  textMuted:    '#B07868',
  textFaint:    '#CFADA3',
  inputBg:      '#FFFFFF',
  inputBorder:  '#E8DDD6',
  placeholder:  '#CFADA3',
  skeleton:     '#E8DDD6',
  overlay:      'rgba(0,0,0,0.5)',
};

export type ThemeColors = typeof dark;
export type ThemeName = 'dark' | 'light';
