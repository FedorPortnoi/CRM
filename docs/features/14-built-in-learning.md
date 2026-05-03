# Feature 14: Built-In Learning & Assistance

## Overview

Built-In Learning makes the CRM self-teaching. Users should not need a manual, a training session, or an IT department to start using the product. The product teaches them as they go — showing the right hint at the right moment, offering a short tutorial video when they first encounter a complex feature, and providing ready-to-use examples so they're never staring at a blank form wondering what to do.

This is the feature that makes "zero learning curve" a reality, not just a marketing claim. In competitive analysis, Bitrix24 is notorious for requiring extensive onboarding and training. This platform deliberately designs the opposite experience: start simple, show what's relevant now, progressively reveal deeper features as the user grows into them.

For small business owners who are not tech-savvy, the difference between a tooltip at the right moment and having to search through documentation is often the difference between adoption and churn.

## User Stories

- **As a first-time user**, I want to see a brief welcome walkthrough that shows me the 3 most important things I can do so that I know how to get started without reading documentation.
- **As a non-technical user** trying the pipeline board for the first time, I want a tooltip explaining that I can drag cards between columns so that I discover the feature immediately.
- **As a business owner** who has just set up their first automation rule, I want to see a short tutorial video explaining what automations can do so that I understand how to use them effectively.
- **As a new team member**, I want to see an example of a fully filled-out contact profile so that I know what level of detail to aim for.
- **As a user** who hasn't used the analytics section before, I want to see a brief explanation of what each chart means when I open it for the first time so that I understand the data.
- **As a manager**, I want to be able to mark tutorials as completed for my team so that they see the next relevant one, not the ones they've already been through.

## Acceptance Criteria

- **Onboarding walkthrough:** 4-step overlay on first login: 1) Add first contact, 2) Create a deal, 3) Set a task reminder, 4) View your dashboard — each step has an arrow pointer to the relevant UI element and a "Got it" button
- **Contextual tooltips:** Shown once per feature per user; triggered on first visit to a screen or first interaction with a complex element; dismissed with a tap; never shown again after dismissal; stored in `user.onboarding_state JSONB`
- **Embedded tutorial videos:** Short (60–90 second) screen-recorded tutorials embedded in-app for: pipeline boards, automation rules, analytics dashboard, CSV import, calendar sync — accessible via "?" button on relevant screens
- **Feature hints:** Small "ⓘ" icon on complex fields (e.g., Automation rule trigger) — tap shows a short explanatory popover
- **Example data:** On first login, offer "Load example data" — creates 5 sample contacts, 2 sample deals, and 3 sample tasks with filled-out fields to show what a real configured CRM looks like; easily deleted in one tap
- **Progressive disclosure:** Advanced features (automation rules, custom fields, API access) are hidden from the main navigation for new users; they appear in settings after a configurable number of days or on explicit unlock by the user
- **Help button:** Persistent "?" button available on every screen; opens a context-aware help sheet with: 1 video link, 3 FAQ items relevant to current screen, link to full documentation, link to support chat
- Completion tracking: each tutorial/tooltip tracks seen/completed in `user.onboarding_state`; no repeated hints for completed steps

## Edge Cases

- User dismisses a tooltip accidentally: provide an "Undo dismiss" link that appears for 5 seconds after dismissal; after that, user can reset all hints via Settings → Help → Reset Tutorials
- Tutorial video fails to load (offline): show a text-based alternative description with the same information; do not show a broken video player
- Experienced user who finds hints annoying: provide a global "Disable all hints and tutorials" toggle in Settings → Help; off by default for first 30 days, then user may turn it off
- Team member added by an admin: onboarding walkthrough starts on their first login; admin cannot skip onboarding on behalf of team members
- Example data mixed with real data: example data is clearly tagged with a visual "Example" badge; a banner at top of contacts/deals list says "You have example data — clear it?" until removed
- Returning user who last used the app 6 months ago and features have changed: show a "What's new" sheet on first open after a major update listing new features

## Open Questions

1. Should tutorial videos be hosted in the app bundle (larger download) or streamed from CDN (requires internet)? CDN for all except the first-run walkthrough (which should be available offline).
2. Should there be an in-app AI assistant ("Ask me anything about the CRM")? High value but large scope — post-MVP. Can use Claude API for this in v2.
3. Should helpdesk chat (Intercom, Crisp) be embedded in the Help button? Yes — Crisp or Intercom for MVP support; configure in env settings.
4. Should the example data show industry-specific scenarios (real estate, agency, SaaS)? Offer 3 preset industry templates for the example data load.
5. Should admins be able to create custom in-app onboarding for their team (e.g., company-specific tutorials)? Post-MVP — valuable for larger organizations.

## Technical Notes

- Onboarding state: `user.onboarding_state JSONB` column stores: `{ walkthrough_completed, dismissed_tooltips: string[], watched_videos: string[], example_data_loaded, example_data_cleared }`
- Tooltip trigger: each tooltip has a string key (e.g., `pipeline_drag_hint`); on screen mount, check `onboarding_state.dismissed_tooltips` — if key not present, show tooltip
- Tutorial videos: hosted on S3/CDN as MP4; played via expo-av `Video` component; not streamed from YouTube (no YouTube dependency, works offline from cache)
- Progressive disclosure: feature flags stored in `organization.plan_features JSONB`; advanced features visible based on a combination of plan tier + account age threshold
- Example data: seeded via `POST /organization/load-example-data` endpoint; runs a seed script that inserts tagged records into the org; `DELETE /organization/clear-example-data` removes all tagged records via a `is_example_data = true` column flag
- Help sheet: each screen exports a `helpContext` object `{ videoId, faqKeys[] }`; the global Help button reads this from a React context and renders the appropriate content from a local FAQ JSON file (bundled with app, no API call needed for FAQ)
