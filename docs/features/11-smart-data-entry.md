# Feature 11: Smart Data Entry & Auto-Fill

## Overview

Smart Data Entry reduces the friction of adding information to the CRM to the absolute minimum. The core insight is that people stop using CRM tools when data entry feels like filling out tax forms. If adding a new contact requires 15 mandatory fields, a sales rep will not add contacts in the field. They'll keep their notes on paper — and data that never makes it into the CRM is data that doesn't exist.

This feature takes the opposite approach: let people add data in whatever way is most convenient for them at the moment. Quick text with just a name and phone? Fine. A voice note? Transcribed and pre-filled. A business card photo? OCR extracts name, company, phone, and email. A CSV export from their email client? Imported in bulk. The CRM adapts to the user's workflow, not the other way around.

Pre-filled defaults and guided examples mean that even first-time users know what information goes where and what format is expected — without reading a manual.

## User Stories

- **As a sales rep at a trade show**, I want to photograph a business card and have the CRM automatically extract the contact's name, company, phone, and email so that I can add 20 leads in 5 minutes without typing.
- **As a freelancer**, I want to add a new contact with just a name and phone number in under 10 seconds so that I never lose a lead while I'm on the go.
- **As a non-technical business owner**, I want to see example text in each form field so that I know what to type without guessing.
- **As an office manager**, I want to import 300 contacts from a CSV I exported from Gmail so that we can migrate all our existing contacts in one step.
- **As a sales rep**, I want the app to suggest completing fields based on what I've already entered (e.g., suggest company name when I type an email domain) so that I type less.
- **As a field agent**, I want to leave a voice note about a new contact while I'm driving so that I capture information safely without typing.

## Acceptance Criteria

- No mandatory fields on contact creation beyond a name (phone OR email optional for MVP — contacts must have at least one of these for messaging to work, but creation is not blocked without them)
- Business card OCR: camera capture in-app → image sent to backend → Google Vision API → structured pre-fill (name, company, title, phone, email, address) → user confirms/edits before saving; accuracy ≥ 80% for clean cards
- Voice note entry: record a voice note on the new contact form → Whisper API (OpenAI) transcription → pre-fill relevant fields from transcript → user confirms
- CSV import: column mapping UI (drag and drop CSV column → CRM field); import up to 5,000 contacts per batch; progress indicator; results report (imported/skipped/errors)
- Phone contact import: expo-contacts → device address book → select contacts to import → map to CRM fields → confirm
- Field examples: placeholder text in every form field showing the expected format (e.g., Phone: "+1 555 000 0000")
- Auto-suggest: when company email domain is typed, suggest company name from domain (e.g., @acme.com → "Acme Corp") — powered by Clearbit-like lookup or local domain-company cache
- Progress saving: if user starts filling a contact form and navigates away, form state is saved locally and a "Continue draft" prompt appears next time
- Inline validation: real-time validation of phone (E.164 format) and email (RFC 5322) with friendly error messages, not technical ones

## Edge Cases

- Business card photo is blurry or skewed: OCR returns low-confidence results; show all extracted text with "Low confidence — please review" warning; user must manually confirm each field
- Voice note in a language other than English: Whisper supports 90+ languages; detect language automatically; if field parsing fails for non-English, present full transcript as a note instead
- CSV with 5,001 contacts: split into batches server-side; first 5,000 imported immediately, remaining queued
- Form draft conflicts: user has a saved draft on device A and starts a new contact on device B; both drafts are independent (drafts are local-only, not synced)
- Phone contact import: iOS 18 may require "Full contacts" permission; gracefully handle "Limited access" by showing only the contacts the user has granted
- Duplicate detected during import: show per-row UI (skip / overwrite / create as new) — do not silently overwrite
- Voice note transcription failure (API down): fallback to saving audio file as an attachment to the contact note; transcription can be retried later

## Open Questions

1. Should the business card OCR run on-device (Core ML / TF Lite) or in the cloud? Cloud (Google Vision) for MVP — on-device is faster and private but requires ML model management.
2. Should we support scanning multiple cards in quick succession (trade show mode: scan → confirm → scan → confirm)? Yes — high value for trade show use case. Implement as a dedicated "Card Scan Mode" flow.
3. Should voice notes be saved as audio attachments in addition to (or instead of) text transcription? Save both — the transcription is searchable, the audio is the source of truth.
4. Should the auto-suggest for company names require a paid data API (Clearbit, Hunter.io)? Yes — budget ~$50/month for this enrichment service; make it optional in settings.
5. What field should be the minimum to save a contact — name only, or name + at least one contact method (phone or email)?

## Technical Notes

- Business card capture: expo-camera → image compressed to ≤ 500KB (expo-image-manipulator) → uploaded to backend → `@google-cloud/vision` SDK calls `documentTextDetection` → heuristic parser extracts structured fields → response returned to client for user confirmation
- Voice transcription: expo-av records audio → WAV file uploaded to backend → OpenAI Whisper API transcribes → NLP regex/heuristics extract name, phone, email from transcript → pre-fill response to client
- CSV import: multer multipart upload → `csv-parse` stream parser → per-row validation → duplicate check → bulk insert via `pg` COPY or Drizzle batch insert; Bull job for progress tracking
- Form draft: MMKV key `contact_draft_${userId}` — persisted on every keystroke with 300ms debounce; cleared on successful save
- Inline phone validation: `libphonenumber-js` `isValidPhoneNumber()`; formatting preview in real-time as user types
