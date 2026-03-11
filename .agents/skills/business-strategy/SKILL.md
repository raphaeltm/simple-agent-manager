---
name: business-strategy
description: "Business strategy and planning. Builds market sizing (TAM/SAM/SOM), business model canvas, pricing analysis, revenue models, and go-to-market plans. Use when sizing markets, planning pricing, modeling revenue, or building GTM strategy."
---

# Business Strategy

Develop and maintain business strategy artifacts — market sizing, business model, pricing, revenue modeling, and go-to-market planning.

## When to Use

- Sizing the market opportunity (TAM/SAM/SOM)
- Defining or refining the business model
- Analyzing pricing strategy (yours or competitors')
- Building revenue projections and unit economics
- Planning go-to-market strategy
- Preparing for investor conversations or strategic decisions

## Workflow

### 1. Understand Current State

Before creating any artifact, check what already exists:
- Read `strategy/business/` for existing business docs
- Read `strategy/competitive/` for competitor pricing and market data
- Read `strategy/marketing/positioning.md` for target market definition
- Check the product's current pricing/plans if any

### 2. Frameworks

**TAM/SAM/SOM Analysis**

Use both top-down and bottom-up approaches:

```markdown
# Market Sizing

**Last Updated**: YYYY-MM-DD
**Update Trigger**: Annually, or when entering new segment

## Methodology

### Top-Down
- Total market: [industry reports, analyst estimates]
- Segmentation: [by geography, company size, use case]

### Bottom-Up
- Target companies: [count] in [segments]
- Average deal size: $[amount]/[period]
- Realistic penetration: [%] in [timeframe]

## TAM (Total Addressable Market)
[All potential revenue if 100% market share]
**Estimate**: $[X]
**Assumptions**: [list]

## SAM (Serviceable Available Market)
[Subset we can realistically reach with current product/channels]
**Estimate**: $[X]
**Assumptions**: [list]

## SOM (Serviceable Obtainable Market)
[Realistic near-term capture]
**Estimate**: $[X]
**Assumptions**: [list]

## Assumptions Register
| # | Assumption | Confidence | Source | Impact if Wrong |
|---|-----------|-----------|--------|----------------|
| 1 | [assumption] | High/Med/Low | [source] | [what changes] |
```

**Business Model Canvas**
```markdown
# Business Model Canvas

**Last Updated**: YYYY-MM-DD

| Block | Description |
|-------|------------|
| **Value Propositions** | [What value we deliver] |
| **Customer Segments** | [Who we serve] |
| **Channels** | [How we reach them] |
| **Customer Relationships** | [How we interact] |
| **Revenue Streams** | [How we make money] |
| **Key Resources** | [What we need to deliver] |
| **Key Activities** | [What we must do well] |
| **Key Partnerships** | [Who we depend on] |
| **Cost Structure** | [Major cost categories] |
```

**Pricing Framework**
```markdown
# Pricing Analysis

**Last Updated**: YYYY-MM-DD
**Update Trigger**: Quarterly, or competitor pricing change

## Competitor Pricing
| Competitor | Model | Free Tier | Paid Plans | Enterprise |
|-----------|-------|-----------|-----------|-----------|
| [Name] | [per-seat/usage/flat] | [details] | [details] | [details] |

## Value Metric Analysis
[What unit of value do customers pay for? Seats? Usage? Projects?]

## Recommended Pricing
### Tier Structure
| Tier | Price | Includes | Target Segment |
|------|-------|---------|---------------|

### Justification
[Why this structure, based on competitive data and value analysis]

### Sensitivity Analysis
[What happens to conversion/revenue if price is +/- 20%?]
```

**Unit Economics**
```markdown
# Unit Economics

## Key Metrics
| Metric | Current | Target | Notes |
|--------|---------|--------|-------|
| CAC (Customer Acquisition Cost) | $[X] | $[X] | [how calculated] |
| LTV (Lifetime Value) | $[X] | $[X] | [assumptions] |
| LTV:CAC Ratio | [X]:1 | 3:1+ | |
| Payback Period | [X] months | [X] months | |
| Gross Margin | [X]% | [X]% | |
| Monthly Churn | [X]% | <[X]% | |

## Assumptions
[What must be true for these numbers to hold]
```

**Go-to-Market Plan**
```markdown
# Go-to-Market Plan

**Last Updated**: YYYY-MM-DD

## Phase 1: [Name] (Timeline)
**Goal**: [metric-based goal]
**Channels**: [primary channels]
**Actions**:
- [ ] [specific action with owner]

## Phase 2: [Name] (Timeline)
...

## Success Metrics
| Metric | Baseline | Target | Measurement |
|--------|---------|--------|------------|
```

### 3. Output Artifacts

Save to `strategy/business/`:
- `market-sizing.md` — TAM/SAM/SOM analysis
- `business-model.md` — Business Model Canvas with rationale
- `pricing.md` — Pricing analysis and recommendations
- `revenue-model.md` — Revenue projections and unit economics
- `gtm-plan.md` — Go-to-market plan

### 4. Revenue Modeling

When asked to model revenue:
1. Define assumptions explicitly (conversion rates, churn, growth, pricing)
2. Build three scenarios: conservative, base, optimistic
3. Show sensitivity to key variables
4. Present as a table with monthly or quarterly granularity
5. Flag which assumptions have the most impact on outcomes

### 5. Cross-Reference

After producing business artifacts:
- Validate pricing against `strategy/competitive/` competitor data
- Align target segments with `strategy/marketing/positioning.md`
- Feed GTM channel decisions to `strategy/marketing/channel-strategy.md`
- Inform engineering roadmap priorities based on market opportunity

## Quality Standards

- **Explicit assumptions** — Every number must have a stated assumption and source
- **Multiple estimation methods** — TAM/SAM should use both top-down and bottom-up
- **Date all market data** — Markets change; date your data points
- **Sensitivity analysis** — Show what happens when key assumptions are wrong
- **Separate facts from projections** — Competitor pricing is a fact; your revenue projection is a guess
- **Conservative by default** — When uncertain, use the lower estimate and note the upside case
