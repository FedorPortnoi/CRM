import { dark, light, ThemeColors } from '../theme';
import { useThemeStore } from '../store/themeStore';

export function useTheme(): { colors: ThemeColors; isDark: boolean; toggle: () => void } {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  return {
    colors: theme === 'dark' ? dark : light,
    isDark: theme === 'dark',
    toggle,
  };
}
