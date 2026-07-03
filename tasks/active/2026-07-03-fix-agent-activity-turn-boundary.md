# Fix flaky agent activity turn boundary

## Problem

Long silent tool calls can make the project chat activity indicator decay to idle and hide the Cancel button even though the ACP prompt is still active. The normal idle transition must come from the ACP prompt boundary, not from silence.

## Research findings

- VM agent prompt lifecycle already reports the authoritative boundary: `markPromptStarted()` sends `prompting`, and prompt completion sends `idle`.
- `packages/vm-agent/internal/acp/session_host_reporting.go` currently gives activity reports only a small retry window, so terminal reports can be lost.
- `apps/api/src/schemas/acp-sessions.ts` only accepts `prompting` and `idle`, while VM agent code can send `recovering` and `error`.
- `apps/api/src/durable-objects/project-data/session-state.ts` reconciles stale activity from a one-shot `activity_at` timestamp. The comment mentions message evidence, but the SQL does not check messages.
- `apps/web/src/components/project-message-view/useSessionLifecycle.ts` verifies before decay in one path, but fetch failures still clear activity and the polling fallback does not rehydrate from `data.state.activity`.
- `tasks/backlog/2026-06-20-hydratestate-arm-verify-timer-on-reconnect.md` is the reconnect counterpart and should be folded into this work.
- Rule 34 requires keeping VM agent activity callback routes outside session-auth middleware.
- Rule 47 requires a control-loop load review and a two-sweep zombie regression test for reconciler changes.

## Implementation checklist

- [ ] Add VM agent activity re-report interval config/default and re-send `prompting` while a prompt is active.
- [ ] Stop the re-report loop on prompt completion/cancel/host stop and cover it with Go tests.
- [ ] Add env-configurable terminal activity report retry count/backoff while keeping `prompting` cheap.
- [ ] Extend API activity schema and types to `prompting`, `idle`, `recovering`, and `error`.
- [ ] Treat `recovering` as working and `error` as terminal/error in project-data storage and broadcasts.
- [ ] Make stale activity reconciliation evidence-based: threshold, no messages since `activity_at`, and ACP session not live.
- [ ] Refresh `activity_at` when messages persist during `prompting` or `recovering`.
- [ ] Update client verify timer so fetch failures re-arm instead of decaying to idle.
- [ ] Rehydrate client activity from polling and reconnect snapshots, including `recovering` and `error`.
- [ ] Move the reconnect backlog task to archive after implementing its criteria.
- [ ] Add/extend Go, schema, DO, client timer, and vertical slice tests.
- [ ] Run required quality checks, specialist reviews, staging verification, PR, and merge per `/do`.

## Acceptance criteria

- [ ] A non-task prompt running a long silent command keeps the working indicator and Cancel button visible until actual prompt end.
- [ ] A genuine prompt end clears the indicator promptly via the idle activity event.
- [ ] Dead VM/agent mid-prompt eventually clears through evidence-based reconciliation.
- [ ] `recovering` and `error` activity reports no longer return 400.
- [ ] No client or server timer decays to idle on silence alone.
- [ ] Activity thresholds and retry intervals are configurable with `DEFAULT_*` constants.
- [ ] Reconciler changes include a rule 47 load review and zombie prevention test.

## References

- `packages/vm-agent/internal/acp/session_host_prompt.go`
- `packages/vm-agent/internal/acp/session_host_reporting.go`
- `packages/vm-agent/internal/acp/session_host.go`
- `apps/api/src/schemas/acp-sessions.ts`
- `apps/api/src/services/project-data.ts`
- `apps/api/src/durable-objects/project-data/session-state.ts`
- `apps/api/src/durable-objects/project-data/index.ts`
- `apps/web/src/components/project-message-view/useSessionLifecycle.ts`
- `apps/web/src/components/project-message-view/index.tsx`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/35-vertical-slice-testing.md`
