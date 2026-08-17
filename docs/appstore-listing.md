# App Store — Listing Materials

⚠ **The live App Store Connect listing is Russian-only** — `appStoreVersionLocalizations` for
the 1.1.7 version returns exactly one locale, `ru`. There is no `en-US` localization configured
despite this file's history of English drafts; those were never what shipped. The RU content
below is the authoritative draft for **1.1.8**, updated 2026-08-17 (previous live copy through
1.1.7 claimed data storage "in Russia" — false, removed, see §Compliance note; also claimed
two-factor authentication when no TOTP/2FA implementation existed — that claim is back in this
draft as of today because the feature is now real, deployed to `crm_prod`, see `crm-now.md` §1а).
The English section further down is kept only as a translation reference, not a real
localization — do not treat it as what users see.

## Basic Information

| Field | Value |
|---|---|
| App Name (live) | КУБ: Клиенты и Сделки |
| Display name (app.json) | 4КУБ |
| Bundle ID | com.fedorportnoi.crm |
| App Store Connect app id | 6776447873 |
| Category | Business |
| Age Rating | 4+ |
| Price | Free |
| In-App Purchases | No |
| Locales configured | `ru` only |

---

## Compliance note (fixed 2026-08-16, 2FA claim restored 2026-08-17)

The live description through 1.1.7 claimed **"двухфакторная аутентификация" (two-factor
authentication)** — grepped the backend at the time, no TOTP/2FA implementation existed anywhere
in the code. That was a false claim on a public store listing and was removed on 2026-08-16.
As of 2026-08-17 it is back in the draft below, deliberately (owner decision) — TOTP 2FA
(RFC 6238) is now actually built and deployed to `crm_prod` (commit `5ee1ad6`, `crm-now.md` §1а).
It is opt-in per user, not on by default, so the description phrases it as an available feature
("включите 2FA в настройках"), not a blanket security guarantee.

The description also claimed data is "stored on servers in Russia" — per `crm-now.md` §1, data
is physically in the US and no migration has happened; that claim stays removed, not replaced
with an unqualified compliance claim.

---

## RU listing (authoritative — matches what's live)

**Subtitle** (≤30 chars, was empty on live): `CRM с ИИ-ассистентом` (20 chars)

**Promotional text** (≤170 chars, was empty on live — editable without a new build):
`ИИ-ассистент отвечает на вопросы о ваших сделках и клиентах простыми словами — прямо в приложении.` (98 chars)

**Keywords** (≤100 chars): `crm,ассистент,ии,продажи,клиенты,сделки,задачи,воронка,аналитика,amocrm,2fa` (75 chars)

**Description** (≤4000 chars, 1451 used):

```
CRM с ИИ-ассистентом, который знает ваш бизнес

Спросите ассистента: «Какие сделки закрываются на этой неделе?» или «С кем из
клиентов давно не связывались?» — и получите ответ обычными словами, без
отчётов и фильтров. Мобильная CRM для небольших команд и предпринимателей —
без сложности систем «для корпораций».

ИИ-АССИСТЕНТ
Отвечает по вашим контактам, сделкам и задачам. Голосовой ввод — просто
продиктуйте вопрос, ассистент расшифрует и ответит.

КОНТАКТЫ И СДЕЛКИ
Вся история клиента в одном месте: звонки, сообщения, сделки, задачи.
Воронка продаж — на канбан-доске или в списке — настраивается под ваш
процесс, от первого касания до закрытия.

ЗАДАЧИ И КАЛЕНДАРЬ
Дедлайны, приоритеты, повторяющиеся напоминания. Встречи и звонки
синхронизируются с Яндекс.Календарём.

АВТОМАТИЗАЦИЯ
Цепочки email-писем с шаблонами, гибкие напоминания по расписанию. Заявки
с Яндекс Карт сами становятся контактами и сделками в воронке.

ПЕРЕЕЗД С AMOCRM ИЛИ BITRIX24
Импортируйте контакты, сделки и историю в несколько шагов — не нужно
вносить всё вручную.

АНАЛИТИКА
Воронка продаж, выручка и конверсия по этапам — на одном экране.

РАБОТА ОФЛАЙН
Приложение работает без интернета. Изменения синхронизируются автоматически
при восстановлении соединения.

БЕЗОПАСНОСТЬ
Включите двухфакторную аутентификацию в настройках — код из
приложения-аутентификатора при каждом входе плюс резервные коды на случай
потери телефона.

ПРИВАТНОСТЬ
Данные защищены шифрованием. Мы не используем сторонние рекламные SDK и не
передаём данные рекламодателям.

Подходит командам от 1 до 50+ человек: фрилансеры, малый бизнес, растущие
компании.
```

---

## What's New (1.1.8, draft — not yet pushed, see `scripts/asc-release.js` `WHATS_NEW_RU`)

Двухфакторная аутентификация (2FA): включите в настройках → Безопасность —
дополнительный код при входе плюс резервные коды. Мелкие исправления
стабильности.

(1.1.7's already-live notes: заявки с Яндекс Карт, голосовой ввод в
ИИ-ассистенте, приём приглашений в команду прямо в приложении.)

---

## Screenshots

Production set (8 images, both required sizes) lives in
`store-assets/production-1.1.8/appstore-6.9/` (1320×2868) and
`store-assets/production-1.1.8/appstore-6.7/` (1290×2796) — carried forward
from `production-1.1.7` unchanged (2026-08-17): none of the 8 curated screens
(dashboard/assistant/deals/contacts/tasks/calendar/reports/cover) touch 2FA
or debug-log, both additive and invisible in this set. 2FA is not given its
own screenshot — it's an opt-in Settings toggle, not a "wow" screen, and the
description/keywords already carry it. Known non-blocking defect, still not
fixed: screen 6 (calendar) below.

0. **Cover** — brand hero: cube art, headline, orbiting mini UI cards (built with Remotion, `tools/splash-remotion/src/AppStoreCover.tsx`)
1. **Сегодня** — dashboard: open deals, tasks, monthly plan
2. **Ассистент** — AI assistant chat
3. **Воронка** — pipeline, list view (board view crops on real devices — see git history)
4. **Контакты** — contact list
5. **Задачи** — task list with priorities/status
6. **Календарь** — upcoming meetings (⚠ captured in dark theme, inconsistent with the rest — reshoot in light theme when convenient)
7. **Отчёты** — sales funnel analytics

---

## App Icon

File: `assets/icon.png` (1024×1024 PNG, no rounded corners — App Store applies the mask)

---

## Privacy Policy URL

Publish `docs/privacy-policy-en.md` as a static page and paste the URL here before submission.

---

## Support URL

Live on App Store Connect: `https://github.com/FedorPortnoi` (a bare GitHub profile — works as a
real-identity trust signal for a solo developer, but a dedicated support/landing page would read
more professional if one gets built).

---

## Privacy Nutrition Label

Configure in App Store Connect → App Privacy:

| Data Type | Collected? | Linked to User? | Used for Tracking? |
|---|---|---|---|
| Name | Yes | Yes | No |
| Email address | Yes | Yes | No |
| Phone number | Yes (contact's phone) | Yes | No |
| Precise location | Yes (optional, field visits) | Yes | No |
| User content (notes/deals) | Yes | Yes | No |
| Identifiers (user ID) | Yes | Yes | No |
| Crash data | **Yes (changed 2026-08-17)** | No | No |
| Browsing/usage data | No | — | — |
| Advertising data | No | — | — |

⚠ **Crash data flipped to Yes 2026-08-17**: `src/utils/remoteLogger.ts` (new in this release)
forwards uncaught errors and `console.error` calls to `POST /debug/log`, self-hosted, not a
third-party SDK. Not linked to a specific user account (no user ID attached, IP is logged
server-side for rate-limiting only, not exposed here) — hence "Linked to User? No", matching
Apple's definition. If a future change attaches user identity to these reports, this row needs
to flip to "Yes" under Linked to User too.

---

## Review Notes for Apple

- Geolocation permission is triggered only when user explicitly taps "Add Field Visit" — not on app launch.
- Camera permission is triggered only when user taps "Scan business card" — not on app launch.
- Contacts permission is triggered only when user taps "Import from Contacts" — not on app launch.
- The app requires account registration to function (CRM data is org-scoped).
- Test account: provide via App Review Information in App Store Connect before submission.

---

## Developer Contact

| Field | Value |
|---|---|
| Name | Fedor Portnoi (Individual Entrepreneur) |
| Email | thiofedor@gmail.com |
