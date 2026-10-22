# Persist project setup agent defaults

## Problem
Project onboarding creates conversation/task profiles without setting `projects.default_agent_type`. Unprofiled triggers can therefore start OpenCode even after the user configured another agent in setup.

## Evidence and approach
- Production task 01M5HJ0NDS1XCXY6FGH5WT6MAH had null profile, skill, and saved resolved agent type. Runtime selected OpenCode.
- `ProjectOnboardingWizard.saveProfile` creates profiles only; project creation precedes agent selection.
- `placement-resolver.ts` already uses explicit agent → profile agent → project default. No scheduler change needed.
- Persist selected agent through existing updateProject before creating its profile. Conversation sets initial default; task selection supersedes it. Revisiting a saved step/skipping does not overwrite the default. Failed default save blocks advancement/profile creation and can be retried.
- UX alternatives: separate default picker (redundant choice); default checkbox (extra decision); infer from existing setup choices with explanatory copy (selected, smallest complete flow).

## Checklist
- [x] Add regression tests for setup selection, task precedence, skips, failure/retry, revisits.
- [x] Persist project default with existing API and explain default behavior in setup.
- [x] Verify unprofiled automation inherits project agent; explicit profiles still win.
- [x] Unit tests, lint/typecheck/build; mobile/desktop Playwright screenshots and review.
- [x] Specialist and final completion reviews; PASS to archive implementation record.
- [x] Staging verification and cleanup.
- Release status: PR/CI/CodeRabbit, merge, and production deployment tracked in the PR; not yet shipped at archival time.

## Acceptance
Setup agent selection is used by later unprofiled tasks/triggers. Task profile selection takes precedence when both are configured. Skip does not erase a choice. Failed save is visible/retryable and cannot silently advance. No new schema or API needed.

## Local verification
25 wizard regression tests; 25 placement tests; two browser flow tests at 375x667 and 1280x800. Root lint/typecheck/build passed; full root tests passed (21/21 tasks). Local UI, constitution, documentation, and test review found no blockers. Completion review confirms implementation, with staging/release gates pending.

UI rubric: hierarchy 4, clarity 4, mobile 4, accessibility 4, consistency 5. All ten conversation/task/error/controls screenshots reviewed; no clipping or overflow. Partial failure intentionally preserves a successfully saved default if subsequent profile creation fails; tested retry does not repeat the default update.

## Staging evidence
Deployment [39776858617](https://github.com/raphaeltm/simple-agent-manager/actions/runs/39776858617) passed, including smoke tests. Browser verified dashboard/projects/settings and real setup at mobile/desktop sizes, with no page errors. Project `01M5HSG4XZCV1VCXMPSN26094W` persisted conversation `claude-code`, then task `openai-codex`. Unprofiled trigger task `01M5HSGGJYV7FNKGZ8FBEE41P9` saved runner `openai-codex` with null profile/skill. Cancelled task before workspace creation; deleted trigger and project; no new nodes. Provider inference was intentionally outside this selection-only probe.

## Post-mortem
Wizard introduced in `0b81beb30` (#1233) created profiles without writing the project default consumed by unprofiled task admission. Tests previously asserted only profile creation. New wizard and placement regressions cover that persistence boundary and retries. The original production prompt error remains separate; sanitized logs did not retain its underlying provider failure.
