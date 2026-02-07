# Quickstart: Unified UI System Standards

## Purpose

Implement the unified UI standard so both product surfaces use:
- The same visual language
- The same shared component definitions
- The same mobile-first and desktop quality rules
- The same review checklist for human and agent-authored changes

## Prerequisites

- Repository dependencies installed (`pnpm install`)
- Feature branch checked out (`009-ui-system-standards`)
- Familiarity with `apps/web`, `packages/vm-agent/ui`, and `packages/terminal`

## Step 1: Establish the Shared UI Package

1. Create `packages/ui` with tokens, primitives, and composed components.
2. Expose package exports for:
   - Design tokens
   - Shared primitives
   - Common app-level components/patterns
3. Add workspace references so both UI surfaces consume the same package.

## Step 2: Publish the Canonical UI Rules

1. Create/update the canonical guide at `docs/guides/ui-standards.md`.
2. Include:
   - Green-forward visual direction
   - Accessibility requirements
   - Mobile-first layout requirements
   - Desktop enhancement guidance
   - Component usage and exception process

## Step 3: Define Agent-Consumable Guidance

1. Add explicit UI do/don't rules to agent-facing instructions.
2. Include a required compliance checklist with pass/fail criteria.
3. Ensure guidance applies identically to human-authored and agent-authored changes.

## Step 4: Migrate High-Impact Screens First

1. Prioritize migration items by user impact:
   - Primary navigation
   - Forms and actions
   - Status/feedback states
2. Migrate one representative flow in each UI surface first.
3. Document any temporary exceptions with rationale and expiration.

## Step 5: Validate Quality Gates

1. Run component and integration tests:

```bash
pnpm --filter @simple-agent-manager/web test
pnpm --filter @workspace/vm-agent-ui typecheck
```

2. Run repository checks:

```bash
pnpm lint
pnpm typecheck
```

3. Validate responsive behavior:
   - Mobile viewport checks (including 320px width behavior)
   - Desktop layout checks for information density and navigation clarity

4. Validate checklist compliance in pull-request review.

## Step 6: Measure Rollout Outcomes

Track rollout against success criteria:
- Adoption rate of shared components across both UI surfaces
- Mobile and desktop usability pass rates
- Pull-request checklist pass rate within review rounds
- Reduction in design-related rework

## Exit Criteria for This Feature

- Shared UI package is in place and consumable in both UI surfaces
- Canonical standards and agent guidance are published
- Compliance checklist is operational in PR reviews
- Initial migration set is completed and verified

## Final Execution Sequence

1. Build and typecheck shared UI package.
2. Run API and web typechecks.
3. Run lint and test suites.
4. Verify UI governance routes are reachable in authenticated session.
5. Validate mobile-first behavior on key screens (`Landing`, `CreateWorkspace`, `Settings`, `UiStandards`).
6. Validate agent UI compliance context display.
7. Confirm PR checklist includes required UI compliance evidence.
