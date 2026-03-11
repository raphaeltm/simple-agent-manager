---
name: competitive-research
description: Competitive research and market analysis. Builds competitor profiles, feature matrices, SWOT analyses, and positioning maps. Trigger when asked about competitors, market landscape, competitive gaps, or feature comparisons.
user-invocable: true
---

# Competitive Research

Perform structured competitive research and produce actionable intelligence artifacts stored in `strategy/competitive/`.

## Workflow

1. **Determine scope** — Ask the user: single competitor deep-dive, market landscape overview, feature comparison, gap analysis, or SWOT?
2. **Research** — Use web search/fetch to gather data from competitor websites, pricing pages, docs, changelogs, reviews (G2/Capterra), job postings, social media, community discussions, GitHub repos
3. **Analyze** — Apply the appropriate framework (see below)
4. **Save** — Write artifacts to `strategy/competitive/`
5. **Cross-reference** — Flag findings relevant to marketing (positioning gaps), engineering (feature gaps for roadmap), and business (pricing insights)

## Frameworks

### Competitor Profile
Save to `strategy/competitive/competitors/[name].md`:
- Overview, target market, product summary, pricing, strengths, weaknesses, recent moves, strategic direction, key differentiators vs SAM
- Date-stamp all data points, cite sources, flag confidence levels (High/Medium/Low)

### Feature Parity Matrix
Save to `strategy/competitive/feature-matrix.md`:
- Grid of competitors x features with status: Yes / Partial / No / Planned / Unknown

### SWOT Analysis
Strengths, Weaknesses, Opportunities, Threats — verified from evidence, not guesses.

### Positioning Map
Save to `strategy/competitive/positioning-map.md`:
- 2D plot on the two dimensions most relevant to buyer decisions
- Propose dimensions, populate from research

### Landscape Overview
Save to `strategy/competitive/landscape.md`:
- Categories of competitors (direct, indirect, adjacent), market trends, emerging threats

## Quality Standards

- Date-stamp all data: "Competitor X charges $50/seat (verified YYYY-MM-DD)"
- Separate facts from inferences: "Their pricing page shows..." vs "This suggests..."
- Cite sources with links
- Note what you couldn't find — gaps are useful information
- Include `Last Updated` date and update trigger on every document
