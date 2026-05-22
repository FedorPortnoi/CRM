# EAS Build Guide - CRM Mobile App

## Prerequisites

- Node.js 18+
- Install EAS CLI: npm install -g eas-cli --legacy-peer-deps
- Log in: eas login (use Expo account: **fedorportnoi**)
- Ensure eas.json is committed and app.json has owner: fedorportnoi
- Set `EXPO_PUBLIC_API_URL` as an EAS environment variable for preview and production. It must be the real HTTPS API URL ending in `/api/v1`; `app.config.js` rejects missing or placeholder deployment URLs.

## Build Commands

### iOS (App Store)

eas build --platform ios --profile production


### Android (Google Play - AAB)

eas build --platform android --profile production


### Android (RuStore - APK)
Use the preview profile to produce a plain APK, then upload manually:

eas build --platform android --profile preview

Upload at: https://rustore.ru/developers

## Submit Commands

### iOS App Store

eas submit --platform ios


### Google Play

eas submit --platform android


RuStore does **not** support automated EAS submit - upload the APK manually via the developer portal above.

## Placeholders - Fill Before First Build

| Key | File | What to put |
|-----|------|-------------|
| PLACEHOLDER_APP_STORE_CONNECT_APP_ID | eas.json | Numeric App ID from App Store Connect > My Apps > App Information |
| PLACEHOLDER_APPLE_TEAM_ID | eas.json | 10-char Team ID from developer.apple.com/account > Membership |
| ./google-play-service-account.json | project root | Service account JSON from Google Play Console > Setup > API access |

## Asset Checklist

Confirm these assets are still production-ready before triggering a production build:

- assets/icon.png - must be **1024 x 1024 px** PNG, no transparency
- assets/adaptive-icon.png - must be **1024 x 1024 px** PNG
- assets/splash.png - production splash screen image

For the complete launch gate, use `docs/predeloyment-protocol.md`.

## Notes

- autoIncrement: true in the production profile lets EAS bump buildNumber / versionCode automatically.
- Development build with a connected device: eas build --platform android --profile development
- Target launch: Sep/Oct 2026 - plan Apple developer enrollment and Google Play registration early.
