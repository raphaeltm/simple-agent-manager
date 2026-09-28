# ProjectData idle inconclusive backoff

## Problem

The ProjectData Durable Object can keep re-arming its alarm roughly every minute when a workspace idle check is due but cannot prove the workspace is safe to tear down. The sweep preserves the runtime for inconclusive task candidate sets and for non-failed terminalization outcomes, but it leaves `workspace_activity` unchanged. The shared alarm scheduler then sees the same overdue row on the next calculation.

## Research Findings

- `apps/api/src/durable-objects/project-data/idle-cleanup.ts` selects active `workspace_activity` rows, computes `lastActivity`, and processes rows older than the workspace idle timeout.
- The `workspace_idle_candidates_inconclusive` branch fires when `listReporterScopedTaskCandidates()` overflows the bounded candidate page or returns zero tasks. It logs `action: 'preserved'` and `continue`s without updating or deleting the `workspace_activity` row.
- The `workspace_idle_runtime_preserved` branch fires when at least one terminalization transition is not `failed`. It logs `action: 'preserved'` and `continue`s without updating or deleting the `workspace_activity` row.
- `computeIdleAlarmTimes()` derives `workspaceIdleCheckTime` from the minimum workspace activity timestamp plus `WORKSPACE_IDLE_CHECK_INTERVAL_MS`, clamped to `Date.now() + DEFAULT_WORKSPACE_IDLE_MIN_ALARM_DELAY_MS`. Once that activity timestamp is overdue, the clamp produces a new alarm about 60 seconds out every time.
- `computeProjectDataAlarmTime()` takes the earliest section time from `computeProjectDataAlarmSectionTimes()`, so the workspace-idle section keeps the whole ProjectData alarm scheduled.
- Live log evidence checked on 2026-09-28: Cloudflare Observability exact searches for `workspace_idle_candidates_inconclusive` and `workspace_idle_runtime_preserved` over the prior seven days returned zero exact matches on both `sam-api-prod` and `sam-api-staging`. No current repeated live workspace was found; the loop is still present by code path and will recur for the next inconclusive/preserved due workspace.
- Required rules read before editing: `apps/api/.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`, `apps/api/.claude/rules/47-control-loop-io-budget.md`, and `apps/api/.claude/rules/61-per-cycle-budget-counters.md`.

## Checklist

- [x] Add durable workspace idle retry state to `workspace_activity`.
- [x] Add env-configurable base and max backoff constants and env typing.
- [x] On inconclusive candidate selection, push the next workspace idle check into the future and increment the consecutive backoff count.
- [x] On preserved runtime outcome, push the next workspace idle check into the future and increment the consecutive backoff count.
- [x] Ensure a successful idle cleanup still deletes the workspace activity row, resetting the counter.
- [x] Ensure the alarm scheduler honors the persisted next-check time instead of the unchanged activity timestamp.
- [x] Add real-path tests for inconclusive backoff, growing backoff, success reset, and genuine idle cleanup.
- [x] Temporarily remove the fix and confirm the loop regression test fails red, then restore the fix.
- [x] Run focused tests and broader API validation.
- [ ] Complete specialist reviews, staging verification, and draft PR creation.

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
- Repeated inconclusive or preserved workspace idle outcomes use bounded growing backoff.
- The backoff counter resets after a successful workspace idle cleanup.
- A genuinely idle workspace is still cleaned up on time.
- The backoff delay is configurable through environment variables with `DEFAULT_*` constants.
- The PR is opened as draft and not merged.
