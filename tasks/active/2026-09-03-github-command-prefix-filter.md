# Fix GitHub commandPrefix filter rejecting non-comment events

## Problem Statement

GitHub `issues`, `pull_request`, and `push` triggers created through the product UI can store `filters.commandPrefix: "/sam"` even though `commandPrefix` is meaningful only for `issue_comment` events. `evaluateFilters()` applies that filter with no event-type guard. Non-comment webhook events do not carry `event.comment`, so the filter reads an empty comment body and permanently rejects the delivery with `comment does not start with '/sam'`.

The load-bearing fix is evaluation-time: apply `commandPrefix` only when `event.event === 'issue_comment'`. This deliberately avoids a data migration. Existing persisted non-comment triggers with stray `commandPrefix`, including the live production trigger `01KXNX64WKGQGS955PAA7E1RFB`, self-heal as soon as the backend fix deploys because the stale field becomes inert for non-comment event types. Self-hosted installs in the same state get the same non-destructive recovery.

## Production Evidence

Do not re-derive; preserve in task and PR.

Queried via `CF_PRODUCTION_DEBUGGING_TOKEN` / `CF_PRODUCTION_ACCOUNT_ID` against sam-prod D1 `a8923a52-b1d4-4e0d-9bd9-aa5406face5e`:

- `trigger_executions` grouped by `triggers.source_type`: cron 331 completed / 90 failed; incident 5 completed / 10 skipped / 2 failed; **github ZERO rows ever; webhook ZERO rows ever.**
- Exactly one GitHub trigger exists in all of production: `01KXNX64WKGQGS955PAA7E1RFB` "Issue Reviewer", project `01KHRJGANBBWGDY1NZ0KVF0D4J`, created 2026-07-16T16:47:03Z, event_type `issues`, filters `{"actions":["opened"],"ignoreActors":["dependabot[bot]","simple-agent-manager[bot]"],"commandPrefix":"/sam"}`, `trigger_count = 0`, `last_triggered_at = NULL`.
- `github_webhook_deliveries` proves events arrived and routed correctly, then died at the last filter. Two `issues`/`opened` deliveries were rejected with `decision_reason = "comment does not start with '/sam'"`:
  - 2026-07-16T16:47:54Z → issue #1611 "Potato" by raphaeltm, opened 16:47:52Z (49 seconds after the trigger was created — the original manual smoke test)
  - 2026-07-16T18:54:58Z → issue #1614 by robinbeechey, a genuine external bug report that was silently dropped

Everything upstream of the bad filter is healthy: signature verification, delivery dedup, repo→project resolution, event-type matching, the `actions` filter and the `ignoreActors` filter all passed before `commandPrefix` rejected.

## Research Findings

- `apps/api/src/services/github-trigger-filter.ts` exports the pure `evaluateFilters()` predicate. Pre-fix, the comment said command prefix is for `issue_comment` events, but the code applied it to every GitHub webhook event.
- The only production caller is `apps/api/src/services/github-trigger-handler.ts`, after GitHub signature/dedup/project lookup and after the trigger config `eventType` has already been matched against the webhook event.
- Caller enumeration for `.claude/rules/67`: `rg "evaluateFilters\\("` finds:
  - `apps/api/src/services/github-trigger-handler.ts:226` — runtime caller. Narrowing `commandPrefix` to `issue_comment` changes behavior only for stored non-comment GitHub triggers with stray `commandPrefix`, turning an incorrect rejection into normal evaluation of the remaining filters. `issue_comment` behavior remains unchanged.
  - `apps/api/tests/unit/services/github-trigger-filter.test.ts` — tests only.
- `apps/web/src/components/triggers/TriggerForm.tsx` initializes new GitHub trigger command prefix state to `/sam` and edit state to `existing ?? '/sam'`.
- `apps/web/src/components/triggers/GitHubTriggerFields.tsx` only renders the command-prefix input for `issue_comment`, so non-comment triggers cannot see or clear the stale field.
- Pre-fix, `apps/web/src/components/triggers/trigger-form-support.ts` built GitHub filters and persisted a trimmed `commandPrefix` regardless of event type.
- Pre-fix, `apps/web/src/components/triggers/trigger-presentation.tsx` rendered any stored `commandPrefix` in source labels, producing misleading labels such as `GitHub issues: /sam`.
- Existing trigger UI post-mortem `tasks/archive/2026-06-05-harden-trigger-ui-accessibility.md` established the retained lesson that trigger UI changes need behavioral tests plus mobile/desktop Playwright screenshot evidence; shallow DOM or visual-only checks previously missed trigger UI defects.
- `git blame` introducing commits:
  - `c444b3e056ad6576a66387bc4f6ab7c1674ea455` (`feat: add GitHub event triggers`, 2026-05-31T10:41:17Z) introduced the ungated backend `commandPrefix` filter and `/sam` UI command-prefix defaults.
  - `47041f09911b65b327dd73dbfe6f6fc5a7e9e542` (`feat: add generic webhook triggers (#1581)`, 2026-07-14T14:28:33Z) moved GitHub filter construction into `buildGitHubFilters()` and persisted `commandPrefix` unconditionally.
  - `3b031586ff1f2fdd1b800fdc6c4de9938aa568c9` (`fix(web): stop the triggers page shearing off-screen on mobile (#1803)`, 2026-08-11T07:47:40Z) centralized source-label rendering and rendered any stored `commandPrefix`.

## Post-Mortem

### What Broke

GitHub `issues`, `pull_request`, and `push` triggers with a stored `commandPrefix` were silently filtered before task admission. Product-created non-comment GitHub triggers could become permanently dead on arrival while appearing active in the UI.

### Root Cause

The `evaluateFilters()` `commandPrefix` predicate had a scope comment saying it applied to `issue_comment` events, but the executable code lacked an event-type guard. The web form then made the latent backend bug much easier to hit by defaulting `commandPrefix` to `/sam`, hiding that input for non-comment event types, persisting it regardless of event type, and later displaying it as if it were an active non-comment filter.

### Timeline

- 2026-05-31: `c444b3e056` introduced GitHub event triggers, including the ungated backend predicate and `/sam` UI default.
- 2026-07-14: `47041f0991` introduced unconditional `buildGitHubFilters()` persistence for the hidden default.
- 2026-07-16: production trigger `01KXNX64WKGQGS955PAA7E1RFB` was created for `issues`/`opened`; deliveries at 2026-07-16T16:47:54Z and 2026-07-16T18:54:58Z were filtered with `comment does not start with '/sam'`.
- 2026-08-11: `3b031586ff` made the stale value visible as `GitHub issues: /sam`, but still did not make it editable or valid.
- 2026-09-03: this fix was requested after production evidence showed zero GitHub trigger executions and the exact filtered delivery reason.

### Why It Wasn't Caught

Tests covered `issue_comment` prefix enforcement but did not include realistic non-comment GitHub webhook payloads carrying a stray stored `commandPrefix`. UI tests did not assert event-scoped serialization, and the delivery audit table recorded exact filtered reasons without surfacing a seven-week-active, zero-trigger-count failure condition to the user.

### Class of Bug

A filter predicate whose scope comment does not match its code, silently rejecting an entire event class.

### Process Fix

Add a `.claude/rules/` rule requiring event- or source-scoped filters to encode their scope in executable guard logic and tests for both in-scope enforcement and out-of-scope inertness. The rule should also require PRs touching shared filter predicates to enumerate callers and explain per-caller behavior changes.

Separately, the observability lesson is that an active trigger with deliveries recorded as `filtered` for weeks, `trigger_count = 0`, and a stable rejection reason should be surfaced in the triggers UI. Captured as SAM Idea `01M1M8ENP75RD87GF5BC7DZJ11`, not a GitHub Issue, and this PR’s implementation scope remains focused on the filter/UI hygiene fix.

## Implementation Checklist

- [x] Add backend regression tests proving `issues`/`opened`, `pull_request`/`opened`, and `push` events with stray stored `commandPrefix: "/sam"` still match when all applicable filters pass, plus a synthetic accidental-comment case proving the guard is event-type based rather than comment-presence based.
- [x] Add an `issue_comment` control test proving `commandPrefix` is still enforced and preserves the `comment does not start with '/sam'` reason string.
- [x] Verify the `issues` regression test fails against pre-fix code and record the command/result.
- [x] Update `evaluateFilters()` to apply `commandPrefix` only when `event.event === 'issue_comment'`.
- [x] Add web tests for `buildGitHubFilters()` proving `commandPrefix` is omitted for non-comment event types and preserved for `issue_comment`.
- [x] Update `buildGitHubFilters()` to persist `commandPrefix` only for `issue_comment`.
- [x] Add presentation tests proving `formatTriggerSource()` renders the prefix for `issue_comment` and not for `issues`.
- [x] Update `formatTriggerSource()` to render `commandPrefix` only for `issue_comment`.
- [x] Add the `.claude/rules/` process fix for event-scoped filter predicates.
- [x] Run targeted API/web unit tests and prove no test collection regressions.
- [x] Run local Playwright screenshots for trigger list row rendering and trigger form GitHub fields at 1280x800 and 375x667 using stress data; review overflow/clipping/readability.
- [x] Run full quality suite.
- [x] Run specialist reviews: task-completion-validator, cloudflare-specialist, ui-ux-specialist, constitution-validator, test-engineer, doc-sync-validator.
- [x] Check for other active staging agents/runs, deploy to staging, and verify changed behavior.
- [x] Create PR with production evidence, caller enumeration, post-mortem, no-migration rationale, visual evidence, staging evidence, and specialist review table.
- [ ] Complete CI and CodeRabbit label-triggered review loop.
- [ ] Merge, monitor production deploy, and report PR number plus merge/deploy status.

## Acceptance Criteria

- [ ] Existing production GitHub `issues` trigger `01KXNX64WKGQGS955PAA7E1RFB` will no longer reject opened issues solely because its stored filters include `commandPrefix: "/sam"`.
- [x] `issue_comment` triggers still reject comments whose trimmed body does not start with the configured prefix, with reason `comment does not start with '/sam'`.
- [x] Non-comment GitHub trigger creation/update payloads produced by the UI no longer persist `commandPrefix`.
- [x] Trigger list/source labels and trigger detail configuration no longer display a command prefix as active for non-comment GitHub events.
- [x] Required unit tests pass and are proven discriminating against the original backend bug.
- [ ] Desktop and mobile Playwright screenshots for changed trigger surfaces are posted to the PR and reviewed for overflow/clipping/readability.
- [x] Staging deployment succeeds and validates the fix without overwriting another active staging run.
- [ ] PR is merged after CI and CodeRabbit review, and production deploy is monitored to completion.

## Validation Log

- Pre-fix discrimination: after adding the backend regression tests and before changing `evaluateFilters()`, `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/github-trigger-filter.test.ts` failed with 3 expected failures. Each non-comment event (`issues`, `pull_request`, `push`) returned `{ matched: false, reason: "comment does not start with '/sam'" }` instead of `{ matched: true }`.
- Post-fix API focus: `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/github-trigger-filter.test.ts` passed, 1 file / 48 tests. The same file previously had 44 tests, so the four added backend cases were collected and run.
- Post-fix web focus: `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/trigger-form-support.test.ts tests/unit/components/trigger-presentation.test.ts` passed, 2 files / 30 tests.
- Local Playwright visual audit initially failed because Chromium dependencies were missing (`libnspr4.so`, then `libnss3.so`). Installed Chromium dependencies with `sudo npx playwright install-deps chromium`, then reran successfully.
- Focused Playwright visual audit: `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/triggers-ui-audit.spec.ts --project='iPhone SE (375x667)' --project='Desktop (1280x800)' --grep='GitHub source labels|GitHub event trigger form|new GitHub event trigger form|GitHub issues form|GitHub issues detail'` passed, 8 executed / 8 project-scope skips. The audit captured and asserted trigger list, trigger detail, and GitHub trigger form behavior at 375x667 and 1280x800.
- Full quality suite: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed. Aggregate test/build evidence from the run:
  - `@simple-agent-manager/web`: 301 test files passed / 3,598 tests passed.
  - `@simple-agent-manager/api`: 653 test files passed / 8,780 tests passed.
  - Turbo reported 21 successful tasks for `pnpm test` and 9 successful tasks for `pnpm build`.
- Review follow-up API focus after adding explicit event-type-vs-comment-presence coverage: `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/github-trigger-filter.test.ts` passed, 1 file / 48 tests.
- Takeover handler-slice discrimination: with only the `event.event === 'issue_comment'` guard temporarily reverted, `pnpm --filter @simple-agent-manager/api test -- --run tests/unit/services/github-trigger-handler.test.ts -t 'admits issues events with a stale stored commandPrefix'` failed as expected with `matchedTriggers: 0` and `comment does not start with '/sam'`. Restoring the guard made the production-shaped handler/admission case pass.
- Takeover focused backend validation: `pnpm --filter @simple-agent-manager/api test -- --run tests/unit/services/github-trigger-filter.test.ts tests/unit/services/github-trigger-handler.test.ts` passed, 2 files / 56 tests.
- Takeover focused web validation: `pnpm --filter @simple-agent-manager/web test -- --run tests/unit/components/TriggerConfiguration.test.tsx tests/unit/components/trigger-form-support.test.ts tests/unit/components/trigger-presentation.test.ts` passed, 3 files / 32 tests.
- Takeover type validation: `pnpm --filter @simple-agent-manager/api typecheck` and `pnpm --filter @simple-agent-manager/web typecheck` both passed.
- Screenshot files reviewed:
  - `triggers-list-github-source-labels-mobile-375x667.png`
  - `triggers-list-github-source-labels-desktop-1280x800.png`
  - `trigger-form-github-mobile-375x667.png`
  - `trigger-form-github-desktop-1280x800.png`
  - `trigger-form-github-issues-mobile-375x667.png`
  - `trigger-form-github-issues-desktop-1280x800.png`
  - `trigger-detail-github-issues-mobile-375x667.png`
  - `trigger-detail-github-issues-desktop-1280x800.png`
- UI issue found/fixed during screenshot review: the drawer’s scrollable panel allowed scrolled content to bleed under the header and the focused lower input to crowd the footer boundary. Fixed `TriggerForm` to use a flex column shell with header/footer outside the scroll container and `scroll-pb-28` on the form body. Final screenshots reviewed for overflow, clipping, readability, and responsive behavior; no remaining issues found.
- Specialist review gate takeover findings:
  - task-completion-validator: CHANGES REQUIRED. It correctly found that local PNG paths were not durable PR attachments and the handler/admission test still used empty filters. The production-shaped handler case is now added and discriminating; durable PR attachment remains a gate before removing `needs-human-review`.
  - cloudflare-specialist: PASS. No schema, binding, secret, Durable Object, KV, R2, or `wrangler.toml` impact.
  - ui-ux-specialist: CHANGES REQUIRED. It correctly found missing durable screenshot attachments and missing measured drawer geometry assertions. Header/body/footer/focused-control coordinates are now asserted at mobile and desktop, and all eight screenshots were visually reviewed; durable PR attachment remains a gate.
  - constitution-validator: PASS. No Principle XI hardcoded URL/timeout/limit/deployment-identifier violations.
  - test-engineer: CHANGES REQUIRED. It correctly found the missing production-shaped handler slice and stale detail-view presentation. Both now have behavioral regression coverage.
  - doc-sync-validator: WARN/ADDRESSED. Task-file wording updated to describe the defective behavior as pre-fix; no public documentation drift.
- Staging coordination:
  - `mcp__sam_mcp.list_project_agents` showed five other active/sleeping project agents, but none had an active staging deployment.
  - `gh run list --workflow=deploy-staging.yml --status=in_progress --json ...` and `--status=queued` both returned `[]` before deployment.
- Staging deployment:
  - `gh workflow run deploy-staging.yml --ref sam/fix-bug-makes-every-m6y9zw` created run `33791134030`.
  - `gh run watch 33791134030 --exit-status --interval 10` completed successfully. Deploy job was green in 14m19s; smoke-tests were green in 2m33s.
  - `curl https://api.sammy.party/health` returned HTTP 200 with `{"status":"healthy",...}` during post-deploy verification.
- Task-specific staging verification:
  - Authenticated with `SAM_PLAYWRIGHT_PRIMARY_USER` against `https://api.sammy.party/api/auth/token-login`, then loaded the staging app at `https://app.sammy.party`.
  - Created a temporary GitHub `issues` trigger through the authenticated staging API on project `01KJNR9R3TEN3KX1ETE33852R8` (`Test Project 1`, repository `serverspresentation2025/crewai`) with deliberately stale stored `commandPrefix: "/sam"` to simulate the production/self-hosted stale-data shape.
  - Verified the API returned and persisted `githubConfig.eventType = "issues"` and `githubConfig.filters.commandPrefix = "/sam"` for temporary trigger `01M1M9SVPD5K8X2QDS77B3BPRX`.
  - Verified the live staging trigger list rendered `GitHub issues` and did not render `GitHub issues: /sam` at 1280x800 and 375x667.
  - Verified the live staging GitHub issues form hid `#github-command-prefix` at 1280x800 and 375x667.
  - Verified project settings and projects dashboard loaded without `Something went wrong`, no horizontal overflow was detected, and no browser console/page errors were captured.
  - Deleted temporary trigger `01M1M9SVPD5K8X2QDS77B3BPRX`.
  - Staging webhook route note: `/api/github/webhook` requires GitHub HMAC signature verification, and staging Worker secret values are intentionally not retrievable. Staging D1 had no existing GitHub triggers or deliveries to replay. The signed-webhook admission predicate remains covered by discriminating unit tests plus the deployed UI/API stale-data verification above.
- Observability noise check: `pnpm quality:observability-noise` passed. D1 observability checks skipped because `OBSERVABILITY_DB_ID` was not set; Workers telemetry skipped with 403 unavailable; result reported no significant log noise detected.

## UI/UX Validation Report

### Variants Considered

1. Backend-only/UI-serializer-only change: smallest code diff, but leaves the existing drawer overlap found during required visual audit.
2. Keep sticky header/footer inside the same scrolling panel and increase opaque backgrounds: reduces overlap, but keeps the scroll/positioning relationship fragile.
3. Use a flex column drawer with fixed header/footer and one internal scroll body: slightly broader than the originally requested hygiene change, but directly fixes the clipping/overlap exposed by screenshots.

### Selected Direction

- Choice: explicit event-scoped serialization/presentation plus flex column drawer chrome.
- Why: this keeps business behavior narrowly scoped while making the required trigger-form screenshots readable and preventing form fields from scrolling underneath header/footer chrome.

### Rubric Scores

| Category | Score | Notes |
| --- | ---: | --- |
| Visual hierarchy and scanability | 5 | Source labels distinguish active `issue_comment` prefix from inert `issues` prefix; drawer fields remain grouped and readable. |
| Interaction clarity | 5 | The GitHub event select controls whether the command prefix field exists; non-comment fields show only applicable inputs. |
| Mobile usability | 5 | 375x667 screenshots passed overflow assertions; header/footer no longer overlap scrolled content. |
| Accessibility | 5 | Native labels/selects/inputs remain; focus ring is visible on the active field. |
| System consistency | 5 | Reuses existing trigger components, tokens, and Playwright audit harness. |

### Issues Found/Fixes

- Fixed Playwright locator ambiguity where `Actions` matched row menu buttons and the form input; the audit now targets the textbox role.
- Fixed drawer content overlap/clipping discovered in the mobile issues-form screenshot by separating drawer chrome from the scroll container and adding scroll clearance.
