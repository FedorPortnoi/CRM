# Adaptability Guardrail

Production will create new requirements: local payments, customer-specific workflows, compliance checks, integrations, reporting needs, and edge cases from real users. The codebase should absorb those changes without turning into a large tangled platform.

The rule is simple: keep universal CRM behavior separate from market rules, provider behavior, and customer process variation.

## Boundaries

| Change type | Correct home |
| --- | --- |
| Country, language, currency, phone, payment defaults | Market profile |
| External provider behavior | Adapter module |
| Customer-specific sales process | Pipelines, stages, workflows, custom fields |
| Core CRM behavior used by most users | Product module with tests |
| Experimental field or edge-case request | `custom_fields` until proven stable |
| Personal-data handling | Compliance capability, not one-off checks |

## Russia-First V1

The first production version is for Russia. Russia-specific defaults are real product behavior, but they must enter the app through the market profile and adapters, not through scattered screen/controller constants.

Current defaults:

- locale: `ru-RU`
- time zone: `Europe/Moscow`
- currency: `RUB`
- phone country code: `+7`
- company identifiers: `inn`, `kpp`, `ogrn`
- payments: `sbp`, `mir_acquiring`, `bank_invoice`
- integrations: SMS.ru, Yandex services, 1C

## Code Rules

- Do not hardcode `$`, `USD`, `en-US`, US phone formats, US addresses, Stripe-only billing, Twilio-only SMS, or Google-only calendar behavior inside feature screens or controllers.
- Use `backend/config/market.ts` for backend market defaults.
- Use `src/market/profile.ts` for mobile formatting and display defaults.
- Keep provider logic behind named adapter modules.
- Keep customer process variation in pipelines, stages, workflows, and custom fields.
- Promote `custom_fields` to named columns only when the behavior becomes core, queried, validated, or reported.
- Add focused tests for every boundary that must remain stable.

## Verification

```bash
npm test -- --run tests/unit/backend/deals-routes.test.ts tests/unit/market/profile.test.ts
npm run typecheck
rg -n "toLocaleString\\('en-US'|toLocaleDateString\\('en-US'|toLocaleTimeString\\('en-US'|USD|\\$" src backend tests/unit docs/architecture
```

Expected result: focused tests pass, typecheck passes, and any grep matches are intentional docs or test fixtures.
