# User Segment: Small Businesses

## Profile

**Team size:** 10–100 people  
**Revenue range:** $1M–$50M/year  
**Industries:** Regional distributors, mid-size agencies, growing SaaS companies, professional services firms (law, accounting, engineering), franchise operations, wholesale businesses

## The Reality of Their Work

At this scale, the CRM becomes infrastructure — not a nice-to-have. The business has multiple salespeople, multiple pipelines (maybe different products or regions), a defined sales process, and a manager who needs real visibility into team performance. They likely have or have had a CRM before — possibly Bitrix24, Salesforce, or HubSpot — and either found it too complex, too expensive, or both.

The core pain is **pipeline management at team scale**: ensuring deals are progressing, reps are following up, leads are not falling through the cracks, and managers can identify problems before they become lost deals. They need reporting that is genuinely useful, not just pretty charts.

## Primary Needs

1. **Full pipeline management** — Complete visibility into all deals, all stages, all reps, in real time.
2. **Team coordination** — Task assignment, shared contact database, interaction history accessible by all team members.
3. **Analytics and reporting** — Conversion rates, stage duration, win/loss analysis, revenue forecasting — actionable numbers for weekly reviews.
4. **Interaction history** — When a rep leaves or is unavailable, the manager or another rep can pick up any relationship without information loss.
5. **Custom workflows** — The ability to model the company's actual sales process, not a generic template.
6. **Mobile field access** — Sales reps are often on the road; they need full CRM capability on their phones, even offline.

## What They Need in v2 (Not MVP)

- Multi-department isolation (separate pipelines + teams that can't see each other's data)
- SSO (SAML/Google Workspace) for IT-managed authentication
- Advanced permissions (field-level access control)
- API + webhook integrations with ERP/accounting systems

## How Different Roles Use the CRM

**Sales manager:** Reviews pipeline board weekly. Tracks team performance via analytics. Reassigns stale deals. Monitors task completion rates. Runs Monday morning standup from the dashboard.

**Sales rep:** Uses the app as a daily work tool. Logs calls and notes. Updates deal stages. Sets follow-up tasks. Uses Kanban board to manage their individual pipeline.

**Account manager:** Manages existing clients. Uses interaction history to stay on top of relationships. Schedules check-in meetings. Tracks renewal deals in the pipeline.

**Operations / Admin:** Manages contacts database quality (deduplication, tagging, field consistency). Configures pipeline stages and custom fields. Runs and exports reports.

## Common Scenarios

- 40-person IT services company: 5 sales reps + 1 sales manager using the CRM daily. Manager reviews pipeline in Monday standup. Reps update deal stages and log calls from their phones all day.
- 25-person marketing agency: 3 business development reps, 1 director. Separate pipelines for new clients, retainer renewals, and project expansions. Analytics show which industry verticals have the best close rates.
- 60-person wholesale distributor: 8 regional sales reps working entirely in the field. Fully offline-capable. Reps visit clients, take orders (captured as deals), log visits with location tagging.

## Acquisition and Pricing Sensitivity

Small businesses have a budget process. The decision often involves multiple stakeholders (sales manager, IT if they exist, finance). Key dynamics:
- Demo is usually required before purchase
- IT team (if present) will ask about security, data residency, and SLA
- They will compare us explicitly to HubSpot, Bitrix24, and Pipedrive
- The win is: comparable features to HubSpot Pro at a fraction of the cost, with better mobile

**Target price point:** $24/user/month → 30-person team = $720/month → $8,640/year. This is directly in their budget zone and 60% cheaper than Salesforce at similar team size.

## Metrics That Matter

- **Pipeline coverage ratio:** Are reps keeping enough deals in the pipeline to hit revenue targets? This is visible from analytics.
- **Deal velocity:** Average days from deal creation to close — should decrease as team gets better at the process
- **System-wide adoption rate:** If 10 of 15 sales reps are daily active but 5 are not, there's an adoption problem that needs addressing

## Design Implications

- Manager-vs-rep views must be first-class: a manager opening the app should land on team overview; a rep should land on their personal task list and pipeline
- Bulk operations become important at this scale (bulk assign 50 contacts, bulk move deals, bulk export)
- Search must handle 10,000+ contacts with sub-300ms response
- Export and reporting workflows must be robust — these users run reports for board meetings
