---
name: engineering-strategy
description: Engineering strategy and technical planning. Builds roadmaps (Now/Next/Later), technology radar, build-vs-buy analyses, and tech debt registers. Trigger when asked about roadmap planning, technology evaluation, build-vs-buy decisions, or tech debt prioritization.
user-invocable: true
---

# Engineering Strategy

Develop and maintain engineering strategy artifacts stored in `strategy/engineering/`.

## Prerequisites

Before creating any artifact, read:
- `strategy/engineering/` for existing engineering docs
- `strategy/competitive/feature-matrix.md` for feature gaps
- `strategy/business/` for business priorities
- `docs/adr/` for existing architecture decisions
- `specs/` for feature specifications and status
- `tasks/` for current backlog

## Frameworks

### Now/Next/Later Roadmap
Avoids false precision of timeline-based roadmaps. Now = committed work; Next = planned, dependencies identified; Later = important but unscheduled. Each item links to a business driver.

### Technology Radar (ThoughtWorks-style)
Four quadrants (Techniques, Tools, Platforms, Languages/Frameworks) x four rings (Adopt, Trial, Assess, Hold). Include rationale and last-assessed date per entry.

### Build vs Buy Decision Matrix
Weighted scoring on: strategic differentiation, time to value, maintenance burden, integration complexity, total cost (2yr), vendor risk. Include TCO comparison and reversibility assessment.

### Tech Debt Register (Fowler Quadrant)
Categorize as Reckless/Prudent x Deliberate/Inadvertent. Track priority, location, impact, remediation approach, effort estimate, and business case.

## Output Artifacts

Save to `strategy/engineering/`:
- `roadmap.md` — Now/Next/Later with dependencies and business drivers
- `tech-radar.md` — Technology assessments by quadrant and ring
- `tech-debt.md` — Prioritized register with effort estimates
- `adr/NNN-[title].md` — Architecture Decision Records (also consider `docs/adr/` for implemented decisions)

## Prioritization Criteria

When helping prioritize, consider: business impact, competitive necessity (table-stakes?), technical leverage (unlocks future work?), user demand (evidence from support/reviews), effort, and dependencies.

## Quality Standards

- Link every roadmap item to a business driver
- Distinguish committed vs aspirational work
- Include effort estimates (even rough)
- Track decisions, not just outcomes (ADRs capture reasoning)
- Update, don't append — move completed items, don't let docs grow forever
- Include `Last Updated` date and update trigger on every document
