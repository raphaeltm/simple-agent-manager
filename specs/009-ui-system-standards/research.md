# Research: Unified UI System Standards

**Feature**: `009-ui-system-standards`  
**Date**: 2026-02-07

## Decision 1: Use a shadcn-compatible open-code component system as the foundation

**Decision**: Base the shared UI system on a shadcn-compatible, open-code approach (composable components + primitives), rather than a locked precompiled component library.

**Rationale**:
- Fits the requirement for modern visual quality without blocking deep customization.
- Matches agent-driven workflows because components remain editable project code.
- Supports consistent design tokens and variants across multiple UI surfaces.

**Alternatives considered**:
- Full adoption of a monolithic component framework: rejected due to higher lock-in and weaker fit for cross-surface customization.
- Keep current ad-hoc CSS/utilities: rejected because consistency and governance goals are not achievable at scale.

## Decision 2: Apply a tokenized green-forward developer theme

**Decision**: Define semantic design tokens (background, foreground, accent, status, border, focus) with a green-forward brand direction and neutral companion palette.

**Rationale**:
- Preserves visual identity while maintaining accessibility and consistency.
- Makes theme updates centralized and avoids per-screen hardcoded color values.
- Works for both dense tool UIs and simpler control-plane layouts.

**Alternatives considered**:
- One-off per-component color choices: rejected for maintainability and governance reasons.
- Fixed third-party theme with minimal adaptation: rejected due to weaker product differentiation.

## Decision 3: Create one shared UI package for both UIs

**Decision**: Introduce `packages/ui` as the single source for tokens, primitives, and common composed components used by `apps/web` and `packages/vm-agent/ui`.

**Rationale**:
- Directly satisfies cross-surface reuse requirement.
- Reduces duplicate implementations and interface drift.
- Aligns with monorepo architecture and dependency direction (apps consume packages).

**Alternatives considered**:
- Duplicate components per app: rejected due to inconsistency and higher maintenance cost.
- Keep only style guidelines without shared package: rejected because enforcement and reuse would be too weak.

## Decision 4: Use a derivative pattern strategy, not hard lock-in

**Decision**: Reuse proven admin/dashboard composition patterns (including shadcn-derived examples) as references, but keep the canonical system in project-owned shared components and tokens.

**Rationale**:
- Captures speed benefits of derivative ecosystems without importing visual debt.
- Maintains control over mobile behavior, accessibility, and product-specific styling.

**Alternatives considered**:
- Full derivative template adoption as-is: rejected because it may not fit the agent UI or project constraints.
- Build every pattern from scratch: rejected due to slower delivery.

## Decision 5: Enforce UI quality with shared checklist + agent rules

**Decision**: Publish one compliance checklist for all UI pull requests and a matching agent instruction set with explicit do/don't rules.

**Rationale**:
- Ensures human and agent-authored changes are evaluated identically.
- Creates enforceable quality gates for accessibility and responsive behavior.
- Improves review consistency and reduces style-related back-and-forth.

**Alternatives considered**:
- Reviewer discretion only: rejected due to inconsistent outcomes.
- Agent-only rules with no human checklist: rejected because governance must be universal.

## Decision 6: Validate mobile-first and desktop quality through layered checks

**Decision**: Combine component tests, accessibility assertions, responsive viewport checks, and checklist-based review sign-off.

**Rationale**:
- No single validation method is sufficient for visual + interaction quality.
- Captures both objective failures (accessibility/responsive regressions) and UX fit.

**Alternatives considered**:
- Manual QA only: rejected as non-scalable.
- Unit tests only: rejected because layout and interaction quality require viewport-level validation.

## Clarification Resolution

All technical-context clarifications are resolved by the decisions above.  
No unresolved clarification markers remain.

## Sources Consulted

- https://ui.shadcn.com/docs
- https://ui.shadcn.com/docs/registry
- https://ui.shadcn.com/themes
- https://raw.githubusercontent.com/shadcn-ui/ui/main/README.md
- https://raw.githubusercontent.com/satnaing/shadcn-admin/main/README.md
- https://raw.githubusercontent.com/tremorlabs/tremor/main/README.md
- https://www.radix-ui.com/primitives/docs/overview/accessibility
- https://www.w3.org/WAI/WCAG22/Understanding/reflow.html
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
