# Pricing Strategy

## Guiding Principles

1. **Priced for SMBs, not enterprise.** Our customers are small business owners and entrepreneurs. Pricing must feel fair and predictable relative to the value they get.
2. **Per-seat, no hidden limits.** Simple per-user pricing avoids the HubSpot trap of aggressive feature gating that forces painful tier jumps.
3. **Free trial, not freemium.** A time-limited full-featured trial is better than a feature-limited free tier that either locks users out of core features or cannibalizes revenue.
4. **Annual discount drives retention.** Annual commitment reduces churn and provides predictable revenue.
5. **Pricing should not be a reason someone chooses a competitor.** We should be clearly cheaper than Bitrix24/HubSpot/Salesforce for equivalent functionality.

---

## Proposed Pricing Tiers

### Starter — $14/user/month (billed annually) | $18/user/month (billed monthly)

**For:** Solo entrepreneurs and freelancers (1–3 users)

Includes:
- All 14 MVP features
- Up to 2,500 contacts
- Up to 3 pipelines
- 100 SMS messages/month
- 5GB file storage
- Email support

### Growth — $24/user/month (billed annually) | $30/user/month (billed monthly)

**For:** Micro and small businesses (4–50 users)

Everything in Starter, plus:
- Unlimited contacts
- Unlimited pipelines
- 500 SMS/month (additional at $0.05/SMS)
- 25GB file storage
- Custom automation rules (up to 20)
- Team analytics and reports
- Priority support (email + chat)
- Google Calendar sync

### Business — $39/user/month (billed annually) | $49/user/month (billed monthly)

**For:** Small and medium businesses (50–500 users)

Everything in Growth, plus:
- 2,000 SMS/month included
- 100GB file storage
- Advanced analytics and custom reports
- API access + webhooks
- Multiple departments / team groups
- SSO (Google Workspace, SAML) — v2
- Dedicated onboarding call
- Dedicated account manager (for 20+ seat accounts)
- Custom automation rules (unlimited)
- SLA: 99.9% uptime guarantee

---

## Free Trial

- **14-day full-featured trial** with no credit card required
- All Business tier features during trial
- At trial end: prompt to choose a plan; data retained for 30 days before deletion
- Option to extend to 30 days if user has added at least 10 contacts and 2 deals (engaged users get more time)

---

## Pricing Comparison vs. Competitors

| Plan | Our Price (Growth) | Bitrix24 Basic | HubSpot Starter | Salesforce Starter | Pipedrive Essential |
|------|--------------------|----|----|----|-----|
| Per user / month | $24 | $9.80 (min 5 users) | $20 | $25 | $14.90 |
| Offline mobile | Yes | No | No | No | No |
| Auto-capture | Yes | Partial | Partial | Yes | No |
| Custom workflows | Yes | Yes | Partial | Yes | No |
| Min. annual cost (5 users) | $1,440 | $588 | $1,200 | $1,500 | $894 |

*Note: Bitrix24 appears cheaper at small team sizes but requires significantly more implementation work. The total cost of ownership (admin time + onboarding) makes it more expensive in practice.*

---

## Revenue Projections (Conservative)

| Month | Paying Orgs | Avg Users/Org | Avg MRR/User | MRR | ARR Run Rate |
|-------|-------------|---------------|-------------|-----|-------------|
| M3 (beta) | 20 | 4 | $22 | $1,760 | $21,120 |
| M6 (post-launch) | 80 | 5 | $22 | $8,800 | $105,600 |
| M12 | 250 | 6 | $24 | $36,000 | $432,000 |
| M18 | 600 | 8 | $26 | $124,800 | $1,497,600 |

---

## Special Pricing Programs

- **Startup discount:** 50% off first 6 months for companies < 1 year old (with valid registration proof)
- **Non-profit discount:** 40% off any plan with 501(c)(3) or equivalent documentation
- **Annual upfront bonus:** 2 months free if paying full year upfront (effectively 2 months free vs. monthly billing)
- **Referral program:** Refer a paying customer → both get 1 month free

---

## Open Questions

1. Should we offer a free individual tier (solo entrepreneurs, no team features) to maximize top-of-funnel? Risk: reduces conversion to paid; benefit: organic growth and brand awareness.
2. What is the right SMS bundle? Include 100/500/2000 per org/month, or per-user? Per-org is simpler and less punishing for teams.
3. Should API access be gated to Business tier, or available to all paid plans? Keeping API on Business protects support costs (API users generate more tickets).
4. Should we offer monthly billing at all, or push everyone to annual? Monthly reduces commitment barrier; annual improves retention. Offer both.
5. At what org size should we switch to custom/enterprise pricing? Proposed: 100+ users gets a call; 200+ users gets custom contract.
