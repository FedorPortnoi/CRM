# User Segment: Medium Businesses

## Profile

**Team size:** 100–500 people  
**Revenue range:** $10M–$500M/year  
**Industries:** Multi-location retail, regional banks, mid-size manufacturing with field sales, national franchise systems, insurance brokerages, staffing agencies, logistics companies

## The Reality of Their Work

At this scale, the CRM serves dozens or hundreds of concurrent users across multiple teams, departments, or regions. The sales function is professional and structured: there are team leads, sales operations, quarterly targets, and formal reporting to executives. The CRM is no longer optional infrastructure — it is mission-critical.

The core challenges at this size are **scale, governance, and cross-department coordination**: keeping 200 reps on the same process, preventing data silos between departments, ensuring management has reliable visibility without micromanaging, and maintaining data quality at scale.

This segment is where we begin to bump up against the limits of our MVP feature set and the advantages of incumbent platforms become real. However, many organizations in this range use Bitrix24 or a basic Salesforce configuration and are still frustrated by complexity and mobile limitations. We can serve them well at MVP with room to grow.

## Primary Needs

1. **Multi-department access control** — Department A's deals should not be visible to Department B unless a manager enables it.
2. **Advanced analytics** — Executive dashboards, quarterly reporting, forecasting, and territory analysis.
3. **Permissions management** — Not everyone should be able to edit all contacts or see all deals. Role-based access.
4. **Deeper reporting** — Custom report builder, scheduled email reports, data export for BI tools (Tableau, Power BI).
5. **Integration with existing tools** — Their ERP, accounting system, or customer support platform. API + webhooks become necessary.
6. **Mobile for field teams** — Often have a large field workforce that needs the same CRM quality as desk-based teams.

## What They Need That MVP Does Not Fully Support

These are honest gaps for this segment at MVP. They should be flagged to prospects:
- Multi-department data isolation (v2 roadmap)
- SSO / SAML integration (v2 roadmap)
- Field-level permissions (v2 roadmap)
- Public API for ERP integration (v2 roadmap)
- Advanced report builder (v1.5 roadmap)
- Territory management (post-v2)

## How Different Roles Use the CRM

**VP of Sales / Sales Director:** Reviews executive dashboard weekly. Monitors quarterly pipeline vs. target. Exports reports for board presentations. Sets team targets.

**Sales Operations Manager:** Configures pipelines, stages, custom fields, and automation rules. Manages data quality. Creates team reports. Manages user permissions and team structure.

**Regional Manager:** Views their team's pipeline and performance metrics. Reassigns deals. Runs weekly 1:1s using the CRM data as the agenda.

**Sales Rep:** Same as small business segment — daily tool for contacts, deals, tasks, calls.

**Field Rep:** Fully mobile-only. Needs offline capability. Location tagging for territory management.

## Acquisition Process

Medium businesses have a formal procurement process:
- Stakeholders: Sales VP (champion), IT (security review), Finance (cost approval)
- Typical sales cycle: 30–90 days from first demo to signed contract
- POC / pilot: often required with a 10–20 user pilot before full rollout
- Legal: data processing agreement (DPA) required; SOC 2 Type II certification may be required (post-MVP goal)
- Pricing: often negotiated; volume discounts for 100+ seats

**Target price point:** $35–45/user/month for the Business tier at 100–500 seats → $42,000–$270,000/year. This is a significant contract that justifies account management.

## Competition at This Level

At 100–500 users, we start competing more directly with Salesforce and Microsoft Dynamics, which have significant enterprise credibility. Our winning arguments:
1. Our mobile experience is dramatically better
2. We can be deployed in weeks, not months
3. Total cost of ownership is significantly lower (no admin, no implementation partner needed)
4. The UX is something their field teams will actually embrace

## Design Implications

- Admin panel becomes critical at this scale: user management, permission configuration, audit logs
- API access is non-negotiable for this segment — they need to connect the CRM to other systems
- Data export quality matters: reports must be board-ready, not rough CSV dumps
- Performance at scale: 500 concurrent users, 100,000+ contacts, 50,000+ deals — architecture must hold
- Support SLA: this segment expects < 4 hour response for critical issues; dedicated account manager for largest accounts
