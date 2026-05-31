# 001 - Russia-First Market Profile

## Decision

The first production version uses a Russia-first market profile. Russia-specific behavior is allowed only through explicit market/profile modules or integration adapters.

## Why

The CRM is being built for Russian users first. Currency, phone formats, local company identifiers, payments, local providers, and personal-data obligations affect product behavior from day one.

At the same time, scattering Russia-specific assumptions through every screen and controller would make later change expensive. A market boundary keeps the app native for Russia while preserving a clean path for future markets.

## Consequences

- Default currency is `RUB`, not `USD`.
- Default locale is `ru-RU`.
- Phone handling assumes `+7` and national `8` variants.
- Payment work should start behind provider adapters for SBP, acquiring, and invoices.
- Yandex, SMS.ru, object storage, and 1C integrations stay behind adapter modules.
- Personal-data localization and consent/audit work are platform concerns, not one-off feature checks.
