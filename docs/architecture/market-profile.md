# Market Profile Boundary

The first production version is Russia-first. That is a product constraint, not just a translation setting.

The codebase should keep universal CRM behavior separate from market-specific behavior:

```txt
Core CRM modules:
  contacts, deals, tasks, calendar, messages, workflows, analytics

Market profile:
  locale, currency, phone defaults, company identifiers, payments,
  compliance capabilities, and local integration adapters
```

## Default Market

The default profile is `RU`:

| Area | Default |
| --- | --- |
| Locale | `ru-RU` |
| Language | `ru` with `en` fallback |
| Time zone | `Europe/Moscow` |
| Currency | `RUB` |
| Phone country code | `+7` |
| Company identifiers | `inn`, `kpp`, `ogrn` |
| Payments | `sbp`, `mir_acquiring`, `bank_invoice` |
| Local integrations | `sms_ru`, `yandex_calendar`, `yandex_vision`, `yandex_speechkit`, `yandex_object_storage`, `one_c` |

## Rules

- Do not hardcode `$`, `USD`, `en-US`, US addresses, or US-only payment assumptions inside feature screens or controllers.
- Use the market profile for defaults and display formatting.
- Add provider-specific code behind adapters, not inside core CRM modules.
- Store Russia-specific business attributes in named fields when they become core behavior; use `custom_fields` only while the requirement is experimental.
- Treat personal-data localization, operator notification, audit events, consent tracking, and cross-border transfer review as platform capabilities.
- Keep customer-specific process changes in pipelines, stages, workflows, and custom fields instead of adding per-customer branches.
- See `docs/architecture/adaptability.md` for the broader post-production change guardrail.

## Current Implementation

- Backend defaults live in `backend/config/market.ts`.
- Mobile formatting defaults live in `src/market/profile.ts`.
- Deal and revenue routes default to `RUB`.
- Mobile money/date display uses `ru-RU` formatting through the market profile.
