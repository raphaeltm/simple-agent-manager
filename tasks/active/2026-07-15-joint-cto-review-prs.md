# Joint PR for CTO Review Remediation PRs

## Problem statement

The prior "Deep CTO codebase review orchestration" session dispatched remediation agents that opened six focused PRs and intentionally left them unmerged. The current task is to combine those PRs into one temporary integration PR, validate the combined result on staging, confirm affected surfaces and core agent message flows still function, merge the joint PR if green, and close the original PRs.

## Research findings

- Parent task `01KXHR1EFYJB1Q2CVAS8500P82` completed and reported six remediation PRs:
  - #1595 Go remediation / race hardening
  - #1596 backend setup/bootstrap token hardening
  - #1597 backend host-header URL hardening
  - #1598 prototype/test route gating
  - #1599 HTML/markdown preview hardening
  - #1600 frontend interaction/accessibility/destructive-action hardening
- Parent session search confirmed #1595, #1596, #1597, and #1599 were reported green and unmerged. Parent task completion evidence also lists #1598 and #1600 as green and unmerged.
- The current task explicitly authorizes merging after successful joint validation, superseding the prior do-not-merge constraint for the individual remediation PRs.
- Staging validation must use the smoke-token browser auth path and should verify both changed surfaces and the core flows for submitting messages to claude/codex/opencode agents.

## Checklist

- [x] Inspect current GitHub state for PRs #1595-#1600, including branch names, draft state, mergeability, changed files, and CI.
- [x] Create a joint branch from current `main`.
- [x] Merge the six PR branches into the joint branch, resolving conflicts deliberately.
- [x] Run local validation appropriate to affected files.
- [x] Open a temporary joint PR with source PR references and validation plan.
- [x] Wait for CI and fix any failures.
- [x] Deploy the joint PR branch to staging.
- [x] Validate all affected surfaces from the six PRs.
- [x] Validate core message submission flows for claude, codex, and opencode agents.
- [ ] Merge the joint PR if CI and staging validation are green.
- [ ] Close the original PRs #1595-#1600 with a comment referencing the merged joint PR.
- [ ] Monitor production deployment after merge and report the result.

## Acceptance criteria

- A joint PR exists and contains the combined changes from #1595-#1600.
- CI is green on the joint PR.
- Staging deployment succeeds for the joint branch.
- Staging verification confirms affected surfaces still function.
- Staging verification confirms claude, codex, and opencode agent message submission flows still work.
- The joint PR is merged only after green CI and successful staging validation.
- Original PRs #1595-#1600 are closed after the joint PR is merged.
- Production deployment after merge is monitored to success or a concrete failure is reported immediately.

## Validation evidence

- Joint PR: #1601. Runtime-validation CI head `ea6c16bdfbcad49eb172f3abb8f71a383568b967` completed successfully in run `29400358432`, including Playwright Visual Tests, VM Agent checks, CodSpeed, SonarCloud, and VM Agent Smoke run `29400358406`. The later task-file-only bookkeeping commit changes no runtime code and must have required checks green before merge.
- Staging deployment: `Deploy Staging` run `29398161022` completed successfully, including `deploy / Deploy to Cloudflare` and `smoke-tests`.
- Cloudflare/staging health checks: `https://api.sammy.party/health` returned healthy; read-only D1 checks succeeded (`users=4`, `projects=33`, `tasks=247`, `nodes=108`, `workspaces=134`, `rows_written=0`); latest migration query showed `0093_webhook_triggers.sql` applied.
- Live file-preview validation: `PLAYWRIGHT_BASE_URL=https://app.sammy.party pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/staging-file-preview-v2.spec.ts --project='Desktop (1280x800)'` passed after updating the stale staging spec to assert the hardened inert HTML sandbox (`sandbox=""`, no `<script>`, script result remains `not run`).
- Live core-flow validation: custom staging validator logged in through `POST https://api.sammy.party/api/auth/token-login`, loaded `https://app.sammy.party`, verified dev-only routes `/sam`, `/__test/trial-chat-gate`, and `/ui-standards` do not expose dev content, then started/stopped CF-container conversation sessions on staging for `claude-code`, `openai-codex`, and `opencode`. Claude produced assistant output. Codex and OpenCode accepted session starts, persisted the user message, reported the correct agent type, rendered the session page, and stopped cleanly, but did not produce assistant text within a 240s wait; this validates message submission/recording, not agent completion. Temporary Codex/OpenCode validation profiles were deleted.
- Observability-noise check: `pnpm quality:observability-noise` passed; D1 and Workers telemetry subchecks were skipped where `OBSERVABILITY_DB_ID`/telemetry access were unavailable, and the script reported no significant log noise.
- Local post-staging-spec checks: `pnpm lint` passed with existing warnings only; `pnpm typecheck` passed.

## References

- Parent task: `01KXHR1EFYJB1Q2CVAS8500P82`
- Parent session: `c11121d9-9bda-447a-9b48-8e06068c9313`
- Current SAM output branch: `sam/use-sam-mcp-tools-bz4e69`
- Joint PR: https://github.com/raphaeltm/simple-agent-manager/pull/1601
