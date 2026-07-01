# Session Log — 2026-06-22 — Store Submissions + Kanban Fix

## Summary
Fixed persistent kanban JSON parse errors, captured all 4 app screenshots, submitted iOS v1.0.3 to App Store Review, submitted Android v1.0.3 to RuStore, saved RuStore API credentials for future automation.

---

## 1. Kanban / Воронка JSON Parse Fix

**Problem:** Every navigation to the Воронка tab caused `JSON Parse error` (Unexpected character: `:`, `a`, `e`, "Expect ':' after key") in `pipelinesStore.fetchPipelines`. Error persisted even after:
- Polyfill patches (3 from previous session)
- Sequential fetch chaining (`.then()`)
- Idempotency guards on both stores
- Direct `XMLHttpRequest` bypassing the polyfill entirely

**Root cause confirmed:** Dashboard's `fetchAll` fires 4 concurrent XHRs on app start (`/analytics/dashboard`, `/workflows`, `/deals?...`, `/captures`). If user navigates to Воронка before those complete, React Native's OkHttp networking layer corrupts the `responseText` buffer of the pipelines XHR.

**Fix** (`src/store/pipelinesStore.ts`):
- Added 350ms delay after `isLoading = true` (spinner shows, concurrent requests drain)
- Added 3-attempt retry loop with 400ms gaps as safety net for 60-second polling window
- Direct XHR approach kept (bypasses `whatwg-fetch` polyfill)

**Result:** Воронка kanban board loads cleanly every time.

---

## 2. Screenshots — All 4 Tabs

Captured from Pixel 8 emulator (dev client, Metro hot reload):

| Tab | File | Notes |
|---|---|---|
| Сегодня | `as_screen_segodnya.png` | 777 сделки, tasks, quick actions |
| Контакты | `as_screen_kontakty.png` | 1232 contacts, filters |
| Воронка | `as_screen_voronka.png` + `as_kanban_test2.png` | Новые лиды (189), Переговоры columns |
| Ещё | `as_screen_eshe.png` | Задачи, Чат, Уведомления, Календарь, Настройки |

All zero English text on screen.

**Resized versions:**
- App Store (1242×2688): `as_*.png` on `C:\Users\fedor\Desktop`
- RuStore (1080×1920): `rus_*.png` on `C:\Users\fedor\OneDrive\Desktop`

---

## 3. iOS App Store — v1.0.3 Build 19 Submitted

**Fields filled:**
- Promotional Text: "Мобильная CRM для бизнеса: контакты, сделки, воронка продаж, задачи и аналитика — всё в одном приложении. Работает офлайн." (121 chars)
- What's New: stability fixes, kanban optimization, sync improvements, UI fixes
- Notes for reviewer: brief description + test account already filled
- Build: Build 19 attached
- Release: Automatic after approval
- Phased release: All users immediately
- Rating reset: Keep existing

**Status:** In Review (submitted 2026-06-22)

---

## 4. RuStore — v1.0.3 versionCode 6 Submitted

**EAS Build:** `1ace3ce7-18f9-438b-a834-237e2b5df6a9`  
**APK saved:** `C:\Users\fedor\crm\releases\kub-1.0.3-vc6.apk` (127 MB)  
**Screenshots:** 4x 1080×1920 PNG uploaded to RuStore console  
**What's New:** same text as App Store  
**Status:** Submitted for moderation (2026-06-22)

---

## 5. RuStore API Credentials Saved

For future automation (uploading APK, screenshots, submitting for review without touching the console manually):

- `RUSTORE_KEY_ID` → `crm/.env` line 95 (value redacted from log; lives in .env only)
- `RUSTORE_PRIVATE_KEY` → `crm/.env` line 111 (PKCS#8 base64; value in .env only)
- Key name in console: "Claude", created 2026-06-22, covers 4КУБ app, 53+ methods

Full API reference + Python auth snippet saved to:  
`C:\Users\fedor\.claude\projects\C--Users-fedor\memory\reference_rustore_api.md`

**Auth flow:** RSA SHA-512 sign timestamp → POST `/public/auth/` → JWE token (900s TTL) → `Public-Token: {jwe}` header

---

## Files Changed
- `src/store/pipelinesStore.ts` — delay + retry logic
- `crm/.env` — added RUSTORE_KEY_ID, RUSTORE_PRIVATE_KEY
- `crm/releases/kub-1.0.3-vc6.apk` — new APK

## Next Steps
- Wait for Apple review (24–48h)
- Wait for RuStore moderation (~1–3 days)
- Next CRM session: build `rustore_api.py` to automate future releases
