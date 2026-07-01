# Session Log — 2026-06-28: Dark / Light Theme System

## Goal
Refactor the entire 4КУБ CRM app from its original static warm-terracotta color scheme
into a fully dynamic dark/light theme system, toggled from Settings and persisted across
restarts. Dark mode = new coal-and-amber palette. Light mode = original warm parchment
colors. Login screens must remain untouched.

---

## What Was Built

### Theme infrastructure (3 new files)

| File | Purpose |
|------|---------|
| `src/theme/index.ts` | `dark` + `light` palette objects + `ThemeColors` type |
| `src/store/themeStore.ts` | Zustand `persist` store, defaults to `'dark'`, saves to AsyncStorage |
| `src/hooks/useTheme.ts` | `useTheme()` → `{ colors, isDark, toggle }` |

### Dark palette
```
bg: #0E0E0D         bgDark: #111110        bgPanel: #1A1A18
text1: #E8E0D4      wheat: #EBDBBC         amber: #D4A27F
orange: #CC785C     red: #CC5247
border: rgba(232,224,212,0.08)
```

### Light palette
```
bg: #FFFFFF         bgDark: #2B2724        bgPanel: #FFFFFF
text1: #383432      wheat: #E8DDD6         amber: #B07868
orange: #C45A10     red: #dc2626
border: #E8DDD6
```

### Screen conversion

All 50+ screens and components converted from static `StyleSheet.create({})` at module
level to `const makeStyles = (c: ThemeColors) => StyleSheet.create({...})` called inside
the component after `const { colors } = useTheme(); const styles = makeStyles(colors);`.

**Protected (never touched):**
- `src/screens/LoginScreen.tsx`
- `src/app/login.tsx`

### Settings toggle

`src/app/(tabs)/settings.tsx` → "ВНЕШНИЙ ВИД" section with a Switch row:
- Toggle ON = dark mode (orange switch)
- Toggle OFF = light mode (gray switch)
- Preference persists via AsyncStorage (survives app kills and reboots)

### Bug fix: white strip at top of dashboard

`src/components/SyncStatusBar.tsx` was in flex layout flow with `opacity: 0`, occupying
~28 px of vertical space and pushing NavHeader down — producing a visible white strip under
the status bar when `edgeToEdgeEnabled: true`. Fixed by making it `position: 'absolute'`
with `top: insets.top` (commit `34d92d4`, earlier session).

### i18n additions

| Key | RU | EN |
|-----|----|----|
| `settings.appearance` | Внешний вид | Appearance |
| `settings.darkTheme` | Тёмная тема | Dark theme |

---

## Commits This Session

| Commit | Description |
|--------|-------------|
| `34d92d4` | `fix: make SyncStatusBar position absolute to remove white strip` |
| `21b488a` | `Add dark/light theme system with persistent toggle` |

**Pushed to:** `origin/main` (`github.com/FedorPortnoi/CRM`)

---

## Verified on Pixel 8 Emulator

| State | Result |
|-------|--------|
| App launch → dark mode default | ✅ Coal/amber dashboard |
| Settings → toggle OFF | ✅ White/parchment dashboard, instant |
| Settings → toggle ON | ✅ Returns to dark, instant |
| App kill + reopen | ✅ Preference restored from AsyncStorage |
| Login screen | ✅ Unchanged (original orange/warm branding) |
| No white strip at top of dashboard | ✅ Fixed |

---

## Next Steps

- Remaining unconverted screens (import/*, workflows, etc.) will pick up theme through
  the shared infrastructure; minor cleanup pass may be needed for any hardcoded colors.
- Consider building a new EAS dev-client APK so the theme ships in the next TestFlight/
  Play Store release.
