# Playwright visual audit for ProjectAgentCredentialsSection

**Created**: 2026-04-18
**Priority**: HIGH
**Source**: task-completion-validator re-run on PR #753 (`sam/project-credential-overrides`)

## Problem

PR #753 added a new UI surface (`apps/web/src/components/ProjectAgentCredentialsSection.tsx`) on Project Settings without a corresponding Playwright visual audit spec. Rule 17 (`.claude/rules/17-ui-visual-testing.md`) mandates visual audits for any PR touching `apps/web/`, `packages/ui/`, or `packages/terminal/` — covering mobile (375×667) and desktop (1280×800) viewports with diverse mock-data scenarios (normal, long text, empty state, many items, error, special chars) and an overflow assertion.

The component renders three distinct visual states per agent:
1. Project override present (shows masked key `...cdef` with Update/Remove buttons)
2. Inheriting user credential (shows hint text `Inheriting user credential (...xxxx) — add a project override above...`)
3. Neither override nor user credential (prompts user to add a project-scoped credential)

Plus a global info `Alert` banner explaining override semantics.

The long-masked-key hint text and the alert copy are the primary overflow risks on mobile.

## Scope

New file: `apps/web/tests/playwright/project-agent-credentials-audit.spec.ts`, following the pattern in `apps/web/tests/playwright/ideas-ui-audit.spec.ts`.

Do not modify `ProjectAgentCredentialsSection` unless the audit reveals a layout bug that must be fixed.

## Acceptance Criteria

- [ ] Mock API handler for `/api/projects/:id/credentials` + `/api/credentials/agent`
- [ ] Scenarios covered:
  - [ ] Normal: 2 agents, one with project override, one inheriting user credential
  - [ ] Long masked key: 16-char suffix in hint text
  - [ ] Empty: no user credentials AND no project overrides (all "No user-level credential set…" copy)
  - [ ] All overrides: all 5 agents have project-scoped credentials
  - [ ] Error state: API returns 500 for `/api/projects/:id/credentials`
- [ ] Mobile (375×667) AND desktop (1280×800) screenshots for each scenario
- [ ] Overflow assertion: `document.documentElement.scrollWidth <= window.innerWidth`
- [ ] Screenshots saved to `.codex/tmp/playwright-screenshots/`
- [ ] Test file follows the established pattern (mock factory, scenario datasets, `setupApiMocks(page, options)`, `screenshot(page, name)` helper, separate mobile/desktop `test.describe` blocks)

## References

- Rule 17: `.claude/rules/17-ui-visual-testing.md`
- Existing audit pattern: `apps/web/tests/playwright/ideas-ui-audit.spec.ts`
- Related backlog (shared AgentKeyCard a11y): `tasks/backlog/2026-04-18-agent-key-card-accessibility.md`
- Related backlog (Miniflare integration tests): `tasks/backlog/2026-04-18-credentials-miniflare-integration-tests.md`
- Source PR: https://github.com/raphaeltm/simple-agent-manager/pull/753
