# ProjectData idle inconclusive backoff

## Problem

The ProjectData Durable Object can keep re-arming its alarm roughly every minute when a workspace idle check is due but cannot prove the workspace is safe to tear down. The sweep preserves the runtime for inconclusive task candidate sets and for non-failed terminalization outcomes, but it leaves `workspace_activity` unchanged. The shared alarm scheduler then sees the same overdue row on the next calculation.

## Research Findings

- `apps/api/src/durable-objects/project-data/idle-cleanup.ts` selects active `workspace_activity` rows, computes `lastActivity`, and processes rows older than the workspace idle timeout.
- The `workspace_idle_candidates_inconclusive` branch fires when `listReporterScopedTaskCandidates()` overflows the bounded candidate page or returns zero tasks. It logs `action: 'preserved'` and `continue`s without updating or deleting the `workspace_activity` row.
- The `workspace_idle_runtime_preserved` branch fires when at least one terminalization transition is not `failed`. It logs `action: 'preserved'` and `continue`s without updating or deleting the `workspace_activity` row.
- `computeIdleAlarmTimes()` derives `workspaceIdleCheckTime` from the minimum workspace activity timestamp plus `WORKSPACE_IDLE_CHECK_INTERVAL_MS`, clamped to `Date.now() + DEFAULT_WORKSPACE_IDLE_MIN_ALARM_DELAY_MS`. Once that activity timestamp is overdue, the clamp produces a new alarm about 60 seconds out every time.
- Coordinator review found the likely live 60-second loop was broader than the first fix: `computeIdleAlarmTimes()` scanned all `workspace_activity` rows, while `checkWorkspaceIdleTimeouts()` only processes rows whose `chat_sessions` row is still `active`. Sleeping or stopped sessions can legitimately retain `workspace_activity` until workspace finalization; those rows are not sweep candidates and must not schedule the workspace-idle alarm.
- `computeProjectDataAlarmTime()` takes the earliest section time from `computeProjectDataAlarmSectionTimes()`, so the workspace-idle section keeps the whole ProjectData alarm scheduled.
- Discriminating test proof on `origin/main` in `/workspaces/sam-main-idle-red`: adding the sleeping-session alarm-path test to `conversation-idle-timeout.test.ts` failed with `expected 1786017660000 not to be 1786017660000`, proving current main scheduled the ProjectData alarm at exactly `NOW + 60_000`.
- Live log evidence checked on 2026-09-28: Cloudflare Observability exact searches for `workspace_idle_candidates_inconclusive` and `workspace_idle_runtime_preserved` over the prior seven days returned zero exact matches on both `sam-api-prod` and `sam-api-staging`. No current repeated live workspace was found; the loop is still present by code path and will recur for the next inconclusive/preserved due workspace.
- Production Durable Object telemetry checked on 2026-09-28 09:19Z: Worker binding settings map namespace `fb36fe2173534537b0f0a9a0efb17777` to `PROJECT_DATA`. In the previous 24 hours (`2026-09-27T09:19:56Z` to `2026-09-28T09:19:56Z`), `sam-api-prod` ProjectData alarm invocations totaled 32,910 across 25 objects; 19 objects had at least 1,200 alarm invocations, consistent with near-minute cadence, and the SAM project object `01KHRJGANBBWGDY1NZ0KVF0D4J` had 6,579 invocations.
- Required rules read before editing: `apps/api/.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`, `apps/api/.claude/rules/47-control-loop-io-budget.md`, and `apps/api/.claude/rules/61-per-cycle-budget-counters.md`.

## Checklist

- [x] Add durable workspace idle retry state to `workspace_activity`.
- [x] Add env-configurable base and max backoff constants and env typing.
- [x] On inconclusive candidate selection, push the next workspace idle check into the future and increment the consecutive backoff count.
- [x] On preserved runtime outcome, push the next workspace idle check into the future and increment the consecutive backoff count.
- [x] Ensure a successful idle cleanup still deletes the workspace activity row, resetting the counter.
- [x] Ensure the alarm scheduler honors the persisted next-check time instead of the unchanged activity timestamp.
- [x] Ensure the alarm scheduler only considers active chat-session rows that the workspace idle sweep can process.
- [x] Add real-path tests for inconclusive backoff, sleeping-session alarm suppression, wake-back-to-active cleanup, growing backoff, success reset, and genuine idle cleanup.
- [x] Temporarily remove the fix and confirm the loop regression test fails red, then restore the fix.
- [x] Restore accidental `.codex/config.toml` churn so the PR does not touch it.
- [x] Document when the workspace idle retry counter starts over: new terminal/message activity, a session wake, successful cleanup, or a check that finds the workspace no longer idle. A preserved runtime or inconclusive check keeps it growing (`recordWorkspaceIdleRetry` doc comment).
- [x] Run focused tests and broader API validation.
- [x] Complete specialist reviews, staging verification, and draft PR creation.

## Validation

- `pnpm --filter @simple-agent-manager/shared build`
- `pnpm --filter @simple-agent-manager/shared typecheck`
- `pnpm --filter @simple-agent-manager/api test -- conversation-idle-timeout.test.ts durable-objects/alarm-schedule.test.ts durable-objects/migrations.test.ts`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api lint`
- `pnpm --filter @simple-agent-manager/api build`
- `pnpm --filter @simple-agent-manager/www typecheck`
- `pnpm --filter @simple-agent-manager/www build`
- `git diff --check`

## Specialist Review Evidence

- Task completion validator: PASS. Checklist and acceptance criteria map to the diff and tests; no UI/backend propagation or multi-resource selection concerns.
- Cloudflare specialist: PASS. Migration is append-only, uses INTEGER timestamp/counter fields, and adds an index for the new retry deadline. The DO alarm path remains local-SQL plus existing bounded D1 candidate probes.
- Constitution validator: PASS. New retry delays have env vars and `DEFAULT_*` constants; the exponent guard is a named implementation safety constant, not a deployment tuning value.
- Test engineer: PASS. Tests drive `checkWorkspaceIdleTimeouts()` and `computeProjectDataAlarmTime()` through realistic DO SQL + D1 state, include a genuine cleanup control, and the regression was proven red when the durable update was temporarily removed.
- Env validator: PASS. New Worker env vars are present in both Env interfaces and documented in `.env.example`, public configuration docs, and `$env-reference`.
- Doc sync validator: PASS. Configuration docs and skill reference match the new code/defaults.

## Acceptance Criteria

- An overdue workspace whose idle check is inconclusive does not schedule the next ProjectData alarm about 60 seconds out.
- A `workspace_activity` row for a sleeping or stopped chat session does not schedule the next ProjectData alarm about 60 seconds out.
- Waking that session back to `active` resumes workspace idle scheduling, and a genuinely idle workspace is still cleaned up on time.
- Repeated inconclusive or preserved workspace idle outcomes use bounded growing backoff.
- The backoff counter resets after a successful workspace idle cleanup.
- A genuinely idle workspace is still cleaned up on time.
- The backoff delay is configurable through environment variables with `DEFAULT_*` constants.
- ~~The PR is opened as draft and not merged.~~ Superseded 2026-09-28 by task `01M3KQ17PETQECG3QZBMVY0F4W`: independently review, finish, and ship PR #2170.
- A quiet active workspace (not idle yet) is checked once after its activity and then only at its idle deadline, never re-armed at the 60-second floor, for both the installation default and a project `workspace_idle_timeout_ms` override.
- An idle workspace queued behind a full page of busy or permanently failing checks is still reached within a bounded number of alarms.
- A throwing check leaves the candidate set with a backoff retry, and activity that lands mid-check clears that retry.
- A session that wakes in place starts a new idle cycle, so a stale backoff cannot delay cleanup.
- A failed project-timeout lookup records no destructive verdict.
- `idle-cleanup.ts` and every other touched source file stay within the rule-18 500-line ceiling.

## Staging verification

- PASS: GitHub Actions `Deploy Staging` run 36397425870 on branch `sam/stop-projectdata-durable-object-22878v`: deployment completed, database migrations with safety gates passed, API worker deployed, health check passed, and smoke tests passed (`12 passed` in 1.2m). Run URL: https://github.com/raphaeltm/simple-agent-manager/actions/runs/36397425870
- Draft PR opened as requested and not merged: https://github.com/raphaeltm/simple-agent-manager/pull/2170

## Independent adversarial review (2026-09-28, task `01M3KQ17PETQECG3QZBMVY0F4W`)

Reviewed PR head `7c2c60424` and reproduced each finding with scratch probes that drove the real
`computeProjectDataAlarmSectionTimes()` + `checkWorkspaceIdleTimeouts()` against real SQLite.

### Findings

- **HIGH — scheduler and sweep still disagreed.** The scheduler timed every active-session row at
  `lastActivity + WORKSPACE_IDLE_CHECK_INTERVAL_MS` (5 min), but the sweep only acts at
  `lastActivity + timeoutMs` (2 h default, 30 min–24 h per project). An active session quiet for
  more than ~4 minutes re-armed the ProjectData alarm at the 60 s floor until the timeout: probe
  measured **110 workspace-idle re-arms** for one session quiet 10 minutes. Same loop the PR set out
  to stop, still present for every quiet active session.
- **HIGH — starvation behind the page.** The sweep selected `ORDER BY workspace_id LIMIT 5` and never
  wrote to a not-yet-idle row, so five busy active rows sorting first kept an idle workspace behind
  them from ever being checked (probe: task stayed `in_progress`, alarm pinned at +60 s).
- **MEDIUM — no escape on a throwing check.** The catch path logged and skipped with no deferral, so
  a persistent D1 failure re-armed every 60 s (rule 47 escape path). Probe deltas `[60000, 60000, 60000]`.
- **MEDIUM — stale backoff survives an in-place wake.** `wakeSession()` did not touch
  `workspace_activity`; a cf-container session woken in place kept a six-hour backoff, delaying
  cleanup by **230 minutes** in the probe.
- **MEDIUM (pre-existing, same function) — destructive verdict on an unknown timeout.** A failed D1
  read of `projects.workspace_idle_timeout_ms` fell back to the installation default, which can be
  shorter than the project's setting and retire workspaces early (rule 58 requirement 4).
- **LOW — two `lastActivity` definitions.** The scheduler's `max()` included `wa.created_at`, the
  sweep's did not.
- **LOW — deferral race.** The deferral was written after the D1 awaits, so activity arriving during
  the check had its reset overwritten.
- **Rule 18.** `idle-cleanup.ts` was 748 lines and `sessions.ts` 615 lines (500 ceiling), both touched.
- Migration `060-workspace-idle-backoff` is additive only (two `ALTER TABLE ... ADD COLUMN`);
  `pnpm quality:do-migration-safety` passes. Its first version also created
  `idx_workspace_activity_next_idle_check`, which no query can use (review round 1, below); that
  version ran on staging only, so the index was dropped from the migration with a retirement note,
  following the `059` precedent. Staging objects that ran it keep the unused index.

### Fix checklist

- [x] Split the workspace idle sweep, backoff, and alarm time into `workspace-idle-timeouts.ts` as a
      pure move (`idle-cleanup.ts` 748 → 455 lines); alarm-schedule computes each idle section
      through the shared per-section isolation.
- [x] One CTE (`WORKSPACE_IDLE_CHECKS_CTE`) defines tracked rows, `last_activity_at`, and
      `next_check_at` for both the sweep and the scheduler.
- [x] Not idle yet → record the idle deadline (retry count 0). Idle → record the backoff retry before
      any await, then retire or keep it. A throw keeps the recorded retry.
- [x] Due rows are taken most overdue first (`ORDER BY next_check_at, workspace_id`).
- [x] A failed project-timeout read records retries only, no verdict.
- [x] `wakeSession()` clears the recorded check (`activity.clearWorkspaceIdleCheck`).
- [x] The sweep skips its D1 timeout read when no row is due.
- [x] Split session reads into `session-reads.ts` as a pure move (`sessions.ts` 618 → 450 lines).
- [x] Docs: `configuration.md`, `.env.example`, `$env-reference`, shared constant doc comments.
- [x] Tests: 18 unit cases (`workspace idle timeouts` describe in
      `tests/unit/conversation-idle-timeout.test.ts`) plus
      `tests/workers/project-data-workspace-idle-alarm.test.ts` through the real `ProjectData.alarm()`.

### Local specialist review, round 1 (on `96e458a18` / `596b8abf0`)

| Reviewer | Result | Disposition |
| --- | --- | --- |
| cloudflare-specialist | FAIL: 1 HIGH | **HIGH** cross-row stale snapshot: the sweep read every due row before its awaits, so activity landing during the project-timeout lookup or an earlier row's check was overwritten by a stale retry (up to 6 h of missed enforcement). Fixed: checks are taken one at a time and re-read just before acting (`forEachDueWorkspaceIdleCheck`), with regression tests for both windows. **MEDIUM** no per-row parse isolation: fixed; an unreadable row is set aside by `rowid` for the longest retry and logged. **LOW** `created_at` not COALESCEd in `max()`: fixed. **LOW** unused index: fixed. **LOW** dedicated batch-size knob: declined; `IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP` already bounds a pass and the backlog drains a page per alarm (tested). |
| architecture-reviewer | 2 MEDIUM | Unused `idx_workspace_activity_next_idle_check`: dropped from migration 060 (staging-only) with a retirement note. `idle-cleanup.ts` local `positiveInt` duplicated `parsePositiveInt`: replaced at all 7 call sites. **LOW** capped exponential backoff is copied ~10 times across the repo (pre-existing): tracked as a follow-up idea. |
| test-engineer | PASS, 3 MEDIUM | Backoff cap never exercised: the growth test now reaches the cap. Drain beyond one page of successful retirements untested: added. Parse isolation: fixed as above. **LOW** exponent safety cap untested: removed (overflow to `Infinity` is already clamped by `maxMs`). **LOW** skipped D1 read unasserted: added. |
| constitution-validator | PASS | LOW items: exponent cap removed; `DEFAULT_WORKSPACE_IDLE_MIN_ALARM_DELAY_MS` now documents why it is deliberately not env-configurable; `WORKSPACE_IDLE_CHECK_INTERVAL_MS` has no env override on main either (kept). |
| env-validator | PASS | LOW: docs now list the missing-project-identity cause; the pre-existing gaps are closed (`WORKSPACE_IDLE_TIMEOUT_MS` in `configuration.md` and `$env-reference`, `IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP` in `$env-reference`). |
| doc-sync-validator | PASS | INFO: `WORKSPACE_IDLE_TIMEOUT_MS` row added. The rule-50 follow-up list still correctly names `idle-cleanup` (its schedule read is unchanged), and the new module isolates rows. |
| performance-reviewer | PASS | LOW/MEDIUM per-isolate cache for the project timeout: declined. The read now happens only when a row is due, ProjectData instances are evicted between minute-spaced ticks so an isolate cache would rarely hit, and the setting is user-mutable rather than once-per-deploy (rule 60). Noted for the post-deploy read: the SAM object also has mailbox 30 s polls and heartbeat sections, so it will not drop to the quiet-object baseline. |
| task-completion-validator | FAIL on process gates | Technical checks A/B/C/F passed. The remaining gates (staging on the final head, CI on the final head, CodeRabbit, the PR body's stale "must not be merged" line, final SHAs in this file) are the Phase 6/7 steps below. The validator is re-run before archive. |

### Discrimination evidence

- Against the draft head (`7c2c60424`) logic, 9 of the first 13 unit cases and the workers test
  fail; the other 4 cover behavior the draft already had (sleeping/stopped rows unarmed,
  inconclusive backoff, growth, cleanup). Against the round-1 head (`596b8abf0`), both stale-read
  cases and the unreadable-row case fail.
- Each guard was removed once and exactly its test went red:
  deadline write → 5 tests (both deadline cases, full-page, backoff restart, in-place wake);
  ordering → most-overdue test; retry after the await → mid-check race test (+ failing-page test
  when the throw path also lost its retry); wake reset → in-place wake test; timeout fallback →
  no-verdict test; deadline not resetting the count → backoff restart test; max clamp removed →
  capped-growth test; early return removed → skipped-lookup test; one check per pass → drain,
  full-page, failing-page and unreadable-row tests. On the final code the deadline-write mutation
  reddens 6 tests (the skipped-lookup test's liveness step also depends on it).

### Local validation

- `pnpm --filter @simple-agent-manager/api test` — 780 files, 10,908 tests passed.
- `vitest --config vitest.workers.config.ts tests/workers/project-data*` — 15 files, 387 tests passed.
- `pnpm check:fast`, `pnpm quality:do-migration-safety`, API `tsc`, API build — passed.

### Production baseline before merge

Cloudflare GraphQL `durableObjectsInvocationsAdaptiveGroups`, namespace
`fb36fe2173534537b0f0a9a0efb17777`, `type = alarm`, 2026-09-27T10:00Z–2026-09-28T10:00Z:
**33,151 alarm invocations (1,381/h) across 25 objects**; SAM object 6,814; 19 objects at
1,436–1,500/day (the 60 s floor); 6 objects at ~24/day.

### Known bounded behavior (not a defect)

- An idle workspace that stays unretirable (live runtime, no candidate task) is re-checked at most
  every `WORKSPACE_IDLE_BACKOFF_MAX_MS` (6 h, ≤ 4 checks/day) until activity, a wake, sleep/stop, or
  workspace finalization ends the cycle.
- A lowered project workspace idle timeout applies from each workspace's next check (at most the
  previous timeout later), since the sweep records deadlines instead of re-reading the setting every
  minute.
