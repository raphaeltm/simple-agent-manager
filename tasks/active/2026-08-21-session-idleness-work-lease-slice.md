# Session idleness + work lease slice

**SAM task**: `01M0HC5AEWPJJY2356FW3WPB6G`
**Branch**: `sam/implement-next-independently-shippable-3wpb6g`
**Status**: active

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
- Current ProjectData `task_wait_subscriptions` and D1 task parentage are authoritative child/subtask signals. Absence of a task-wait or child-task query must not be interpreted as idle. This slice should include the signal shape in `classifySessionIdleness`; readers can pass `unknown` until an adapter has authoritative coverage.
- Current DO idle cleanup and workspace idle timeout paths already route terminalization through `classifyTaskRuntimeLiveness()`, but their candidate selection still uses older schedule/activity proxies. Converting those selectors in this slice would widen control-loop scope and requires more adapter work; keep them as deliberate gaps unless directly covered by new authoritative idleness signals.
- Rule 53 forbids liveness/heartbeat timestamps as idleness predicates. Rule 47 requires finite leases, absolute ceilings, and control-loop escape paths. Rule 35 requires vertical-slice tests for cross-boundary flows. Rule 58 protects sleep/delete/recovery from conclusive-death drift.

## Implementation checklist

- [ ] Add failing Go tests for ACP `ToolCall` / `ToolCallUpdate` lifecycle detection: pending/in-progress starts work, completed/failed/cancelled ends it, duplicate/late updates are ordered, and raw tool input/output is not sent in activity reports.
- [ ] Implement a harness-agnostic ACP tool-call adapter in the VM agent that feeds the existing normalized runtime-work state with source `acp_tool_call`, without changing persisted chat-message metadata.
- [ ] Preserve the Claude adapter and cf-container `activeWork` semantics unchanged.
- [ ] Add `classifySessionIdleness()` as a shared API helper with explicit signal outcomes for prompt activity, VM runtime-work lease, child/subtask work, and unknown/inconclusive evidence.
- [ ] Convert `checkAutomaticSessionSleepEligibility()` and `sleepWorkspaceSession()` point-of-no-return checks to call `classifySessionIdleness()` instead of local proxy logic.
- [ ] Keep non-authoritative readers as deliberate gaps, documented in this task and PR body; do not treat absence of a child/tool signal as proof of idleness.
- [ ] Add deterministic TypeScript tests for lease renewal/expiry/absolute ceiling, prompt activity, child-task/wait signals, detached server stale progress, sleep/delete/recovery resumability, and inconclusive evidence.
- [ ] Run focused Go and API tests before broader quality checks.
- [ ] Run local specialist review: test-engineer, go-specialist, constitution-validator, cloudflare-specialist, doc-sync-validator, security-auditor, and task-completion-validator.
- [ ] Open a draft PR, let CI run, and stop before staging/merge.

## Acceptance criteria

- [ ] Codex/OpenCode ACP tool-call lifecycles can keep an otherwise idle VM session sleep-ineligible while a finite work lease is fresh.
- [ ] ACP tool-call work is bounded by the existing sliding lease and absolute ceiling; stale/detached work eventually releases compute.
- [ ] Claude `background_tasks_changed` behavior remains covered and unchanged.
- [ ] cf-container `activeWork` liveness semantics remain covered and unchanged.
- [ ] Sleep eligibility and sleep teardown race gates use the same `classifySessionIdleness()` predicate.
- [ ] Child/subtask work and durable waits are represented as explicit non-idle or inconclusive signals; missing evidence is not interpreted as idle.
- [ ] Sleep/delete/recovery protections from PR #1844 still pass.
- [ ] Deterministic local tests cover in-flight tools, child tasks, lease renewal/expiry/ceiling, detached servers, sleep/delete/recovery, and inconclusive evidence.
- [ ] Draft PR reports exact SHA/PR, converted readers, deliberate gaps, tests/CI, rollback, and a staging plan using `GET /api/admin/tasks/:taskId/reconciliation-diagnostics` with `eligible=true` assertions across prompt/tool/subtask/sleep chain.

## Deliberate non-goals for this slice

- Implementing ACP terminal methods (`CreateTerminal`, `TerminalOutput`, `WaitForTerminalExit`).
- Deleting all older idle proxies (`workspace_activity`, `chat_sessions.updated_at`, terminal keepalive) before authoritative replacement coverage exists.
- Deploying or mutating staging before the parent grants the single staging slot.
- Merging the PR.

