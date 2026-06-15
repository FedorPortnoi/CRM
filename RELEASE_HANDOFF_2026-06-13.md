# Release Handoff — 2026-06-13

App version **1.0.0**, iOS **build 12**, Android **versionCode 4**.

## ✅ Done this session

### Backend (deployed to prod VM 4kub.ru)
- **Employee join flow** is live: owner adds employee by first+last name → system
  makes a per-org username (e.g. "Ivan Petrov") + temp password + a **rotating
  7-day company code**. Employee uses the "Я новый сотрудник" tab (company code +
  username + temp password) → forced to set their own email + password. Returning
  logins use that email.
- New endpoints: `POST /auth/join`, `GET/POST /auth/company-code(/rotate)`,
  `PATCH /auth/me/credentials`; `inviteUser` reworked.
- DB migration `20260613_employee_join_flow` **applied to the Yandex DB**.
- Verified end-to-end on prod: `POST https://4kub.ru/api/v1/auth/join` → 401 for a
  bad code (handler running).
- Deployed commit: `c7fccc9`. (Prod runs compiled `dist/backend` via pm2 `crm-backend`;
  deploy = git pull + npm install + db:generate + backend:build + pm2 restart.)

### App (in this build, NOT yet on prod app code — needs the store builds below)
- Task form: full Russian, recurrence is a dropdown (RRULE bug fixed), assignee picker.
- Calendar modal safe-area fix ("Готово" clears the status bar).
- Navigation redesign: bottom tab bar replaced with a **top-left hamburger menu**
  on the dashboard; **every other screen has a ← arrow that returns to the dashboard**.
- Commits pushed to origin/main: `8b45ca7` (UI batch + version bumps), `c1e5895`
  (buildNumber 12), `82c2e9e` (.easignore).

### Build system cleanup
- Deleted local `android/` folder so EAS prebuilds from `app.json` (versions itself).
- Added `.easignore` (managed prebuild + force-includes gitignored `google-services.json`).

### Builds (EAS)
- **iOS build 12** — finished AND **submitted to App Store Connect** (processing).
  Submission: https://expo.dev/accounts/flada/projects/crm/submissions/d212c051-eec7-45a8-9345-d22482b4ea6b
- **Android versionCode 4** — finished, APK downloaded locally.

## 📦 Artifact paths
- Android (RuStore): `C:\Users\fedor\crm\releases\kub-1.0.0-vc4.apk`
- iOS (App Store): `C:\Users\fedor\crm\releases\kub-1.0.0-build12.ipa` (already submitted)

## ⬜ TODO tomorrow
1. **RuStore:** upload `releases\kub-1.0.0-vc4.apk` via console.rustore.ru
   (versionCode 4 clears previous 3). Resubmit.
2. **App Store Connect:** once build 12 finishes processing (email from Apple),
   open the 1.0.0 version → select build 12 → submit for review.
   https://appstoreconnect.apple.com/apps/6776447873
3. Shut down the local emulator + Metro if still running (they were left running).
4. Optional: pre-existing uncommitted changes left untouched — `website/*` (marketing
   site, deploys separately to the VM via nginx) and `assets/icon-source.png` move.
   Decide whether to commit/deploy those.

## Notes / how to rebuild
- EAS auth: `export EXPO_TOKEN=<EXPO_ACCESS_TOKEN from .env>` then `npx eas-cli ...`
- Rebuild iOS:  `eas build --profile production --platform ios`
- Rebuild RuStore APK: `eas build --profile rustore --platform android`
- Both now version from `app.json` (bump `ios.buildNumber` / `android.versionCode`
  there; production iOS also autoIncrements).
- Reviewer/test login: `review@kubcrm.com` / `Review2026!` (owner account, works on prod).
