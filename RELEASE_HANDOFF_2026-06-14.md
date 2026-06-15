# Release Handoff — 2026-06-14

App version **1.0.1**, iOS **build 14**, Android **versionCode 4**.

## ✅ Done this session

### App Store (iOS) — 1.0.1 (build 14) SUBMITTED, Waiting for Review
- **Root cause of the stuck release:** builds **12 and 13 were NOT broken binaries** —
  they **failed Apple processing** with:
  - `ITMS-90186 Invalid Pre-Release Train` — version train `1.0.0` is closed for new builds.
  - `ITMS-90062` — `CFBundleShortVersionString` must be **higher** than the already-approved `1.0.0`.
  - i.e. **1.0.0 was already approved/distributed with build 10** (live since ~Jun 7), so no
    more builds can be submitted under 1.0.0. Rebuilding the same version number just fails again.
- **Fix:** bumped `app.json` `expo.version` `1.0.0 → 1.0.1`. (buildNumber autoIncrements via
  `eas.json` production profile → build 14.)
- Rebuilt + uploaded via EAS (already logged in as `flada`, no token needed):
  - `eas build --profile production --platform ios` → build 14, version 1.0.1
  - `eas submit --profile production --platform ios --latest`
  - Build 14 **passed Apple processing** (TestFlight shows it Complete, not Failed).
- Created App Store version **1.0.1** in ASC, attached build 14, added "Что нового",
  reviewer sign-in carried over (`review@kubcrm.com` / `Review2026!`), **Manual release** chosen.
- **Submitted for Review** — Submission ID `28a53dd4-4448-47e7-8ca0-1790dbf3649c`, Jun 14 14:18.
- Also had to **accept the updated Apple Developer Program License Agreement** (was blocking submission).

### RuStore (Android) — vc4 uploaded
- Uploaded `releases\kub-1.0.0-vc4.apk` (versionCode 4) via console.rustore.ru.
- Status: **Ожидает модерацию** (awaiting moderation), publication Automatic, audience 100%.
- Previously published: vc3 (live since 07.06), vc2 prior active.

## ⬜ TODO next
1. **App Store:** when Apple approves 1.0.1 (~24h, email), the release is **Manual** —
   go to the version page and click **"Release this version"** to go live. Approval ≠ live.
2. **RuStore:** vc4 auto-publishes once moderation passes — just confirm it goes Опубликовано.

## Notes / gotchas
- **Once a version (CFBundleShortVersionString) is approved on the App Store, that train is
  closed.** Every new submission needs a HIGHER `expo.version` in `app.json`. Bumping only
  `buildNumber` is NOT enough — that was the trap that failed builds 12 & 13.
- EAS prod iOS autoIncrements `buildNumber`; `appVersionSource: "local"` (so it edits app.json).
- iOS live build is **10** until 1.0.1 is released. Android live is **vc3** until vc4 clears.
- Rebuild iOS:  `eas build --profile production --platform ios`
- Rebuild RuStore APK: `eas build --profile rustore --platform android`
- Reviewer/test login: `review@kubcrm.com` / `Review2026!` (owner account, works on prod).
