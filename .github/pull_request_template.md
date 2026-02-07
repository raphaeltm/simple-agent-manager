## Summary

- Describe the problem and the intended change.
- Include any critical implementation notes for reviewers.

## Validation

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] Additional validation run (if applicable)
- [ ] Mobile and desktop verification notes added for UI changes

## UI Compliance Checklist (Required for UI changes)

- [ ] Mobile-first layout verified
- [ ] Accessibility checks completed
- [ ] Shared UI components used or exception documented

## Exceptions (If any)

- Scope:
- Rationale:
- Expiration:

<!-- AGENT_PREFLIGHT_START -->

## Agent Preflight (Required)

- [ ] Preflight completed before code changes

### Classification

- [ ] external-api-change
- [ ] cross-component-change
- [ ] business-logic-change
- [ ] public-surface-change
- [ ] docs-sync-change
- [ ] security-sensitive-change
- [ ] ui-change
- [ ] infra-change

### External References

Provide sources consulted before coding. For `external-api-change`, include Context7 output or official docs.
If not applicable, write `N/A: <reason>`.

### Codebase Impact Analysis

List affected components and code paths (for example `apps/api`, `packages/shared`, `packages/vm-agent`).
If not applicable, write `N/A: <reason>`.

### Documentation & Specs

List docs/spec files updated, or write `N/A: <reason for no updates>`.

### Constitution & Risk Check

State which constitution principles were checked and summarize key risks/tradeoffs.

<!-- AGENT_PREFLIGHT_END -->
