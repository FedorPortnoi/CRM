---
tags: [users, segment, medium-business, enterprise]
status: active
related: ["Pricing Model", "Sales Funnel Analytics", "Custom Workflows", "Mobile Field Access", "Competitive Landscape", "Open Questions"]
created: 2026-05-01
---

# Medium Businesses

## Profile

- **Team size:** 100–500 people
- **Revenue range:** $10M–$500M/year
- **Industries:** Multi-location retail, regional banks, mid-size manufacturing with field sales, national franchise systems, insurance brokerages, staffing agencies

## The Reality

At this scale, the CRM serves hundreds of concurrent users across multiple teams or regions. The sales function is professional and structured: team leads, sales operations, quarterly targets, formal reporting to executives. The CRM is mission-critical infrastructure.

**Core challenges:** Scale, governance, and cross-department coordination. Keeping 200 reps on the same process, preventing data silos, ensuring management has reliable visibility, maintaining data quality at scale.

## Primary Needs

1. **Multi-department access control** — Department A's deals shouldn't be visible to Department B (v2)
2. **Advanced analytics** — Executive dashboards, quarterly reporting, forecasting ([[Sales Funnel Analytics]])
3. **Permissions management** — Role-based field-level access control (v2)
4. **Deeper reporting** — Custom report builder, scheduled email reports, BI tool export (v1.5)
5. **API integrations** — Connect to ERP, accounting, customer support (v2)
6. **Field teams mobile** — Same [[Mobile Field Access]] quality as [[Small Businesses]], but at 5x scale

## Honest MVP Gaps for This Segment

- Multi-department data isolation → v2
- SSO / SAML → v2
- Field-level permissions → v2
- Public API + webhooks → v2
- Advanced report builder → v1.5
- Territory management → post-v2

We can serve this segment at MVP for the core CRM workflow. Advanced governance and integrations require v2.

## Procurement Process

- Stakeholders: Sales VP (champion), IT (security), Finance (cost)
- Sales cycle: 30–90 days from first demo to signed contract
- POC / pilot: 10–20 user pilot before full rollout
- Legal: data processing agreement required; SOC 2 Type II eventually required
- Pricing: negotiated; volume discounts for 100+ seats

**Contract size:** $35–45/user/month × 100–500 users = $42,000–$270,000/year. Requires account management.

## Competition at This Level

We start competing with [[Salesforce]] and Microsoft Dynamics here. Our winning arguments:
1. Mobile experience is dramatically better
2. Can be deployed in weeks, not months
3. Total cost of ownership significantly lower (no admin, no implementation partner)
4. Field teams will actually embrace it

## Design Implications

- Admin panel is critical: user management, permission config, audit logs
- API access non-negotiable for this segment
- Report export must be board-ready quality
- Performance at scale: 500 concurrent users, 100K+ contacts, 50K+ deals

## Related Notes

- [[Pricing Model]] — Business tier; enterprise pricing negotiated for 100+ seats
- [[Sales Funnel Analytics]] — executive dashboards for this segment
- [[Custom Workflows]] — automation rules needed at this scale
- [[Mobile Field Access]] — large field workforce
- [[Competitive Landscape]] — Salesforce is the comparison benchmark at this level
- [[Open Questions]] — several unresolved questions involve this segment's needs
