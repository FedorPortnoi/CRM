# Product Roadmap

## MVP (v1.0) — All 14 Core Features

**Goal:** Validate the core value proposition. Get the first 100 paying organizations.

**Timeline target:** 4–6 months from project start (May 2026 start → September/October 2026 launch)

| Sprint | Focus | Deliverables |
|--------|-------|-------------|
| Sprint 1 (Weeks 1–2) | Foundation | Auth (register/login/JWT), organization setup, basic user management, CI/CD pipeline |
| Sprint 2 (Weeks 3–4) | Contacts | Contact CRUD, search, import (phone + CSV), activity log foundation |
| Sprint 3 (Weeks 5–6) | Pipeline | Pipeline + stage management, deal CRUD, Kanban board, drag-and-drop |
| Sprint 4 (Weeks 7–8) | Tasks | Task CRUD, reminders, recurring tasks, notification delivery |
| Sprint 5 (Weeks 9–10) | Communication | Call logging, SMS via Twilio, in-app messaging, message history |
| Sprint 6 (Weeks 11–12) | Calendar | Appointment creation, Google Calendar sync, meeting reminders |
| Sprint 7 (Weeks 13–14) | Analytics | Funnel visualization, conversion rates, revenue reports, dashboard |
| Sprint 8 (Weeks 15–16) | Smart Entry | Business card OCR, voice notes, auto-capture engine |
| Sprint 9 (Weeks 17–18) | Offline + Polish | Offline-first sync, conflict resolution, performance optimization |
| Sprint 10 (Weeks 19–20) | Workflows + Learning | Custom fields, automation rules, onboarding walkthrough, tooltips |
| Beta (Weeks 21–22) | Beta testing | Invite 20 pilot companies; collect feedback; fix critical issues |
| Launch (Week 24) | v1.0 Launch | App Store + Play Store submission; marketing launch |

---

## v1.5 — Growth Features (3–4 months post-MVP)

Driven by feedback from first 100 organizations.

- **Email integration:** Forward-to-log email address; Gmail/Outlook OAuth for bi-directional email thread logging
- **Task sub-tasks:** Checklist items within tasks for multi-step follow-up sequences
- **Team-specific dashboards:** Manager view vs. rep view as configurable dashboard modes
- **Scheduled reports:** Weekly/monthly email digest of key metrics sent automatically
- **Workflow templates:** Industry-specific onboarding templates (Real Estate, Agency, SaaS, Consulting, Construction)
- **Booking link:** Calendly-like public scheduling page so contacts can self-book meetings
- **Recurring meetings:** iCal RRULE support for calendar events (same as tasks)
- **Mobile → web dashboard:** Read-only web dashboard for data analysis on larger screens
- **Bulk actions on pipeline:** Bulk move deals, bulk assign, bulk close
- **Custom report builder:** Basic drag-and-drop report builder for custom analytics views

---

## v2.0 — Platform Features (6–12 months post-MVP)

Expanding toward the medium business segment.

- **AI assistant:** In-app Claude-powered assistant ("Why is my pipeline stalling?", "Draft a follow-up message for this contact")
- **AI-generated meeting summaries:** Transcribe and summarize meeting recordings automatically
- **VoIP calling:** Call directly through the app via Twilio Voice SDK — no native dialer switch needed
- **WhatsApp integration:** Send and receive WhatsApp messages from the CRM (Twilio for WhatsApp)
- **Multi-department teams:** Department groups with isolated pipeline views and team members
- **SSO (SAML/Google):** For medium business corporate accounts
- **Advanced permissions:** Role-based field-level access control (can view but not edit certain fields)
- **API access:** Public REST API + webhook outbox for third-party integrations (Zapier, Make)
- **Company entities:** Separate Company entity linked to Contacts (for B2B account management)
- **Deal splitting:** Split one deal into multiple sub-deals for complex B2B sales
- **iPad / tablet-optimized UI:** Two-pane layout for wider screens
- **On-premise / self-hosted option:** For regulated industries (healthcare, legal)
- **Multi-currency:** Full currency conversion in pipeline and revenue reports

---

## Post-v2 — Platform Ecosystem

- **App marketplace:** Third-party integrations built by community (Slack, Xero, QuickBooks, Stripe)
- **Industry verticals:** Pre-configured CRM templates + AI for Real Estate, Legal, Healthcare, Hospitality
- **White-label / partner program:** CRM offered under partner brand to their client base
- **AI deal scoring:** ML model predicting deal win probability based on historical patterns

---

## What We Are NOT Doing (Ever)

- Mass email campaigns / email marketing (not our market)
- ERP / inventory / invoicing (scope creep into accounting)
- Social media management (different product category)
- B2C customer support (we are B2B sales-focused)
