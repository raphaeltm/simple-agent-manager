# Fix check-in watchdog busy-agent false kills

**Status**: active
**Created**: 2026-08-27
**SAM task**: `01M10SK8WMTRCGB5RHBP6GQ5QJ`
**Branch**: `sam/fix-sam-check-watchdog-6gq5qj`

## Problem

Two productive task agents were failed on 2026-08-26 with
`Agent became unresponsive after SAM check-in` while their runtimes were still alive and working.
The watchdog treated "did not answer the queued check-in prompt before the marker deadline" as
"agent is dead".

Confirmed production symptoms:

- Task `01M0Z8YG9AB2WHJ4ZYQYDF317C` failed at `2026-08-26T19:54:29.116Z`, after PR #1904 had
  merged at `19:00:00Z` and while the agent was doing post-deploy monitoring. D1
  `task_status_events` shows the terminal writer was the check-in expiry reason. The D1
  `agent_sessions` row did not stop until `19:56:15.167Z`, and the node heartbeated at
  `19:55:12.521Z`, both after the failure.
- Task `01M0ZQ9X42SXV94EJP0NAYZWMB` failed at `2026-08-26T22:02:50.135Z`. PR #1925 merged at
  `22:05:30Z`, after the failure. D1 `agent_sessions` did not stop until `22:05:29.346Z`, and
  observability has `ACP Prompt started` at `22:01:22Z`, shortly before the failure. The node
  heartbeated at `22:03:09.210Z`, after the failure.

## Root cause

- `apps/api/src/durable-objects/project-data/reconciliation.ts` sends visible check-in prompts by
  persisting a user-role message and creating a `reconciliation_checkin` attention marker with
  `TASK_RECONCILIATION_RESPONSE_DEADLINE_MS`.
- `apps/api/src/durable-objects/project-data/attention-expiry.ts` processes expired
  `reconciliation_checkin` markers and writes the terminal failure
  `Agent became unresponsive after SAM check-in`.
- PR #1916 already added a guard that defers expiry when ProjectData has current-generation
  `prompting`/`recovering` state or `runtime_work_state IN ('active','settling')`.
- Remaining gap: the expiry guard can re-arm indefinitely from active prompt/runtime-work state
  because it has no check-in-specific hard ceiling. A wedged prompt/tool call must not make the
  session immortal.

## Implementation checklist

- [x] Add an env-configurable check-in active-work hard ceiling with a `DEFAULT_*` constant.
- [x] Apply that ceiling when deciding whether expired `reconciliation_checkin` markers should be
      deferred for active prompt work.
- [x] Apply that ceiling when deciding whether expired `reconciliation_checkin` markers should be
      deferred for runtime/tool-call work.
- [x] Cap the next marker expiry at the earliest active-work ceiling instead of blindly extending
      by the full response deadline.
- [x] Preserve genuine silent-stall behavior: no active work/recent evidence still fails with the
      existing diagnostic.
- [x] Add tests through `processExpiredAttentionMarkers`, the real expiry trigger:
  - [x] in-flight prompt/tool work survives the old response deadline;
  - [x] no activity/no in-flight work still fails;
  - [x] in-flight work past the hard ceiling fails;
  - [x] repeated busy check-ins cannot re-arm forever without fresh evidence.

## Validation

- `pnpm --filter @simple-agent-manager/api test -- attention-expiry`
- `pnpm --filter @simple-agent-manager/api test -- reconciliation attention-expiry task-terminal-transition`
- `pnpm --filter @simple-agent-manager/api test -- task-runtime-liveness acp-session-heartbeat-timeout vm-prompt-delivery-adapter node-agent-create-workspace-timeout`
- `pnpm --filter @simple-agent-manager/api test` — 618 files / 8,438 tests
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api lint`
- `pnpm --filter @simple-agent-manager/shared typecheck`
- `pnpm --filter @simple-agent-manager/shared lint`
- `go test ./internal/acp` from `packages/vm-agent`
- Staging deploy: GitHub Actions `deploy-staging.yml` run `33043566947` for commit `0504cec1c`
  completed successfully, including post-deploy smoke tests, at `2026-08-27T06:02:33Z`.

## Runtime coverage

The check-in verdict is ProjectData-side and is not implemented separately per runtime. It reads
`acp_sessions` + the durable `session_state` mirror; the same vm-agent ACP activity callback feeds
that mirror for both VM and `cf-container` sessions. Container-only active-work leases remain part
of task runtime liveness and were covered by the existing `task-runtime-liveness`/container adapter
tests above.

## Acceptance criteria

- Busy agents with active ACP prompt/runtime-work evidence are not killed solely for failing to
  answer a queued check-in before the old 60s deadline.
- A wedged prompt/tool call has a generous, env-configurable absolute ceiling and then fails
  visibly with `Agent became unresponsive after SAM check-in`.
- Existing terminal diagnostics and cleanup path remain intact.
- Tests prove the behavior through the production expiry trigger and include the silent-stall
  control.

## References

- `.claude/rules/39-debug-before-redesign.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/57-write-only-cross-boundary-state.md`
- `.claude/rules/61-guards-must-cover-every-runtime.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `tasks/archive/2026-08-26-fix-reconciliation-checkin-attention-expiry.md`
