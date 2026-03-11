---
name: competitive-research
description: "Competitive research and market analysis. Builds competitor profiles, feature matrices, SWOT analyses, and positioning maps. Use when analyzing competitors, understanding market landscape, or identifying competitive gaps."
---

# Competitive Research

Perform structured competitive research and produce actionable intelligence artifacts.

## When to Use

- Analyzing a specific competitor
- Building or updating the feature comparison matrix
- Identifying competitive gaps to inform roadmap or marketing
- Preparing battlecards for positioning against a competitor
- Understanding market landscape and trends

## Workflow

### 1. Determine Scope

Ask the user what they need:
- **Single competitor deep-dive** → Competitor profile document
- **Market landscape overview** → Landscape analysis + positioning map
- **Feature comparison** → Feature parity matrix
- **Gap analysis** → What competitors have that we don't (and vice versa)
- **SWOT** → Structured strengths/weaknesses/opportunities/threats

### 2. Research Phase

Use web search and web fetch to gather data from:
- Competitor websites (product pages, pricing, about, docs)
- Product changelogs and release notes (reveals velocity + priorities)
- G2, Capterra, TrustRadius reviews (customer language mining)
- Job postings (hiring signals reveal strategic direction)
- Social media profiles and posting patterns
- Community discussions (Reddit, HN, Discord)
- Blog posts and conference talks from competitor teams
- GitHub repos (for open-source competitors — stars, activity, architecture)

### 3. Analysis Frameworks

Apply the appropriate framework(s):

**SWOT Analysis**
```markdown
## SWOT: [Competitor Name]

### Strengths
- [What they do well, verified from evidence]

### Weaknesses
- [Where they fall short, from reviews/gaps]

### Opportunities
- [Market shifts that could benefit them]

### Threats
- [Risks to their position]
```

**Feature Parity Matrix**
```markdown
| Feature | SAM | Competitor A | Competitor B |
|---------|-----|-------------|-------------|
| Feature 1 | Yes | Yes | Partial |
| Feature 2 | No | Yes | Yes |
```
Use: Yes / Partial / No / Planned / Unknown

**Positioning Map**
```markdown
## Positioning Map

Axes: [Dimension 1] vs [Dimension 2]
(Choose the two dimensions most relevant to buyer decisions)

| Competitor | [Dim 1] Score | [Dim 2] Score | Notes |
|-----------|--------------|--------------|-------|
```

**Competitor Profile Template**
```markdown
# Competitor Profile: [Name]

**Last Updated**: YYYY-MM-DD
**Category**: [Direct / Indirect / Adjacent]
**Website**: [URL]

## Overview
[What they do, who they serve, how they position]

## Target Market
[Who they sell to, what segments]

## Product
[Key features, architecture, tech stack if known]

## Pricing
[Pricing model, tiers, notable terms]

## Strengths
[What they do well]

## Weaknesses
[Where they fall short — cite reviews/evidence]

## Recent Moves
[Last 6 months: launches, pivots, funding, hires]

## Strategic Direction
[Where they appear to be heading, based on evidence]

## Key Differentiators vs SAM
[What makes them different from us — both advantages and disadvantages]
```

### 4. Output Artifacts

Save artifacts to the appropriate location:
- Competitor profiles → `strategy/competitive/competitors/[name].md`
- Feature matrix → `strategy/competitive/feature-matrix.md`
- Positioning map → `strategy/competitive/positioning-map.md`
- Landscape overview → `strategy/competitive/landscape.md`

### 5. Cross-Reference

After producing research:
- Flag findings relevant to **marketing** (positioning gaps, messaging opportunities)
- Flag findings relevant to **engineering** (feature gaps to consider for roadmap)
- Flag findings relevant to **business** (pricing insights, market sizing data)
- Suggest which downstream documents should be updated

## Quality Standards

- **Date-stamp all data points** — "Competitor X charges $50/seat (verified YYYY-MM-DD)"
- **Separate facts from inferences** — "Their pricing page shows..." vs "This suggests they are targeting..."
- **Cite sources** — Link to the page/review/post where information was found
- **Flag confidence levels** — High (from their own site), Medium (from reviews/reports), Low (inferred from indirect signals)
- **Note what you couldn't find** — Gaps in research are useful information too
