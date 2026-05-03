---
tags: [feature, mvp, data-entry, ocr, voice, import]
status: specced
related: ["Contact Management", "Auto Information Capture", "Built-In Learning", "Mobile Field Access", "Custom Workflows"]
created: 2026-05-01
---

# Smart Data Entry

## Overview

Reduces friction of adding information to the absolute minimum. The core insight: people stop using CRM tools when data entry feels like filling out tax forms. If adding a contact requires 15 mandatory fields, a rep won't add contacts in the field. They keep notes on paper — and data that never enters the CRM doesn't exist.

The opposite approach: let people add data in whatever way is most convenient. Quick text with just a name? Fine. Voice note? Transcribed and pre-filled. Business card photo? OCR extracts name, company, phone, email. CSV export from Gmail? Imported in bulk. The CRM adapts to the user's workflow.

See also [[Auto Information Capture]] — the companion feature that captures data without the user doing anything at all.

## Why It Matters

CRM adoption rate correlates inversely with data entry friction. Every extra mandatory field reduces the chance that a rep will add a contact from the field by ~15%. A CRM with zero mandatory fields (beyond a name) removes the entire barrier. Combined with [[Built-In Learning]] progressive guidance, users gradually fill in richer data as the habit forms.

## User Stories

- As a sales rep at a trade show, I want to photograph a business card and have the CRM extract name, company, phone, email so I add 20 leads in 5 minutes
- As a freelancer, I want to add a contact with just a name and phone in under 10 seconds
- As a non-technical user, I want to see example text in every form field so I know what to type
- As an office manager, I want to import 300 contacts from a Gmail CSV in one step
- As a sales rep, I want auto-suggest for company name when I type an email domain
- As a field agent, I want to leave a voice note about a new contact while driving safely

## Acceptance Criteria

- No mandatory fields beyond a name on contact creation
- Business card OCR: in-app camera → Google Vision API → structured pre-fill → user confirms; accuracy ≥ 80% for clean cards
- Voice note: expo-av records audio → Whisper API transcribes → pre-fill from transcript → user confirms
- CSV import: column mapping UI; up to 5,000 contacts per batch; progress indicator + results report
- Phone contact import: expo-contacts → device address book → select → map → confirm
- Field examples: placeholder text in every form field
- Auto-suggest: company name from email domain (Clearbit or local cache)
- Form draft: state persisted on every keystroke (300ms debounce) in MMKV; "Continue draft?" on return
- Inline validation: real-time phone (E.164) and email validation with friendly messages

## Technical Notes

- Business card: expo-camera → expo-image-manipulator (compress ≤500KB) → `POST /contacts/scan-card` → Google Vision API `documentTextDetection` → heuristic parser → structured response to client for confirmation
- Voice: expo-av → WAV file → `POST /contacts/transcribe-voice` → OpenAI Whisper API → NLP field extraction → pre-fill response
- CSV: multer upload → `csv-parse` stream → per-row validation → duplicate check → bulk insert via Drizzle batch; Bull job for progress
- Form draft: MMKV key `contact_draft_${userId}` — persisted on keystroke; cleared on save

## Related Features

- [[Contact Management]] — the destination for all data entry flows
- [[Auto Information Capture]] — the complement (captures what the system observes; Smart Data Entry is for what the user provides)
- [[Built-In Learning]] — field hints and examples are part of this feature
- [[Mobile Field Access]] — OCR and voice work offline (with cloud service call on reconnection)
- [[Custom Workflows]] — custom fields appear in the entry form

## Open Questions

1. Business card OCR on-device (Core ML) or cloud (Google Vision)? (Cloud for MVP)
2. Should we support "card scan mode" for rapid sequential scanning at events? (Yes — high value)
3. Should voice notes be saved as audio attachments in addition to text? (Yes — save both)
4. Company name auto-suggest: use paid API (Clearbit/Hunter.io) or local heuristics? (Budget ~$50/month for API)
5. Minimum required to save a contact: name only, or name + at least one contact method?
