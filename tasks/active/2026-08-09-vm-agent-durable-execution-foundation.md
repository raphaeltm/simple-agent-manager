# VM Agent durable execution foundation

## Problem statement

The VM Agent currently has two reliability gaps that can duplicate or strand agent work. Periodic `prompting` activity assigns a fresh `promptStartedAt`, so the control plane never observes a stable prompt age. Separately, the hard-deadline watchdog clears the active prompt, kills the harness, enters `HostError`, and reports `idle` before `HandlePrompt` can invoke the task callback. A productive prompt can therefore become a timeout zombie: the task stays active while its host cannot accept follow-ups.

The VM-facing half of the durable execution supervisor must establish exact prompt terminal ownership, strictly resume the same ACP session after a checkpoint rollover, and durably guard prompt delivery by a stable ID. This PR is intentionally capability-gated and inert until a future Worker/ProjectData change invokes the new contracts.

Scope is limited to `packages/vm-agent/` and authoritative VM-facing protocol/configuration documentation. Do not implement Worker scheduling, ProjectData mailbox storage, durable delivery alarms, checkpoint episode coordination, or parent park/wake.

## Research findings

- `SessionHost.markPromptStarted()` in `internal/acp/session_host_prompt.go` reports `prompting`, while `reportActivity()` in `session_host_reporting.go` assigns `time.Now()` on every report. The periodic rereport loop therefore refreshes the apparent epoch instead of reusing the accepted prompt's original start.
- `watchPromptTimeout()` and `triggerPromptForceStopIfStuck()` in `session_host_prompt_state.go` clear `activePromptID` and `promptInFlight`. `HandlePrompt()` then returns at its `isPromptActive()` guard without calling `notifyPromptComplete()`. The watchdog also reports `idle` while leaving `HostError`, which creates the stale-active timeout failure recorded by idea `01KZK586BN98BRDGKC44V12HT0`.
- Natural completion, user cancel, hard deadline, checkpoint preempt, and crash/process-exit recovery currently reach terminal side effects through several paths. Crash recovery adds a local `sync.Once`, but there is no one per-prompt terminal arbiter shared by every path.
- `monitorProcessExit()` restarts after an intentional cancel and passes the prior ACP session ID, but that path calls non-strict `startAgent()`. A failed `LoadSession` may fall back to `NewSession`; checkpoint rollover must instead use the existing strict `startAgentForCrashRecovery()` / `requireLoadSession` path.
- `POST .../prompt` accepts an optional `messageId`, but it only controls transcript persistence. The handler checks host status and starts a goroutine without a durable invocation receipt, so a lost HTTP response cannot be reconciled and a retry can invoke twice.
- `internal/persistence/store.go` is the existing mode-`rwc`, WAL-backed SQLite store with append-only schema migrations. It is the correct VM-local durability boundary for delivery receipts and rollover operation records.
- `RestoreAgent()` and `tryLoadPreviousACPSession(..., allowNewSessionFallback=false)` already prove the strict resume contract and must be reused rather than creating a second snapshot/session format.
- VM direct endpoints use workspace-scoped node-management authentication (`requireNodeManagementAuth`). New receipt and rollover routes must use the same boundary, validate IDs and protocol versions, return bounded sanitized errors, and never expose prompt text, credentials, or raw runtime diagnostics.
- Current public references are `apps/www/src/content/docs/docs/reference/vm-agent.md` and `reference/configuration.md`; `.claude/skills/env-reference/SKILL.md` and `.claude/skills/api-reference/SKILL.md` are authoritative agent references.
- Retained lessons: timeout handling must not report a recoverable runtime as idle (`2026-02-20-prompt-timeout-graceful-handling.md`); intentional preemption must not consume crash restart budget (`2026-06-01-user-cancel-restart-budget.md`); strict resume failure must remain visible and never leak an orphan process (`2026-02-26-acp-session-resume-failure.md`); concurrent HTTP-visible lifecycle state needs race coverage (`2026-07-01-vm-agent-port-scanner-data-race.md`).
- Mission `382c796d-f8e7-4658-8ee0-2d2196a2f9cc` requires stable prompt epochs, exact-once terminal outcomes, bounded graceful preemption, strict same-session resume, stable delivery IDs, receipt reconciliation before retry, and explicit cross-runtime ambiguity.

## Implementation checklist

- [x] Add one accepted-prompt lifecycle object/arbiter that records the start epoch once and owns exactly one terminal outcome/callback across natural completion, user cancel, checkpoint preempt, process exit/recovery, and hard deadline.
- [x] Make every `prompting` rereport reuse the stored start epoch; clear it only after the winning terminal transition; add injected-clock tests for repeated reports and a subsequent new prompt.
- [x] Make hard deadline converge truthfully: no `idle` report with `HostError`, no stale active prompt, and exactly one recoverable/fatal task callback even when the prompt RPC does not return before force-stop.
- [x] Add versioned checkpoint-rollover request/lookup routes with durable idempotent operation records, workspace auth, bounded request validation, and additive capability advertisement.
- [x] Implement checkpoint rollover as ACP cancel plus close notification, configurable bounded grace, forced process fallback, intentional restart without crash-budget consumption, strict same-agent/same-ACP-session `LoadSession`, and explicit failure without `NewSession` fallback.
- [x] Preserve terminal precedence: natural completion or user cancel supersedes automatic rollover; late deadline/process signals cannot emit a second callback.
- [x] Add a SQLite persistence migration and focused store API for delivery receipts and rollover operations, storing request fingerprints rather than prompt text.
- [x] Extend VM prompt submission with an optional versioned delivery ID. Atomically persist acceptance and mark `in_flight` before actual ACP invocation; duplicate same-payload IDs return the existing receipt and never invoke twice; conflicting payload reuse fails closed.
- [x] Add authenticated receipt lookup for lost-response reconciliation. On VM runtime restart, convert prior-runtime `in_flight` receipts to explicit `ambiguous`; never replay them automatically. Definitively pre-invocation `accepted` records may be claimed safely.
- [x] Mark receipt completion from the winning prompt terminal transition, including stop reason and bounded sanitized error code, so crash recovery and timeout paths cannot leave a false success.
- [x] Preserve old-client behavior when delivery IDs/protocol-version fields are absent; do not start automatic checkpoints or change short-prompt behavior until the Worker invokes the advertised capability.
- [x] Add named configuration defaults and validation for checkpoint preempt grace, maximum request grace, and rollover operation timeout; wire and document all VM Agent settings.
- [x] Update VM Agent endpoint, capability, receipt-state, rollover-state, compatibility, configuration, and risk contracts in public and agent references, citing the implementing code paths.
- [x] Add behavioral tests for epoch stability/new epoch, exact-once race matrices, graceful/forced preempt, strict resume failure, timeout convergence, duplicate/lost-response/restart receipt durability, cross-runtime ambiguity, capability advertisement, authentication, input bounds, and legacy clients.
- [ ] Run focused Go tests while implementing, then `go test ./...`, `go test -race ./...`, `go vet ./...`, repository lint/typecheck/test/build gates, specialist reviews, and task-completion validation. Focused/full/race/vet Go gates are green; repository gates and reviews remain.
- [ ] Deploy to staging, provision a real VM, verify heartbeat/workspace access and real graceful/forced rollover behavior, then clean up the staging workspace/node immediately.
- [ ] Open a PR with review/staging evidence, update from latest `main`, merge only after all checks are green, monitor production deployment, and publish endpoint/receipt/capability contracts plus residual risks to the mission.

## Acceptance criteria

- Repeated activity reports for one accepted prompt carry exactly the same prompt start epoch; only a later accepted prompt creates a new epoch.
- Every prompt has exactly one terminal outcome and exactly one task callback across completion/cancel/preempt/process-exit/deadline races.
- A hard deadline cannot leave `HostError` plus an active task or report `idle`; failure or recovery is explicit and callback-backed.
- Checkpoint rollover is versioned and idempotent, attempts graceful ACP cancel/close within a configurable bound, force-stops when necessary, restarts the harness, and resumes only the exact prior ACP session.
- A failed or unsupported strict `LoadSession` returns/persists an explicit rollover failure and never creates a fresh ACP session.
- A stable delivery ID is durably accepted before invocation. Same-scope/same-payload retries never invoke twice, lost responses can be reconciled by receipt lookup, and conflicting reuse fails closed.
- A receipt that was in-flight under another VM runtime becomes explicit `ambiguous` and is never automatically replayed.
- Capability discovery describes protocol version 1 receipt and rollover support plus configured timing limits. Clients that omit all new fields retain current prompt/cancel behavior.
- No automatic checkpoint or delivery retry occurs until future Worker code invokes the new capability.
- Focused/full/race Go suites and repository quality gates pass; real-VM staging proves heartbeat, access, strict resume, and cleanup.
- PR merges green, production deploy succeeds, and the mission receives the shipped contracts and risks.

## References

- SAM idea `01KZK586BN98BRDGKC44V12HT0`
- Mission `382c796d-f8e7-4658-8ee0-2d2196a2f9cc`
- Replacement task `01KZK7TY0H9TRAZDJFVG400HV6`; failed startup-only predecessor `01KZK7PY1BXG595CD8BSQMXMGC`
- `packages/vm-agent/internal/acp/session_host_prompt_state.go`
- `packages/vm-agent/internal/acp/session_host_prompt.go`
- `packages/vm-agent/internal/acp/session_host_reporting.go`
- `packages/vm-agent/internal/acp/session_host_process.go`
- `packages/vm-agent/internal/server/workspaces.go`
- `packages/vm-agent/internal/persistence/store.go`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/22-infrastructure-merge-gate.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
