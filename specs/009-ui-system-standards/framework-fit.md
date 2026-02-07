# Framework Fit Matrix: Unified UI System Standards

## Goal

Select a UI foundation that is:
- Beautiful by modern standards
- Easy to theme for a green-forward software-development aesthetic
- Compatible with a shared package used by both `apps/web` and `packages/vm-agent/ui`
- Practical for agent-authored code changes in this monorepo

## Candidates Evaluated

| Candidate | Strengths | Risks | Fit for This Repo | Decision |
|----------|-----------|-------|-------------------|----------|
| shadcn/ui open-code workflow | Editable source, strong accessibility via primitives, flexible theming, monorepo-friendly registry patterns | Requires ownership of component code and governance discipline | High fit with `packages/ui` shared source model and agent workflows | Selected as base approach |
| shadcn-derived admin kits | Fast dashboard composition and pre-baked patterns | Can bring opinionated styling and structural coupling | Useful as inspiration for control-plane patterns; weak as canonical source | Reference only |
| Tremor | High-quality analytics/dashboard components | More specialized toward data dashboards | Useful for select dashboards, not broad system baseline | Not selected as primary |
| Magic UI and motion-heavy libraries | Distinctive visuals and strong marketing polish | Potential performance/consistency risk if overused | Better as optional enhancement, not baseline system | Optional, not baseline |
| Keep existing ad-hoc CSS utilities | No migration overhead | Continued inconsistency and governance drift | Does not satisfy cross-surface standardization goals | Rejected |

## Selection

Use a shadcn-compatible open-code component system with:
- Shared semantic tokens in `packages/ui`
- Shared primitives/components consumed by both UI surfaces
- Explicit mobile-first and accessibility governance
- Agent-friendly implementation rules

## Why This Fits the Monorepo

1. Supports internal-package distribution model already used in repository.
2. Keeps UI code editable and reviewable, which improves agent output quality.
3. Enables a single design token source to satisfy constitution principle XI (no hardcoded values in business/UI rules).

## Sources

- https://ui.shadcn.com/docs
- https://ui.shadcn.com/docs/registry
- https://ui.shadcn.com/docs/monorepo
- https://ui.shadcn.com/themes
- https://ui.shadcn.com/blocks
- https://raw.githubusercontent.com/satnaing/shadcn-admin/main/README.md
- https://raw.githubusercontent.com/tremorlabs/tremor/main/README.md
