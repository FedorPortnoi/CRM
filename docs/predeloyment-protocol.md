# Predeployment Protocol

This protocol is the final gate before shipping the CRM mobile app and APIs. The product should not be considered deployment-ready until every required item below is complete, verified, and recorded in the release notes.

## 1. Scope

Use this protocol for:

- API deployment readiness.
- Mobile build readiness.
- Store submission readiness.
- Real-device validation.
- External service credential checks.

The app code can be considered complete only when the remaining open items are deployment credentials, provider configuration, or environment-specific API URLs.

## 2. API Predeployment Gates

Required before deploying any API environment:

- `DATABASE_URL` points to the intended database environment.
- `DIRECT_URL` is set for Prisma migrations when the provider requires a direct connection.
- Yandex PostgreSQL SSL is configured with either `sslrootcert=` in `DATABASE_URL` or `PGSSLROOTCERT`.
- Prisma migrations have been applied with:

```bash
npm run db:deploy
```

- Prisma client has been generated after schema changes:

```bash
npm run db:generate
```

- The production API starts from compiled JavaScript, not the TypeScript watch server:

```bash
npm run backend:build
npm run backend:start
```

- API env vars are present for enabled integrations:
  - `JWT_SECRET`
  - `SMSRU_API_ID`
  - `SMSRU_SENDER`
  - `YANDEX_CLIENT_ID`
  - `YANDEX_CLIENT_SECRET`
  - `YANDEX_CALENDAR_SUCCESS_URL`
  - `YANDEX_API_KEY`
  - `YANDEX_FOLDER_ID`
  - `EXPO_ACCESS_TOKEN` or the hosting-provider equivalent for push operations, if needed.

- Tenant isolation is verified for every Prisma query touching org data:
  - use `organization_id: request.user.org_id`, or
  - use `org_id` for `PendingCapture`.

- API responses still follow the envelope:
  - success single: `{ data: {...}, meta: {} }`
  - success list: `{ data: [...], meta: { total, page, per_page } }`
  - error: `{ error: { code, message } }`

## 3. API Verification Commands

Run these from the repo root:

```bash
npx tsc --noEmit -p backend/tsconfig.json
npm run typecheck
npm run test:unit
SMOKE_DATABASE_URL=postgresql://..._smoke... npx playwright test --workers=1
```

Required result:

- backend TypeScript: 0 errors.
- full app TypeScript: 0 errors.
- unit tests: all pass.
- smoke tests: all pass.

Last known clean baseline:

- `npm run typecheck` passed.
- `npx tsc --noEmit -p backend/tsconfig.json` passed.
- `npm run test:unit` passed with 23 tests.
- `npx playwright test --workers=1` passed with 1343 tests.

## 4. Mobile Runtime Configuration

Required before production build:

- `APP_ENV=production` is set by the EAS production profile.
- `EXPO_PUBLIC_API_URL` is set in EAS/CI for staging and production.
- `app.config.js` resolves `extra.apiUrl` from `EXPO_PUBLIC_API_URL` for staging and production.
- `app.config.js` fails staging/production builds when `EXPO_PUBLIC_API_URL` is missing, local, non-HTTPS, not under `/api/v1`, or a known placeholder.
- `app.json` does not contain baked staging or production API domains.
- Staging builds point to staging APIs only.
- Development builds can use local or LAN URLs, but those values must not leak into production builds.

Production API URL checklist:

- Uses HTTPS.
- Ends with `/api/v1`.
- Does not contain localhost, `127.0.0.1`, LAN IPs, or placeholder Railway domains.
- Health endpoint is reachable at `/health`.
- Auth login and registration are reachable from a physical device over cellular data.

## 5. Store Credential Gates

These are not code tasks, but deployment is blocked until they exist:

- Fill `eas.json` iOS submit values:
  - `ascAppId`
  - `appleTeamId`
- Create `google-play-service-account.json` at the project root from Google Play Console.
- Confirm the Expo account has access to:
  - Apple Developer team.
  - App Store Connect app.
  - Google Play Console app.
  - EAS project owner `fedorportnoi`.
- Confirm app identifiers:
  - iOS bundle ID: `com.fedorportnoi.crm`
  - Android package: `com.fedorportnoi.crm`

## 6. Mobile Asset Gates

Required before production build:

- `assets/icon.png` is a real 1024x1024 PNG.
- `assets/adaptive-icon.png` is a real 1024x1024 PNG.
- `assets/splash.png` is a real splash image.
- `assets/favicon.png` is not a placeholder.
- App Store and Play Store screenshots are generated from the current UI.
- Store copy matches implemented behavior.
- Privacy policy links are final.

## 7. Real-Device Validation

Run on at least one iOS device and one Android device:

- Language selection.
- Registration.
- Login.
- Onboarding.
- Dashboard load.
- Contacts create/edit/search/import/scan.
- Deals create/edit/detail/Kanban move.
- Tasks create/edit/complete/recurring task display.
- Calendar create/edit/detail/Yandex sync card.
- Settings export contacts PDF.
- Settings export deals PDF.
- Offline create/edit queue behavior.
- Background sync after reconnect.
- Push notification permission denied path.
- Push notification permission granted path.
- Camera denied path.
- Camera capture path.
- Image library business card scan path.
- SMS/call capture flows available in the current platform limits.

Every failed validation must be linked to an issue before release approval.

## 8. External Provider Checks

Before enabling provider-backed production features:

- SMS.ru:
  - `SMSRU_API_ID` is set.
  - `SMSRU_SENDER` is approved or falls back safely.
  - Test SMS send succeeds in production-like environment.

- Yandex Calendar:
  - OAuth app redirect URI matches `/api/v1/calendar/sync/yandex/callback`.
  - `YANDEX_CLIENT_ID` and `YANDEX_CLIENT_SECRET` are set.
  - Connect, disconnect, and status flows work from the mobile app.

- Yandex Vision/SpeechKit:
  - API key and folder ID are set.
  - Business card scan returns extracted fields.
  - Voice transcription returns transcript or documented service-not-configured error.

- Push notifications:
  - Expo push tokens register successfully.
  - No-token sends return stable `NO_PUSH_TOKEN`.
  - Cross-org sends return `USER_NOT_FOUND`.
  - Duplicate token handling remains org-scoped.

## 9. Rollback Requirements

Before production deployment:

- Previous API deployment can be restored.
- Previous mobile build remains available in TestFlight/internal testing.
- Database backup exists before migration.
- Yandex migration rollback path is documented in `backend/prisma/migrations/yandex_migration_notes.md`.
- Feature flags or env toggles can disable external providers without redeploying mobile apps.

## 10. Release Sign-Off

Release can proceed only after this table is completed:

| Area | Owner | Evidence | Status |
|------|-------|----------|--------|
| API TypeScript |  | command output | pending |
| App TypeScript |  | command output | pending |
| Unit tests |  | command output | pending |
| Smoke suite |  | command output | pending |
| Production API URL |  | deployed URL | pending |
| Database migrations |  | migration log | pending |
| iOS credentials |  | App Store Connect app/team | pending |
| Android credentials |  | Play service account | pending |
| Real-device iOS QA |  | checklist link | pending |
| Real-device Android QA |  | checklist link | pending |
| Store assets |  | screenshots/listing links | pending |
| Privacy policy |  | public URL | pending |
