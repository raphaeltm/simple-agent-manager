---
name: engineering-strategy
description: "Engineering strategy and technical planning. Builds roadmaps (Now/Next/Later), technology radar assessments, build-vs-buy analyses, and tech debt registers. Use when planning roadmap, evaluating technologies, assessing tech debt, or making build-vs-buy decisions."
---

# Engineering Strategy

Develop and maintain engineering strategy artifacts — roadmaps, technology assessments, build-vs-buy decisions, and tech debt tracking.

## When to Use

- Planning or updating the product roadmap
- Evaluating whether to adopt a new technology
- Making a build-vs-buy decision
- Auditing and prioritizing technical debt
- Aligning engineering priorities with business strategy
- Creating Architecture Decision Records

## Workflow

### 1. Understand Current State

Before creating any artifact, check what already exists:
- Read `strategy/engineering/` for existing engineering docs
- Read `strategy/competitive/feature-matrix.md` for feature gaps
- Read `strategy/business/` for business priorities and market opportunity
- Read `docs/adr/` for existing architecture decisions
- Scan `specs/` for feature specifications and their status
- Review `tasks/` for current backlog and active work

### 2. Frameworks

**Now/Next/Later Roadmap**

Avoids false precision of timeline-based roadmaps:

```markdown
# Engineering Roadmap

**Last Updated**: YYYY-MM-DD
**Update Trigger**: Start of each planning cycle

## Now (Current Cycle)
Active work with committed resources.

| Initiative | Goal | Status | Links |
|-----------|------|--------|-------|
| [Name] | [What success looks like] | [In Progress/Blocked] | [spec/task links] |

## Next (Following Cycle)
Planned work, dependencies identified, not yet started.

| Initiative | Goal | Depends On | Business Driver |
|-----------|------|-----------|----------------|
| [Name] | [What it achieves] | [blockers] | [why it matters] |

## Later (Backlog)
Important but not yet scheduled. Ordered by priority.

| Initiative | Goal | Business Driver | Effort Estimate |
|-----------|------|----------------|----------------|

## Decisions Needed
[List of open questions that block roadmap items]

## Completed (Last 2 Cycles)
[Recently shipped for context]
```

**Technology Radar (ThoughtWorks-style)**

Four quadrants, four rings:

```markdown
# Technology Radar

**Last Updated**: YYYY-MM-DD
**Update Trigger**: Quarterly

## Quadrants
- **Techniques**: Development practices, patterns, approaches
- **Tools**: Build tools, testing frameworks, dev tools
- **Platforms**: Infrastructure, cloud services, runtime environments
- **Languages & Frameworks**: Programming languages and major frameworks

## Rings
- **Adopt**: Proven, recommended for broad use
- **Trial**: Worth pursuing in a limited context
- **Assess**: Worth exploring, not ready for commitment
- **Hold**: Proceed with caution, or actively moving away from

## Current Radar

### Techniques
| Technology | Ring | Rationale | Last Assessed |
|-----------|------|-----------|--------------|

### Tools
| Technology | Ring | Rationale | Last Assessed |
|-----------|------|-----------|--------------|

### Platforms
| Technology | Ring | Rationale | Last Assessed |
|-----------|------|-----------|--------------|

### Languages & Frameworks
| Technology | Ring | Rationale | Last Assessed |
|-----------|------|-----------|--------------|
```

**Build vs Buy Decision Matrix**

```markdown
# Build vs Buy: [Component Name]

**Date**: YYYY-MM-DD
**Decision**: [Build / Buy / Open Source + Customize]
**Status**: [Proposed / Accepted / Superseded]

## Context
[Why this decision is needed now]

## Options Evaluated

### Option 1: Build In-House
| Criterion | Score (1-5) | Weight | Weighted |
|----------|-----------|--------|---------|
| Strategic differentiation | | 3 | |
| Time to value | | 2 | |
| Maintenance burden | | 2 | |
| Integration complexity | | 2 | |
| Total cost (2yr) | | 3 | |
| Vendor/dependency risk | | 1 | |
| **Total** | | | |

### Option 2: [Vendor/Tool Name]
[Same matrix]

### Option 3: [Alternative]
[Same matrix]

## Total Cost of Ownership (2-Year)
| | Build | Buy | OSS+Customize |
|---|------|-----|---------------|
| Initial cost | | | |
| Annual maintenance | | | |
| Integration effort | | | |
| Training/onboarding | | | |
| **Total** | | | |

## Recommendation
[Which option and why, with reversibility assessment]

## Risks
[What could go wrong with the chosen approach]
```

**Tech Debt Register**

```markdown
# Tech Debt Register

**Last Updated**: YYYY-MM-DD
**Update Trigger**: When new debt is identified or debt is paid down

## Summary
| Priority | Count | Estimated Effort |
|---------|-------|-----------------|
| Critical | | |
| High | | |
| Medium | | |
| Low | | |

## Register

### [ID]: [Short Description]
- **Priority**: [Critical/High/Medium/Low]
- **Type**: [Reckless-Deliberate / Prudent-Deliberate / Reckless-Inadvertent / Prudent-Inadvertent]
- **Location**: [file paths or component names]
- **Impact**: [What problems this causes]
- **Remediation**: [What fixing it looks like]
- **Effort**: [T-shirt size: S/M/L/XL]
- **Business Case**: [Why we should fix it — in business terms]
- **Added**: YYYY-MM-DD
- **Status**: [Open / In Progress / Resolved]
```

### 3. Output Artifacts

Save to `strategy/engineering/`:
- `roadmap.md` — Now/Next/Later roadmap
- `tech-radar.md` — Technology assessment radar
- `tech-debt.md` — Prioritized tech debt register
- `strategy/engineering/adr/NNN-[title].md` — Architecture Decision Records

For ADRs, also consider placing them in the main `docs/adr/` directory if they relate to implemented architecture (vs. strategic/evaluative decisions).

### 4. Roadmap Prioritization

When helping prioritize roadmap items, consider:

1. **Business impact** — Does this unlock revenue, reduce churn, or open new segments?
2. **Competitive necessity** — Is this table-stakes that competitors already have?
3. **Technical leverage** — Does this make future work significantly easier?
4. **User demand** — Are users asking for this? (Evidence from support, reviews, community)
5. **Effort** — How much work relative to impact?
6. **Dependencies** — Does anything else block on this?

Present as a 2x2 matrix (Impact vs. Effort) when helpful.

### 5. Cross-Reference

After producing engineering artifacts:
- Validate roadmap priorities against `strategy/competitive/feature-matrix.md` gaps
- Align with `strategy/business/` market opportunity and GTM timing
- Feed completed features to `strategy/marketing/` for positioning updates
- Flag roadmap items that need specs (`specs/`) or task files (`tasks/`)

## Quality Standards

- **Link to business drivers** — Every roadmap item should state why it matters to the business
- **Distinguish committed vs aspirational** — "Now" is committed; "Later" is aspirational
- **Include effort estimates** — Even rough ones help prioritization
- **Track decisions, not just outcomes** — ADRs capture the reasoning, not just the result
- **Update, don't append** — Move completed items to "Completed" section; don't let the roadmap grow forever
