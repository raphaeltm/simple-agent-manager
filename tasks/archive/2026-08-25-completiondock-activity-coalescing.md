# Fix CompletionDock activity twitch from ACP harness reports

## Problem

After PR #1874 unified ACP tool-call lifecycle tracking, the VM agent began reporting activity on every ACP `session/update` notification with a tool-call edge. Busy Codex turns can emit dozens of edges. Because those reports are fired from independent goroutines and read the mirrored host status at send time, stale `prompting` reports can arrive after authoritative `idle` reports at turn boundaries. The control plane persists `activity` with last-write-wins semantics, and the web client then verifies stale working activity and keeps the CompletionDock in the wrong morph until stale healing.

The visible failure is a twitchy CompletionDock center button: Stop/Interrupt and Sleep flip rapidly, and Stop can be absent or stale when the agent is actually working.

## Research findings

- `packages/vm-agent/internal/acp/session_host_client.go:SessionUpdate` calls `nudgeHarnessActivityReport()` for every normalized ACP tool-call edge.
- `packages/vm-agent/internal/acp/session_host_harness_work.go:nudgeHarnessActivityReport()` currently single-flights only a same-instant goroutine handoff, so high-frequency edges still produce repeated HTTP callbacks.
- `packages/vm-agent/internal/acp/session_host_reporting.go:reportActivity()` snapshots status metadata and launches an independent goroutine per report. There is no ordering guarantee across concurrent POSTs.
- `packages/vm-agent/internal/acp/session_host_prompt.go:markPromptStarted()` and `markPromptDone()` are authoritative turn-level transitions and should remain immediate.
- Activity reports also carry normalized `runtimeWork*` fields. The coalescer must reduce user-visible activity churn without suppressing real runtime-work lease state changes.
- `apps/api/src/routes/projects/agent-activity-callback.ts` cancels sleep on `prompting` and on `idle` reports with active/settling runtime work; changing the VM-agent report cadence must preserve this contract.
- `apps/web/src/components/project-message-view/index.tsx` passes `working={lc.agentActivity !== 'idle'}` into `CompletionDock`; a client-side working→idle stabilization can hide residual message-batch races without changing the dock animation.
- Existing tests cover prompt re-report stopping, terminal retry budgets, activity payload contract fixtures, harness-work normalization, and CompletionDock behavior. New tests should extend those patterns rather than source-grep assertions.

## Implementation checklist

- [x] Add a debounced, coalescing harness activity reporter in the VM agent.
- [x] Ensure harness-originated reporting reads current mirrored status only when the debounce fires.
- [x] Ensure only one harness-originated activity POST is in flight at a time.
- [x] Track successful activity report snapshots so redundant coalesced reports are skipped while runtime-work state changes still propagate.
- [x] Keep `markPromptStarted()` / `markPromptDone()` immediate and ensure successful authoritative reports update the coalescer's last-success state.
- [x] Keep the 60s harness work re-report loop as the reliability backstop.
- [x] Add a configurable VM-agent debounce interval with a default in the requested 500ms–1s range.
- [x] Add Go regression tests for burst coalescing, stale prompting suppression after prompt done, successful-report dedupe, retry/no-success behavior, and runtime-work payload preservation.
- [x] Add a client-side stabilized CompletionDock working signal that delays only working→idle propagation.
- [x] Ensure idle→working remains immediate so Stop/Interrupt appears immediately.
- [x] Add web unit tests for working→idle stabilization and reversal swallowing.
- [x] Run the required local quality checks and Playwright visual audit for the changed chat UI surface.
- [x] Run specialist reviews: task-completion-validator, go-specialist, ui-ux-specialist, test-engineer, constitution-validator, and env-validator.
- [x] Deploy to staging, verify the live app, and provision a VM to verify vm-agent heartbeat/workspace access because `packages/vm-agent` changes.
- [x] Add the process fix to repository agent guidance.

## Acceptance criteria

- ACP tool-call edge bursts no longer produce one activity HTTP POST per edge.
- A late harness report cannot overwrite an authoritative prompt-done idle transition with stale prompting.
- Prompt start and prompt done activity transitions remain immediate.
- Lost changed-value harness reports self-heal through the existing periodic re-report loop.
- Runtime-work `active` / `settling` reports still reach the control plane when they are semantically new.
- CompletionDock shows Interrupt immediately when activity becomes working.
- CompletionDock does not flip to idle/Sleep for transient idle signals that reverse within the stabilization window.
- Existing CompletionDock visuals/animation timing are unchanged.
- Regression tests prove the race and stabilization behavior.

## Post-mortem

### What broke

The CompletionDock lifecycle control flipped between Interrupt and Sleep and sometimes showed the wrong control because VM-agent activity reports arrived unordered and too frequently.

### Root cause

PR #1874 introduced per-edge ACP tool-call lifecycle reporting. The report path launched independent goroutines that read host status at send time and posted last-write-wins `activity` values to the control plane. At prompt boundaries, those goroutines could race with authoritative prompt-start/prompt-done reports.

### Timeline

- PR #1874 (`85d69a89b`) added ACP tool-call lifecycle reporting.
- PR #1881 made the CompletionDock morph directly reflect `agentActivity`, making the existing activity churn visible as button twitch.
- The issue was diagnosed on 2026-08-25 and fixed in this task.

### Why it was not caught

Existing tests proved harness lifecycle normalization and deadlock avoidance, but they did not assert report cadence, single-flight HTTP ordering, or UI stabilization across rapid working↔idle reversals.

### Class of bug

High-frequency runtime lifecycle signals converted directly into unordered cross-service writes and user-visible state, without a coalescing/order boundary.

### Process fix

Update VM-agent guidance so high-frequency callback streams must be debounced/coalesced, single-flight, and regression-tested for ordering/cadence before they can mutate control-plane state.

## Staging verification

- Staging deployment run: `32838455761` — deploy and GitHub smoke-tests jobs passed.
- Fresh staging VM run:
  - Task: `01M0W9A19ZKHNRTED6QKGGBYW1`
  - Chat session: `f719fc22-dbe1-4d97-a852-292fef0a3ee0`
  - Node: `01M0W9A6P4GC57Z33PBN6SZYE7`
  - Workspace: `01M0W9KMAKSADEY31MM4BG8XN6`
  - ACP session: `01M0W9MVKG17N9RPWWYDHN3Z7V`
- VM-agent system info on the fresh node reported branch build `a7b661f70f619d613b22bc6f32fca51b05aeb261` and Go `1.26.6`.
- During active Codex runtime work, session state reported `activity=prompting`, `runtimeWorkState=active`, and `runtimeWorkCount=1`; the live UI exposed the CompletionDock `Interrupt agent` control.
- After the prompt completed, state reported `activity=idle`, `runtimeWorkState=inactive`, and `runtimeWorkCount=0`; the live UI stabilized to `Sleep session`.
- No browser console errors were observed during the live UI check.
- Cleanup completed: `POST /sessions/:sessionId/stop` returned `workspaceDeleted=true`, and final staging `/api/nodes` plus `/api/workspaces` were both `[]`.
