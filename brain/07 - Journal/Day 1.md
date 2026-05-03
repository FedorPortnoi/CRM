---
tags: [journal, day-1, kickoff]
status: complete
related: ["Vision & Philosophy", "MVP Scope", "Decision Log", "Tech Stack", "Open Questions"]
created: 2026-05-01
---

# Day 1 — May 1, 2026

## What Happened Today

- Read and fully analyzed the MVP product specification document (`CRM_MVP_Document_Final.pdf`)
- Created complete project folder structure at `C:\Users\fedor\crm\`
- Created Obsidian knowledge brain at `C:\Users\fedor\crm\brain\`
- Wrote all 14 feature specification documents in `docs/features/`
- Wrote architecture documents (system overview, data models, API design, tech stack)
- Wrote product strategy docs (vision, roadmap, competitive analysis, pricing)
- Wrote user segment profiles for all 4 target segments
- Created backend API route stubs (TypeScript) for all 6 resource types
- Created PostgreSQL schema files for all 5 core entity groups
- Built out the full Obsidian brain with 30+ interconnected notes

## Key Decisions Made

- **All 14 features are in the MVP** — they are interdependent and must ship together for the product to make sense
- **Tech stack confirmed:** React Native + Expo + TypeScript + Node.js/Express + PostgreSQL + Redis
- **REST over GraphQL** for the API — simpler for MVP; GraphQL can be evaluated in v2
- **Offline-first is non-negotiable** — this is the core technical differentiator
- **Bitrix24 is the primary displacement target** — most of our early customers will have failed with Bitrix

## What I Learned from the Spec

The spec's philosophy is "Simple. Visual. Powerful." — three words that must guide every design and development decision.

The five market problems are real and well-defined:
1. Enterprise tools (Bitrix, Salesforce) are too complex
2. No mobile-first CRM for SMBs
3. Either too simple or too expensive
4. Not suited for non-technical users
5. Difficult adoption

The 14 features form a coherent product loop: contacts → deals → tasks → communication → history → analytics → back to contacts. Each feature makes every other feature more valuable. This is why all 14 must ship together.

## Open Questions I Need to Answer Before Sprint 1

1. Is Company a separate entity or a field on Contact? (See [[Open Questions]] A1)
2. Should we support contact merge for duplicate resolution? (See [[Open Questions]] P5)
3. UUID v4 vs UUID v7 for primary keys? (See [[Open Questions]] A5)

## What's Next

- [ ] Sprint 1 planning: auth system, org setup, basic user management
- [ ] Set up CI/CD with GitHub Actions + Expo EAS
- [ ] Choose a hosting provider (Railway vs Render) and create accounts
- [ ] Set up local development environment
- [ ] Answer the three blocking open questions above before starting Sprint 2

## Mood

Energized. The spec is well-thought-out and the market gap is real. The mobile-first + offline-first angle is genuinely differentiated — none of the main competitors do this well. The hardest part will be maintaining product discipline and resisting scope creep. The features we chose NOT to build are as important as the ones we did.

---

*Next journal entry: Day 2 or Sprint 1 kickoff*

See [[Vision & Philosophy]] for why this product exists. See [[MVP Scope]] for what's in and what's out. See [[Tech Stack]] for all technical decisions.
