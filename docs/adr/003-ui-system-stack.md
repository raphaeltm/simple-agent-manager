# ADR 003: Unified UI System Stack

**Status**: Accepted  
**Date**: 2026-02-07  
**Deciders**: Development Team

## Context

We need one UI system that works across:
- `apps/web` (control plane)
- `packages/vm-agent/ui` (agent interface)

The system must:
- Support a modern, beautiful UI direction with a green-forward developer aesthetic
- Be mobile-first with strong desktop usability
- Be friendly to agent-authored code changes
- Prevent style drift across product surfaces

## Decision

We will use a shadcn-compatible open-code component approach as the design-system foundation, implemented through a shared workspace package at `packages/ui`.

### Core Elements

1. **Design tokens** in `packages/ui/src/tokens` as semantic, reusable values.
2. **Primitives and components** in `packages/ui/src/primitives` and `packages/ui/src/components`.
3. **Canonical guidelines** in `docs/guides/ui-standards.md` and `docs/guides/ui-agent-guidelines.md`.
4. **Shared governance APIs** in `apps/api/src/routes/ui-governance.ts` for standards, compliance, and migration metadata.

## Consequences

### Positive

- One source of UI truth across both UIs.
- Strong fit for agent-authored development because code stays in-repo and editable.
- Better consistency and review quality with shared checklist and governance workflow.
- Theme and style values can be centralized and configurable.

### Negative

- Higher up-front migration effort to move legacy UI to shared components.
- Requires ongoing governance ownership to avoid drift.
- Component maintenance burden moves into repository team ownership.

### Neutral

- Does not force a single external framework lock-in; it standardizes approach and governance.

## Alternatives Considered

1. Full adoption of a precompiled component framework:
   - Rejected due to lock-in and reduced cross-surface flexibility.

2. Continue ad-hoc per-app styling:
   - Rejected because it does not meet consistency and agent-governance goals.

3. Use derivative admin templates as canonical system:
   - Rejected because templates are useful references but too opinionated as a single source of truth.

## References

- `specs/009-ui-system-standards/spec.md`
- `specs/009-ui-system-standards/research.md`
- `specs/009-ui-system-standards/framework-fit.md`
