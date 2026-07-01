# Session Log — 2026-06-20 (Part 3): Splash Screen Fix + iOS v1.0.3

## Goal
Replace the old green bar-chart "CRM / Mobile sales workspace" splash screen (visible in App Store build 16) with the correct orange cube branding.

## Root Cause
`assets/splash.png` still contained the original green logo from the very first prototype. The file had never been updated after the rebrand to the orange 4КУБ cube identity. `app.json` correctly pointed to `./assets/splash.png` with `backgroundColor: "#0A0A0A"` — the config was fine, the asset was wrong.

## Fix

### Splash asset replaced
- **Old**: `assets/splash.png` — green gradient background, white bar-chart icon, "CRM / Mobile sales workspace" text
- **New**: copied `assets/source/icon-source.png` → `assets/splash.png`
  - Higher-resolution source image of the orange cube
  - Dark/black background matches `backgroundColor: "#0A0A0A"` in app.json seamlessly
  - `resizeMode: "contain"` centers it on the dark screen — no config changes needed

### No app.json changes needed
Path stays `"image": "./assets/splash.png"`. Only the file content changed.

## Commits

| Commit | Description |
|--------|-------------|
| `2ff7372` | `fix: replace old green splash logo with orange cube branding` |
| `f9c3105` | `chore: bump version to 1.0.3 for App Store resubmission` |

## Build History This Session

### Build 18 — v1.0.2 (REJECTED by Apple)
- EAS build ID: `860c7feb-55ae-40be-962b-7e7fa50b7030`
- Submitted, then rejected with:
  - `ITMS-90186`: train 1.0.2 closed for new builds
  - `ITMS-90062`: CFBundleShortVersionString must be higher than approved 1.0.2
- **Root cause**: Build 16 (v1.0.2) had already been approved by Apple, closing the 1.0.2 train permanently. Must bump `expo.version`, not just `buildNumber`.

### Build 19 — v1.0.3 ✅ LIVE IN APP STORE CONNECT
- EAS build ID: `8aacd3d3-2afd-422f-8cb6-184900488290`
- EAS submission ID: `71937799-85b6-4e8b-a692-fc8e01da0bc3`
- Version: `1.0.3`, buildNumber: `19` (auto-incremented by EAS from 18)
- Submitted to App Store Connect — processing complete, build confirmed in ASC
- **Ready to attach to 1.0.3 version and submit for review**

## GOTCHA (recurring — add to pre-build checklist)
Once Apple approves a version (e.g. 1.0.2), that train is permanently closed.
**You cannot submit new builds to an approved version.**
Fix: bump `expo.version` in `app.json` (e.g. 1.0.2 → 1.0.3). Bumping only `buildNumber` is NOT enough.
This also happened: 1.0.0 → 1.0.1 (builds 12/13 were wasted the same way).

## Next Steps
1. In App Store Connect: create new version **1.0.3**
2. Attach build 19
3. Re-enter "What's New" text (1.0.2 text does not carry over):
   - Новая навигация: быстрый доступ к задачам, контактам и сделкам
   - Задачи переведены на русский язык
   - Автоматическое связывание задач с контактами
   - Обновлён экран загрузки
4. Submit for review (Manual Release)

## Files Changed
- `assets/splash.png` — replaced with orange cube branding
- `app.json` — `version` bumped `1.0.2` → `1.0.3`; `buildNumber` auto-updated `18` → `19` by EAS
