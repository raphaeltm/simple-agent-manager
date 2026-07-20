# CTO remediation mega PR integration

## Problem

Multiple targeted remediation PRs from the strict CTO review workflow must be integrated into one final mega PR, validated together on staging, and merged to production only if all required local, CI, specialist, staging, core workflow, and production deployment gates pass.

## Research findings

- SAM task output branch: `sam/execute-task-using-skill-jjat06`.
- PRs in scope: #1624 through #1636, excluding none unless direct inspection finds a blocker.
- Draft/safety constraints require special handling:
  - #1628 is draft and must be directly inspected, including VM terminal WebSocket/PTY evidence.
  - #1632 is draft/no-merge as a child PR, but this final task explicitly asks to include it in the mega PR after validation.
- Affected surfaces include API auth/CORS/logging/admin guards, UI modal/mobile nav/terminal tabs/chats refresh/tool-call rendering, Cloudflare deploy migration ordering, D1 migration prefix checks, VM-agent WebSocket/PTY lifecycle, callback/bootstrap token lifecycle, CLI network hardening, provider/ACP boundaries, and skill wrapper references.
- Staging validation is mandatory, including Claude and Codex codebase-message workflows through the Playwright token-login path.
- Missing user cloud credentials are not a blocker; use the platform credential path and verify staging state with Cloudflare/D1 evidence where needed.

## Checklist

- [x] Inspect every PR #1624-#1636 directly and record inclusion decision.
- [x] Confirm each PR has green CI or rerun/fix as needed.
- [x] Create integration branch `sam/execute-task-using-skill-jjat06`.
- [x] Merge each approved PR branch into the integration branch and resolve conflicts.
- [x] Run local gates: lint, typecheck, tests, build, Go tests, deploy/migration script checks, and UI/Playwright checks.
- [x] Run required specialist reviews and address all blocking findings.
- [ ] Deploy integration branch to staging after local and CI checks are clean.
- [ ] Validate affected API, UI, VM-agent, CLI, provider/ACP, skill, and migration surfaces on staging.
- [ ] Validate Claude and Codex codebase-message workflows on staging.
- [ ] Create the mega PR with evidence.
- [ ] Wait for CI green, merge to main, and monitor production deploy to success.

## Acceptance criteria

- One mega PR includes the validated remediation changes from all appropriate child PRs.
- All required local gates and CI checks pass.
- Specialist review evidence is recorded in the PR.
- Staging deployment succeeds and affected surfaces are verified.
- Both Claude and Codex staging workflow validations produce valid responses.
- Real VM path is exercised where possible, with exact evidence or exact quota blocker evidence plus existing-VM coverage.
- Mega PR is merged to `main`.
- Production deployment succeeds and is reported with run evidence.
