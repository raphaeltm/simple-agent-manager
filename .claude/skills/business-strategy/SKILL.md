---
name: business-strategy
description: Business strategy and planning. Builds market sizing (TAM/SAM/SOM), business model canvas, pricing analysis, revenue models, and go-to-market plans. Trigger when asked about market sizing, pricing strategy, business model, revenue projections, unit economics, or GTM planning.
user-invocable: true
---

# Business Strategy

Develop and maintain business strategy artifacts stored in `strategy/business/`.

## Prerequisites

Before creating any artifact, read:
- `strategy/business/` for existing business docs
- `strategy/competitive/` for competitor pricing and market data
- `strategy/marketing/positioning.md` for target market definition

## Frameworks

### TAM/SAM/SOM
Use both top-down (industry reports, analyst estimates) and bottom-up (target company count x deal size x penetration rate). List all assumptions explicitly with confidence levels and sources.

### Business Model Canvas (Osterwalder)
Nine blocks: value propositions, customer segments, channels, customer relationships, revenue streams, key resources, key activities, key partnerships, cost structure.

### Pricing Framework
Competitor pricing table, value metric analysis (what unit do customers pay for?), recommended tiers with justification, sensitivity analysis.

### Unit Economics
CAC, LTV, LTV:CAC ratio, payback period, gross margin, monthly churn. State assumptions for each.

### Go-to-Market Plan
Phased plan with channels, metrics, milestones, and success criteria per phase.

## Output Artifacts

Save to `strategy/business/`:
- `market-sizing.md` — TAM/SAM/SOM with methodology, assumptions register
- `business-model.md` — Filled canvas with rationale for each block
- `pricing.md` — Competitor pricing table, value metric analysis, recommended tiers, sensitivity
- `revenue-model.md` — Three scenarios (conservative/base/optimistic) with explicit assumptions
- `gtm-plan.md` — Phased plan with metrics and milestones

## Quality Standards

- Every number must have a stated assumption and source
- Use multiple estimation methods for market sizing
- Date all market data
- Show sensitivity analysis for key variables
- Separate facts from projections
- Conservative by default — use lower estimates, note upside case
- Include `Last Updated` date and update trigger on every document
