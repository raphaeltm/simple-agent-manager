## Summary

- Describe the problem and the intended change.
- Include any critical implementation notes for reviewers.

## Validation

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] Additional validation run (if applicable)

## Staging Verification (REQUIRED for all code changes — merge-blocking)

All checkboxes below are mandatory for any PR that changes runtime code (`.ts`, `.tsx`, `.go`, etc.). Write `N/A: docs-only` ONLY if the PR contains zero runtime code changes. See `.claude/rules/13-staging-verification.md`.

- [ ] **Staging deployment green** — `Deploy Staging` workflow passed on this PR
- [ ] **Live app verified via Playwright** — logged into `app.sammy.party` (staging) using test credentials and actively tested the application
- [ ] **Existing workflows confirmed working** — navigated dashboard, projects, and settings; confirmed no regressions in core flows (pages load, data displays, navigation works, no new console errors)
- [ ] **New feature/fix verified on staging** — the specific changes in this PR work correctly on the live staging environment (describe what was tested below)
- [ ] Infrastructure verification completed — VM provisioned and heartbeat confirmed (required for changes to cloud-init, VM agent, DNS, TLS, scripts/deploy). Write `N/A: no infra changes` ONLY if the PR does not touch any infrastructure paths.
- [ ] Mobile and desktop verification notes added for UI changes

### Staging Verification Evidence

<!-- Describe what you tested on staging and what you observed. Include screenshots, API responses, or Playwright observations. -->
<!-- If N/A: docs-only, explain why no code was changed. -->

## UI Compliance Checklist (Required for UI changes)

- [ ] Mobile-first layout verified
- [ ] Accessibility checks completed
- [ ] Shared UI components used or exception documented

## End-to-End Verification (Required for multi-component changes)

- [ ] Data flow traced from user input to final outcome with code path citations (see `.claude/rules/10-e2e-verification.md`)
- [ ] Capability test exercises the complete happy path across system boundaries
- [ ] All spec/doc assumptions about existing behavior verified against code (not just "read the code")
- [ ] If any gap exists between automated test coverage and full E2E, manual verification steps documented below

### Data Flow Trace

<!-- For multi-component features, paste your data flow trace here. Each step should cite a specific file:function. -->
<!-- If not applicable, write `N/A: <reason>` -->

### Untested Gaps

<!-- Document any gaps between automated test coverage and the full user flow. Include manual verification steps performed. -->
<!-- If not applicable, write `N/A: full flow covered by automated tests` -->

## Post-Mortem (Required for bug fix PRs)

<!-- If this PR fixes a bug, fill out this section. If not a bug fix, write `N/A: not a bug fix`. -->

### What broke

<!-- Describe the user-visible failure in 1-2 sentences -->

### Root cause

<!-- Trace to the specific commit/change that introduced the bug -->

### Class of bug

<!-- Generalize: what category of bug is this? e.g., "state interaction race condition", "mock-hidden integration failure" -->

### Why it wasn't caught

<!-- Which practices failed? Missing test type, insufficient review, missing trace? -->

### Process fix included in this PR

<!-- List the specific files in .claude/rules/, .claude/agents/, .github/, or CLAUDE.md that were updated to prevent this class of bug -->

### Post-mortem file

<!-- Link to docs/notes/YYYY-MM-DD-*-postmortem.md created in this PR -->

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
