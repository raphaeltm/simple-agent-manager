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

- `apps/api/src/services/github-trigger-filter.ts` exports the pure `evaluateFilters()` predicate. The comment says command prefix is for `issue_comment` events, but the code applies it to every GitHub webhook event.
- The only production caller is `apps/api/src/services/github-trigger-handler.ts`, after GitHub signature/dedup/project lookup and after the trigger config `eventType` has already been matched against the webhook event.
- Caller enumeration for `.claude/rules/67`: `rg "evaluateFilters\\("` finds:
  - `apps/api/src/services/github-trigger-handler.ts:226` — runtime caller. Narrowing `commandPrefix` to `issue_comment` changes behavior only for stored non-comment GitHub triggers with stray `commandPrefix`, turning an incorrect rejection into normal evaluation of the remaining filters. `issue_comment` behavior remains unchanged.
  - `apps/api/tests/unit/services/github-trigger-filter.test.ts` — tests only.
- `apps/web/src/components/triggers/TriggerForm.tsx` initializes new GitHub trigger command prefix state to `/sam` and edit state to `existing ?? '/sam'`.
- `apps/web/src/components/triggers/GitHubTriggerFields.tsx` only renders the command-prefix input for `issue_comment`, so non-comment triggers cannot see or clear the stale field.
- `apps/web/src/components/triggers/trigger-form-support.ts` builds GitHub filters and currently persists a trimmed `commandPrefix` regardless of event type.
- `apps/web/src/components/triggers/trigger-presentation.tsx` renders any stored `commandPrefix` in source labels, producing misleading labels such as `GitHub issues: /sam`.
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

Separately, the observability lesson is that an active trigger with deliveries recorded as `filtered` for weeks, `trigger_count = 0`, and a stable rejection reason should be surfaced in the triggers UI. Capture that as a SAM Idea, not a GitHub Issue, and do not expand this PR’s implementation scope.

## Implementation Checklist

- [x] Add backend regression tests proving `issues`/`opened`, `pull_request`/`opened`, and `push` events with stray stored `commandPrefix: "/sam"` still match when all applicable filters pass.
- [x] Add an `issue_comment` control test proving `commandPrefix` is still enforced and preserves the `comment does not start with '/sam'` reason string.
- [x] Verify the `issues` regression test fails against pre-fix code and record the command/result.
- [x] Update `evaluateFilters()` to apply `commandPrefix` only when `event.event === 'issue_comment'`.
- [x] Add web tests for `buildGitHubFilters()` proving `commandPrefix` is omitted for non-comment event types and preserved for `issue_comment`.
- [x] Update `buildGitHubFilters()` to persist `commandPrefix` only for `issue_comment`.
- [x] Add presentation tests proving `formatTriggerSource()` renders the prefix for `issue_comment` and not for `issues`.
- [x] Update `formatTriggerSource()` to render `commandPrefix` only for `issue_comment`.
- [x] Add the `.claude/rules/` process fix for event-scoped filter predicates.
- [x] Run targeted API/web unit tests and prove no test collection regressions.
- [ ] Run local Playwright screenshots for trigger list row rendering and trigger form GitHub fields at 1280x800 and 375x667 using stress data; review overflow/clipping/readability.
- [ ] Run full quality suite.
- [ ] Run specialist reviews: task-completion-validator, cloudflare-specialist, ui-ux-specialist, constitution-validator, test-engineer, doc-sync-validator.
- [ ] Check for other active staging agents/runs, deploy to staging, and verify changed behavior.
- [ ] Create PR with production evidence, caller enumeration, post-mortem, no-migration rationale, visual evidence, staging evidence, and specialist review table.
- [ ] Complete CI and CodeRabbit label-triggered review loop.
- [ ] Merge, monitor production deploy, and report PR number plus merge/deploy status.

## Acceptance Criteria

- [ ] Existing production GitHub `issues` trigger `01KXNX64WKGQGS955PAA7E1RFB` will no longer reject opened issues solely because its stored filters include `commandPrefix: "/sam"`.
- [ ] `issue_comment` triggers still reject comments whose trimmed body does not start with the configured prefix, with reason `comment does not start with '/sam'`.
- [ ] Non-comment GitHub trigger creation/update payloads produced by the UI no longer persist `commandPrefix`.
- [ ] Trigger list/source labels no longer display a command prefix for non-comment GitHub events.
- [ ] Required unit tests pass and are proven discriminating against the original backend bug.
- [ ] Desktop and mobile Playwright screenshots for changed trigger surfaces are posted to the PR and reviewed for overflow/clipping/readability.
- [ ] Staging deployment succeeds and validates the fix without overwriting another active staging run.
- [ ] PR is merged after CI and CodeRabbit review, and production deploy is monitored to completion.

## Validation Log

- Pre-fix discrimination: after adding the backend regression tests and before changing `evaluateFilters()`, `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/github-trigger-filter.test.ts` failed with 3 expected failures. Each non-comment event (`issues`, `pull_request`, `push`) returned `{ matched: false, reason: "comment does not start with '/sam'" }` instead of `{ matched: true }`.
- Post-fix API focus: `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/github-trigger-filter.test.ts` passed, 1 file / 47 tests. The same file previously had 44 tests, so the three added backend cases were collected and run.
- Post-fix web focus: `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/trigger-form-support.test.ts tests/unit/components/trigger-presentation.test.ts` passed, 2 files / 30 tests.
