# ACP Subagent Idle Detection Fix

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** a harness work lease keeps the session awake while Claude background tasks run
>   (PR #1845; `packages/vm-agent/internal/acp/session_host_harness_work.go`,
>   `apps/api/src/services/session-idleness.ts`). It is configurable
>   (`HARNESS_BACKGROUND_WORK_LEASE_MS`, `HARNESS_BACKGROUND_WORK_MAX_DURATION_MS`,
>   `apps/api/src/env.ts:275-276`) and capped by default at 30 minutes after the last progress, so
>   runaway work cannot keep a session awake forever. ACP tool-call work is covered too (PR #1874).
> - **Still open:**
>   - A UI indicator for background work: `runtimeWorkState` exists only as a type
>     (`apps/web/src/lib/api/sessions.ts:119`) and is never rendered.
>   - Confirm on staging that subagent output arrives without a manual "?". The Claude SDK now runs
>     its own completion turn after a task notification, tracked as "settling"
>     (`session_host_harness_work.go:255-275`); this has not been checked end to end.
>   - Other agents: lifecycle tracking is Claude-only (`session_host_harness_work.go:63-66`).
> - **Moot/dropped:** the proposed `HostWaitingForSubagents` state and process-tree detection; the
>   lease design replaced them.

## Problem

When Claude Code dispatches subagents (via the `Agent` tool), the ACP SDK interprets this as a turn completion — `Prompt()` returns, the session transitions to `HostReady`, and the system thinks Claude Code is waiting for user input. Meanwhile, subagents run in the background producing output that gets queued but never flows back through ACP because no active prompt exists.

This causes two failures:
1. **Idle detection fires prematurely** — the session is in `HostReady` with no new messages, so the 15-minute cleanup timer expires and the workspace is destroyed while agents are still working.
2. **Message backlog** — subagent results accumulate but aren't delivered. Users must manually send "?" to trigger a new `Prompt()` call that flushes the backlog.

### Evidence

On 2026-03-17, three concurrent task agents all went silent while waiting for review subagents or CI. Their workspaces were destroyed by idle detection despite actively running subagent processes. Tasks `01KKYKFANTKTMRTFPAVJNXV5FM`, `01KKYKAWBGV6T7KSS7DH52WEKS`, `01KKYJMWWH90CAYVCJMTVHBBRV`.

## Proposed Approach

Combination of a new session state + auto-nudge mechanism:

### 1. `HostWaitingForSubagents` state
When `Prompt()` returns with `end_turn` but the Claude Code process still has active child processes, enter `HostWaitingForSubagents` instead of `HostReady`. This state:
- Suppresses idle detection timers
- Shows "agent working (background)" in the UI
- Periodically checks if the process tree is still active

### 2. Auto-nudge
After a configurable interval (`ACP_SUBAGENT_NUDGE_INTERVAL_MS`, default e.g. 60s), automatically send a lightweight prompt (empty message or "?") to flush any accumulated output. This mirrors the manual workaround users currently perform.

### 3. Process tree detection
The vm-agent checks if the Claude Code process has spawned child processes (subagents are real OS processes). This is more targeted than CPU monitoring — it checks the process tree, not raw resource usage.

### Alternative/complementary: Notification-based detection
If the ACP SDK sends `SessionUpdate` notifications while subagents run (even after `Prompt()` returns), treat those as proof-of-life signals and reset idle timers in the `orderedPipe` path.

## Key Files

- `packages/vm-agent/internal/acp/session_host.go` — Turn lifecycle, `HandlePrompt()`, `HostReady`/`HostPrompting` states
- `packages/vm-agent/internal/acp/gateway.go` — WebSocket message routing, idle suspend timeout
- `packages/vm-agent/internal/acp/ordered_reader.go` — Notification serialization
- `apps/api/src/durable-objects/project-data.ts` — Session idle cleanup, workspace idle detection
- `packages/shared/src/constants.ts` — Timeout configuration constants

## Configuration

- `ACP_SUBAGENT_NUDGE_INTERVAL_MS` — How often to auto-nudge during suspected subagent execution (default: 60000)
- `ACP_SUBAGENT_DETECTION_GRACE_MS` — How long after `Prompt()` returns to wait before checking for child processes (default: 5000)

## Acceptance Criteria

- [ ] When Claude Code dispatches subagents, idle detection does not fire while subagents are running
- [ ] Subagent output is delivered to viewers without requiring manual "?" nudges
- [ ] UI shows appropriate status (e.g., "agent working in background") during subagent execution
- [ ] Configurable via environment variables with sensible defaults
- [ ] Runaway/stuck subagents don't prevent idle cleanup indefinitely (max timeout)
- [ ] Existing non-subagent idle detection behavior is unchanged
