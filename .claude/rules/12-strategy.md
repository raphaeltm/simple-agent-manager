# Strategy Document Standards

## Strategy Directory

All strategic planning artifacts live in `strategy/` with subdirectories for each domain:

- `strategy/competitive/` — Competitor research, feature matrices, positioning maps
- `strategy/business/` — Market sizing, business model, pricing, GTM
- `strategy/marketing/` — Positioning, messaging, content calendar, channel strategy
- `strategy/engineering/` — Roadmap, tech radar, tech debt, build-vs-buy
- `strategy/content/` — Content drafts and templates

## Available Skills

| Skill | Command | Purpose |
|-------|---------|---------|
| Competitive Research | `/competitive-research` | Competitor profiles, feature matrices, SWOT, positioning maps |
| Marketing Strategy | `/marketing-strategy` | Positioning, messaging, gap analysis, channel strategy |
| Business Strategy | `/business-strategy` | Market sizing, pricing, business model, GTM, revenue modeling |
| Engineering Strategy | `/engineering-strategy` | Roadmap, tech radar, build-vs-buy, tech debt |
| Content Creation | `/content-create` | Social posts, blog outlines, changelogs, launch copy |

## Domain Chaining

Strategy domains feed each other in a specific order. When working in one domain, check upstream inputs and flag downstream impacts:

```
Competitive Research → Marketing Strategy → Content Creation
       │                      │                    ▲
       └──────────────→ Business Strategy           │
                              │                    │
                              → Engineering Strategy ┘
```

## Document Quality Rules

### All Strategy Documents Must:

1. **Include `Last Updated` date** — Strategy docs go stale. Every document must show when it was last verified.

2. **Specify an update trigger** — What event means this document needs review (competitor launch, quarterly cycle, pricing change, etc.).

3. **Separate facts from inferences** — Use clear markers:
   - Fact: "Competitor X charges $50/seat (source: pricing page, verified 2026-03-11)"
   - Inference: "This suggests they are targeting mid-market teams"

4. **Cite sources** — Link to where information was found. Unsourced claims have no value.

5. **Date-stamp data points** — Market data, competitor pricing, and feature comparisons must include verification dates.

6. **List assumptions explicitly** — Every projection or estimate must state what must be true for it to hold.

7. **Keep documents focused** — One topic per file. A 3-page doc gets maintained; a 30-page strategy deck does not.

### Content Creation Must:

1. **Read messaging guide first** — Never create content without checking `strategy/marketing/messaging-guide.md` for voice, tone, and approved language.

2. **Trace back to positioning** — Every piece of content should connect to a positioning decision or messaging theme.

3. **Be platform-native** — LinkedIn posts should not read like tweets; HN submissions should not read like marketing copy.

4. **Provide variants** — Always offer 2-3 options for headlines, hooks, and CTAs so the human can choose.

## What AI Does vs. What Humans Decide

### AI Does Well (Lean Into)
- Research and synthesis — gathering scattered information into structured views
- Framework application — filling in SWOT, BMC, feature matrices from available data
- Consistency enforcement — ensuring messaging stays aligned across artifacts
- Draft generation — producing 70-80% complete artifacts for human refinement
- Gap identification — systematically checking what's missing from a plan
- Format transformation — strategy doc → blog post → social posts → email
- Maintenance — flagging stale documents, updating matrices

### Requires Human Judgment (Flag, Don't Decide)
- Final strategic decisions — which market, how to price, what to build
- Brand taste and voice — the difference between good and great copy
- Relationship context — partner dynamics, customer relationships
- Risk appetite — how aggressive to be with positioning or pricing
- Prioritization of competing goals — when growth vs profitability conflict
