---
tags: [feature, mvp, onboarding, learning, ux, adoption]
status: specced
related: ["Vision & Philosophy", "Smart Data Entry", "Kanban Boards", "Sales Pipeline", "Custom Workflows", "Solo Entrepreneurs", "Micro-Businesses"]
created: 2026-05-01
---

# Built-In Learning

## Overview

The CRM is self-teaching. Users should not need a manual, training session, or IT department to start. The product teaches them as they go — showing the right hint at the right moment, offering a short tutorial video when they first encounter a complex feature, and providing ready-to-use examples so they're never staring at a blank form.

This is the feature that makes "zero learning curve" a reality, not just a marketing claim. In [[Competitive Landscape]] analysis, [[Bitrix24]] is notorious for requiring extensive onboarding. This platform deliberately designs the opposite experience: start simple, show what's relevant now, progressively reveal deeper features as the user grows into them.

## Why It Matters

For the [[Solo Entrepreneurs]] and [[Micro-Businesses]] segments, the difference between a tooltip at the right moment and having to search documentation is the difference between adoption and churn. First impressions of software solidify within the first 3 sessions. If a user is confused in session 1, they rarely return.

The built-in learning system also reduces support ticket volume — every well-placed tooltip is a support ticket that never gets filed.

## User Stories

- As a first-time user, I want a brief welcome walkthrough showing the 3 most important things I can do so I know how to start
- As a non-technical user trying the pipeline board for the first time, I want a tooltip explaining drag-and-drop so I discover the feature immediately
- As a business owner who just set up automation rules, I want a short video explaining what automations can do
- As a new team member, I want to see an example of a fully filled-out contact profile so I know what level of detail to aim for
- As a user new to the analytics section, I want a brief explanation of each chart when I first open it
- As a manager, I want team members to see relevant tutorials on their first use

## Acceptance Criteria

- 4-step onboarding walkthrough on first login: 1) Add contact, 2) Create deal, 3) Set task reminder, 4) View dashboard — arrow pointer to UI element, "Got it" button
- Contextual tooltips: shown once per feature per user; dismissed with tap; stored in `user.onboarding_state JSONB`
- Tutorial videos: 60–90 second screen-recorded videos for: pipeline boards, automation rules, analytics, CSV import, calendar sync — accessible via "?" button
- Feature hints: "ⓘ" icon on complex fields opens explanatory popover
- Example data: "Load example data" creates 5 sample contacts, 2 deals, 3 tasks with filled-out fields; easily cleared in one tap
- Progressive disclosure: advanced features (automation, custom fields, API) hidden from new users; appear after a configurable threshold or explicit unlock
- Persistent help button: context-aware on every screen (1 video + 3 FAQs + support link)
- Completion tracking per user in `user.onboarding_state`

## Technical Notes

- Tooltip trigger: each tooltip has a string key (e.g., `pipeline_drag_hint`); check `onboarding_state.dismissed_tooltips` on screen mount
- Tutorial videos: expo-av `Video` component; hosted on S3/CDN as MP4; not YouTube (no dependency, works from cache offline)
- Example data: `POST /organization/load-example-data` endpoint; tagged with `is_example_data = true` flag; cleared via `DELETE /organization/clear-example-data`
- Help sheet context: each screen exports `helpContext: { videoId, faqKeys[] }`; Help button reads from React context; FAQ from local JSON bundle (no API call needed)
- Progressive disclosure: `organization.plan_features JSONB` + account age threshold control advanced feature visibility

## Related Features

- [[Vision & Philosophy]] — zero learning curve is a core philosophical commitment
- [[Smart Data Entry]] — field hints and examples are part of this feature
- [[Kanban Boards]] — drag hint shown on first board visit
- [[Custom Workflows]] — automation tutorial video for first-time setup
- [[Sales Pipeline]] — onboarding walkthrough step 2 (create a deal)
- [[Reporting Dashboard]] — onboarding walkthrough step 4 (view dashboard)

## Open Questions

1. Tutorial videos: hosted in app bundle (larger download) or streamed from CDN (requires internet)? (CDN for all except first-run walkthrough which should work offline)
2. Should there be an in-app AI assistant ("Ask me anything about the CRM")? (High value — v2, using Claude API)
3. Should helpdesk chat (Intercom, Crisp) be embedded? (Yes — Crisp for MVP support)
4. Should example data show industry-specific scenarios? (Offer 3 preset industry templates: Real Estate, Agency, SaaS)
5. Should admins create custom in-app onboarding for their team? (Post-MVP — valuable for [[Medium Businesses]])
