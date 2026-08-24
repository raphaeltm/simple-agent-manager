# Session idleness + work lease slice

**SAM task**: `01M0HC5AEWPJJY2356FW3WPB6G`
**Branch**: `sam/implement-next-independently-shippable-3wpb6g`
**Status**: PR #1874; review feedback applied 2026-08-24

## Problem statement

SAM still has competing answers to “is this session idle?” after PRs #1844 and #1845. The shipped mitigations fixed slept-session death classification and Claude-only hidden background work, but Codex/OpenCode tool calls still do not feed the work lease, and the sleep reader still embeds its own activity/lease checks instead of calling a shared session-idleness predicate.

Canonical rule from Raphaël: a session is idle only after the prompt turn ended and no agent-initiated tool call, subagent/subtask, or other unit expected to return is still in flight. Detached long-lived side effects do not pin compute.

This slice must be independently shippable: extend the existing finite renewable `runtime_work_state` lease to ACP tool-call lifecycles and introduce one shared `classifySessionIdleness()` predicate for authoritative sleep reads. Do not delete older proxy readers until their replacement signal is authoritative.

## Research findings

- Idea `01M08VJDHK3MNYMZCQF5AJC17P` says the right shape is already present twice: cf-container `activeWork`, and VM `runtime_work_state` with `HARNESS_BACKGROUND_WORK_LEASE_MS`. The next step is to generalize this into a shared idleness predicate and stop using prompt-ended or heartbeat proxies as idleness proof.
- Idea `01M07SW32WP8ZXABWF1ZV3AEMX` identifies the Codex/OpenCode blind spot: `packages/vm-agent/internal/acp/message_extract.go` already parses ACP `ToolCall` / `ToolCallUpdate` statuses but only persists them as chat metadata. It should feed the same normalized runtime-work state as Claude `background_tasks_changed`.
- PR #1844 (`35c5732e`) shipped `classifyTaskRuntimeLiveness()` resumability protection for slept sessions. It intentionally did not change `session-sleep.ts`.
- PR #1845 (`855f701e`) shipped Claude `_claude/sdkMessage` lifecycle detection, ProjectData `runtime_work_state`, `HARNESS_BACKGROUND_WORK_LEASE_MS`, `HARNESS_BACKGROUND_WORK_MAX_DURATION_MS`, and durable `wait_for_subtasks`. It documents Codex/OpenCode and full shared-idle-predicate work as follow-ups.
- Current `session-sleep.ts` already has the lease math and three race gates (`checkAutomaticSessionSleepEligibility`, `stateBefore`, `stateAfter`, `stateAtStop`), but the logic is local (`isActivitySafeForSleep`, `isHarnessWorkLeaseActive`), not shared.
- Current `SessionHost.SessionUpdate` is the VM-agent point where standard ACP `ToolCall` / `ToolCallUpdate` notifications are observed. The notification path must remain non-blocking and must not leak raw tool input/output across the VM boundary.
- Current ProjectData `task_wait_subscriptions` and D1 task parentage were considered as child/subtask idleness signals. **Rejected on review** (Raphaël, 2026-08-24, PR #1874 comment): a parent blocked on `wait_for_subtasks` should sleep and be woken durably by the ProjectData parent-wake delivery path, not be kept awake because it has children. Sleep+durable-wake is more resource-efficient, and the fix for lineage breakage belongs on the wake/identity side.
- Current DO idle cleanup and workspace idle timeout paths already route terminalization through `classifyTaskRuntimeLiveness()`, but their candidate selection still uses older schedule/activity proxies. Converting those selectors in this slice would widen control-loop scope and requires more adapter work; keep them as deliberate gaps unless directly covered by new authoritative idleness signals.
- Rule 53 forbids liveness/heartbeat timestamps as idleness predicates. Rule 47 requires finite leases, absolute ceilings, and control-loop escape paths. Rule 35 requires vertical-slice tests for cross-boundary flows. Rule 58 protects sleep/delete/recovery from conclusive-death drift.

## Implemented slice

- Added `apps/api/src/services/session-idleness.ts` with the shared `classifySessionIdleness()` predicate, finite `runtime_work_state` lease math, and an absolute progress ceiling.
- Converted `checkAutomaticSessionSleepEligibility()` plus the `sleepWorkspaceSession()` state-before, state-after, and state-at-stop gates to call the shared predicate.
- Split the predicate by `SessionIdlenessPolicy`. `prompt-turn-ended` is the safety question (turn ended, no runtime-work lease) used by the three teardown gates; `idle-interval-elapsed` layers the automatic-sleep scheduling interval on top and is used only by the unattended scheduler.
- Added VM-agent ACP `tool_call` / `tool_call_update` runtime-work normalization for `openai-codex` and `opencode` with source `acp_tool_call`. Initial/nonterminal/content-only updates start or renew work; terminal `completed`/`failed`/`cancelled` updates clear it.
- Added `reconcileHarnessWorkAtPromptTurnEnd()`, run from the shared `markPromptDone` turn-end hook, so ACP tool calls orphaned by an interrupt or an unflushed `turn/completed` settle instead of pinning the session forever.
- Preserved Claude `_claude/sdkMessage` behavior by keeping source `claude_sdk` exclusive for `claude-code`; standard ACP tool calls do not override it. cf-container `activeWork` liveness semantics were not changed.
- Kept raw ACP tool inputs/outputs out of VM activity reports; only normalized runtime-work state/count/source/progress crosses the control-plane boundary.

## Implementation checklist

- [x] Add failing Go tests for ACP `ToolCall` / `ToolCallUpdate` lifecycle detection: pending/in-progress/content-only starts or renews work, completed/failed ends it, wrong-session/replay updates are ignored, and raw tool input/output is not sent in activity reports.
- [x] Implement a harness-agnostic ACP tool-call adapter in the VM agent that feeds the existing normalized runtime-work state with source `acp_tool_call`, without changing persisted chat-message metadata.
- [x] Preserve the Claude adapter and cf-container `activeWork` semantics unchanged.
- [x] Add `classifySessionIdleness()` as a shared API helper with explicit signal outcomes for prompt activity, VM runtime-work lease, and unknown/inconclusive evidence.
- [x] Convert `checkAutomaticSessionSleepEligibility()` and `sleepWorkspaceSession()` point-of-no-return checks to call `classifySessionIdleness()` instead of local proxy logic.
- [x] Keep non-authoritative readers as deliberate gaps, documented in this task and PR body; do not treat absence of a tool signal as proof of idleness.
- [x] Add deterministic TypeScript tests for lease renewal/expiry/absolute ceiling, prompt activity, both idleness policies, detached server stale progress, sleep/delete/recovery gates, and inconclusive evidence.
- [x] Run focused Go and API tests before broader quality checks.
- [x] Run local specialist review: test-engineer, go-specialist, constitution-validator, cloudflare-specialist, doc-sync-validator, security-auditor, and task-completion-validator.
- [x] Open a draft PR and let CI run.
- [x] Apply PR review feedback (2026-08-24): drop child-task sleep blocking; fix the manual-sleep interval regression; fix the ACP orphaned-tool-call lease leak.

## Acceptance criteria

- [x] Codex/OpenCode ACP tool-call lifecycles can keep an otherwise idle VM session sleep-ineligible while a finite work lease is fresh.
- [x] ACP tool-call work is bounded by the existing sliding lease and absolute ceiling; stale/detached work eventually releases compute.
- [x] Claude `background_tasks_changed` behavior remains covered and unchanged.
- [x] cf-container `activeWork` liveness semantics remain covered and unchanged.
- [x] Sleep eligibility and sleep teardown race gates use the same `classifySessionIdleness()` predicate.
- [x] Child/subtask work does NOT block sleep. An orchestrator whose prompt turn ended sleeps and is woken durably by the ProjectData parent-wake delivery path (Raphaël, 2026-08-24).
- [x] An explicit user-initiated sleep is never rejected because the automatic idle interval has not elapsed.
- [x] An ACP tool call that never reports a terminal status cannot pin the session past one finite settling lease.
- [x] Sleep/delete/recovery protections from PR #1844 still pass.
- [x] Deterministic local tests cover in-flight tools, both idleness policies, lease renewal/expiry/ceiling, turn-end reconciliation, detached servers, sleep/delete/recovery, and inconclusive evidence.
- [ ] Draft PR reports exact SHA/PR, converted readers, deliberate gaps, tests/CI, rollback, and a staging plan using `GET /api/admin/tasks/:taskId/reconciliation-diagnostics` with `eligible=true` assertions across prompt/tool/subtask/sleep chain.

## Validation

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/session-idleness.test.ts tests/unit/services/session-sleep.test.ts` — 45 tests passed.
- `pnpm --filter @simple-agent-manager/api test` — 580 files / 7,851 tests passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `PATH=<task-local-go>/bin:$PATH go test ./internal/acp -run 'Test(ACPToolCallLifecycle|ACPToolCallsDoNotOverrideClaudeLifecycleSource|ACPToolCallActivityReportsOnlyNormalizedState|ClaudeHarnessLifecycle|HarnessActivityReportsOnlyNormalizedState|HarnessActivityStopsWhenCrashRestartFailsBeforeAttach)' -count=1` — passed.
- `PATH=<task-local-go>/bin:$PATH go test ./...` in `packages/vm-agent` — passed.
- `pnpm format:check` — passed.
- `pnpm lint` — passed with existing `acp-client` and `apps/web` warnings only.
- `pnpm typecheck` — passed with the documented Astro template-validation baseline.

## Deliberate gaps after this slice

- ProjectData idle cleanup and workspace idle-timeout candidate selectors are not yet converted to `classifySessionIdleness()`. They still use schedule/workspace-activity candidate selection plus `classifyTaskRuntimeLiveness()` before terminalization. Converting them needs a separate ACP-session activity mirror resolution and ProjectData wait-subscription adapter.
- ACP terminal methods remain stubbed; this slice intentionally only consumes ACP `tool_call` / `tool_call_update`.

## Specialist review notes

- `test-engineer`: deterministic coverage includes ACP in-flight/terminal transitions, replay/wrong-session suppression, raw payload minimization, shared predicate cases for both policies, turn-end reconciliation across completion/cancel/error, lease expiry/ceiling, stale detached work, sleep gate races, inconclusive evidence, full API suite, and full VM-agent Go suite.
- `go-specialist`: ACP lifecycle handling stays on the existing notification path, uses the lock-free session mirror before taking `harnessWorkMu`, avoids `h.mu`, coalesces activity reports via the existing nudge path, and preserves Claude source exclusivity.
- `constitution-validator`: no new environment variables; existing lease/ceiling defaults remain configurable by `HARNESS_BACKGROUND_WORK_*`.
- `cloudflare-specialist`: no new D1 reads. The child-task query from the first cut was removed on review, so sleep eligibility costs the same round trips as before this PR.
- `doc-sync-validator`: no public env/config docs need updates because no env/schema/API contract changed. The task file and PR body carry the implementation/gap documentation.
- `security-auditor`: raw ACP tool input/output is not persisted or sent in activity callbacks; tests assert activity reports omit secret marker content and tool IDs. D1 SQL uses bound parameters.
- `task-completion-validator`: implementation matches the active task checklist except deliberate gaps explicitly retained for ProjectData cleanup selectors and direct wait-subscription adapter wiring.

## Deliberate non-goals for this slice

- Implementing ACP terminal methods (`CreateTerminal`, `TerminalOutput`, `WaitForTerminalExit`).
- Deleting all older idle proxies (`workspace_activity`, `chat_sessions.updated_at`, terminal keepalive) before authoritative replacement coverage exists.
- Deploying or mutating staging before the parent grants the single staging slot.
- Merging the PR.
