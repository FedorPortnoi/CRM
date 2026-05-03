# Mobile CRM Platform

> **Simple. Visual. Powerful.** — A mobile-first CRM for entrepreneurs, freelancers, and SMBs with 1–500 employees.

This platform fills the gap between overpowered enterprise tools (Bitrix24, Salesforce) and underpowered lightweight apps. It is built for phones from day one, requires zero IT setup, and can be adopted by any team member within minutes.

---

## Why This Exists

Existing CRM tools fail SMBs in five concrete ways:

1. **Enterprise tools are too complex** — Bitrix24 requires IT departments, months of onboarding, and budgets only large companies have.
2. **No mobile-first CRM for SMBs** — Most small companies run their business from smartphones. Existing tools treat mobile as an afterthought.
3. **Either too simple or too expensive** — Lightweight tools miss critical features; powerful platforms charge enterprise prices.
4. **Not suited for non-technical users** — Business owners are not developers. They need software that works without training.
5. **Difficult adoption** — Even good tools face resistance when they require changing workflows and retraining teams.

---

## 14 MVP Features

| # | Feature | Description |
|---|---------|-------------|
| 1 | **Contact Management** | Centralized database of all contacts — customers, leads, partners. Full profiles, custom fields, search, and import. |
| 2 | **Sales Pipeline & Deal Tracking** | Visual Kanban pipeline boards. Drag-and-drop deals between stages. Revenue forecasting and deal history. |
| 3 | **Task Management & Reminders** | Create, assign, and track tasks for any contact or deal. Automated push reminders. Recurring task support. |
| 4 | **Call & Messaging** | One-tap call from a contact profile. Built-in SMS and in-app messaging. Automatic call logging. |
| 5 | **Interaction History** | Full chronological timeline of every call, message, meeting, and note for every contact. Automatic capture. |
| 6 | **Appointment Scheduling** | Built-in calendar with meeting invites, automated reminders, and sync with Google/Apple Calendar. |
| 7 | **Sales Funnel Analytics** | Full-funnel visualization, conversion rates per stage, lead source tracking, and win/loss analysis. |
| 8 | **Reporting Dashboard** | Home dashboard with key metrics. Sales and team performance reports. PDF/CSV export. |
| 9 | **Mobile Field Access** | Full offline capability with background sync. Location tagging for field visits. Touch-optimized UI. |
| 10 | **Visual Kanban Boards** | Trello-inspired boards for pipeline and tasks. Color-coded cards, drag-and-drop, filter by member/priority. |
| 11 | **Smart Data Entry** | Pre-filled defaults, flexible entry (voice notes, business card photos, text). No mandatory fields upfront. |
| 12 | **Auto Information Capture** | Calls, SMS, emails, and meeting notes captured automatically — no manual entry where avoidable. |
| 13 | **Custom Workflows & Stages** | Fully customizable pipeline stages, custom fields, automation rules, and reusable templates. |
| 14 | **Built-In Learning** | Contextual tooltips, embedded tutorials, ready-to-use templates, and progressive feature disclosure. |

---

## Target User Segments

| Segment | Team Size | Core Needs |
|---------|-----------|-----------|
| **Solo Entrepreneurs & Freelancers** | 1 person | Contact tracking, follow-up reminders, basic pipeline |
| **Micro-Businesses** | 2–10 people | Shared contacts, task assignment, basic reporting |
| **Small Businesses** | 10–100 people | Full pipeline management, team coordination, analytics |
| **Medium Businesses** | 100–500 people | Multi-department access, advanced analytics, permissions |

---

## Competitive Positioning

| Advantage | Detail |
|-----------|--------|
| Mobile-First Design | Built for phones from day one — not a desktop app ported to mobile |
| Zero Learning Curve | Any business owner can start the same day without training |
| Affordable Pricing | Priced for SMBs, not enterprise budgets |
| No IT Department Required | Setup requires zero technical knowledge |
| Visual & Intuitive | Kanban boards and dashboards make complex data understandable at a glance |
| All-in-One | Contacts, pipeline, tasks, messaging, scheduling, and analytics in one app |
| Adapts to You | Flexible forms, automatic data capture, customizable workflows |

---

## Folder Structure

```
crm/
├── README.md                    # This file
├── .env.example                 # Environment variable template
├── package.json                 # Dependencies and scripts
├── docs/
│   ├── architecture/            # System design documents
│   │   ├── system-overview.md   # High-level architecture diagram
│   │   ├── data-models.md       # All entity schemas
│   │   ├── api-design.md        # REST API conventions and endpoints
│   │   └── tech-stack.md        # Technology choices and rationale
│   ├── features/                # Feature specifications (14 features)
│   │   └── 01-contact-management.md ... 14-built-in-learning.md
│   ├── product/                 # Product strategy documents
│   │   ├── vision.md            # Product vision and philosophy
│   │   ├── roadmap.md           # MVP and post-MVP roadmap
│   │   ├── competitive-analysis.md
│   │   └── pricing-strategy.md
│   └── users/                   # User segment profiles
│       └── solo-entrepreneurs.md ... medium-businesses.md
├── src/                         # Mobile app source (React Native + Expo)
│   ├── app/                     # App entry and navigation
│   ├── components/              # Reusable UI components (by domain)
│   ├── screens/                 # Full screens (Dashboard, Contacts, Pipeline...)
│   ├── services/                # API client, auth, notifications, sync, storage
│   ├── store/                   # Redux/Zustand state (contacts, deals, tasks, user)
│   ├── hooks/                   # Custom React hooks
│   ├── utils/                   # Pure utility functions
│   └── types/                   # TypeScript type definitions
├── backend/
│   ├── api/                     # Express routes, middleware, controllers
│   ├── db/                      # Migrations, seeds, schema SQL
│   └── services/                # Business logic services
├── mobile/
│   ├── ios/                     # iOS-specific native config
│   └── android/                 # Android-specific native config
├── tests/
│   ├── unit/                    # Jest unit tests
│   ├── integration/             # API integration tests
│   └── e2e/                     # Detox end-to-end tests
└── brain/                       # Obsidian knowledge vault (see below)
```

---

## Obsidian Knowledge Brain

The `brain/` folder is a fully-linked Obsidian vault containing the complete product knowledge base:

- **`brain/00 - Home.md`** — Dashboard index linking all notes
- **`brain/01 - Product/`** — Vision, MVP scope, competitive landscape, pricing
- **`brain/02 - Features/`** — Deep-dive notes for all 14 MVP features
- **`brain/03 - Users/`** — User segment profiles and personas
- **`brain/04 - Architecture/`** — System design notes
- **`brain/05 - Decisions/`** — Decision log and open questions
- **`brain/06 - Competitors/`** — Competitor analysis (Bitrix24, Salesforce, HubSpot)
- **`brain/07 - Journal/`** — Development journal

To open: launch Obsidian → Open Vault → select `C:\Users\fedor\crm\brain`

---

## Getting Started (Dev Setup)

```bash
# 1. Clone / navigate to project
cd C:\Users\fedor\crm

# 2. Copy environment config
cp .env.example .env
# Fill in required values (see .env.example comments)

# 3. Install dependencies
npm install

# 4. Start the database (Docker)
docker-compose up -d postgres redis

# 5. Run migrations
npm run db:migrate

# 6. Start backend API
npm run backend:dev

# 7. Start mobile app
npm run start
# Then press 'i' for iOS, 'a' for Android
```

> **Note:** Full dev setup guide will be added as `docs/development-setup.md` in Sprint 1.

---

*Mobile CRM Platform — MVP v1.0 — Confidential*
