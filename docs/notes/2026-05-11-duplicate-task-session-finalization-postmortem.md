# Post-Mortem: Duplicate Task Chat Sessions During Dispatch

## What Broke

Production showed one canonical D1 task with multiple ProjectData chat sessions linked to the same task. The real session had a workspace and normal messages. The duplicate sessions had no workspace, one initial message, and remained active, so the UI could show stale task/chat state long after the task had moved on.

## Root Cause

`ProjectOrchestrator` created the ProjectData chat session before it atomically claimed the D1 task for dispatch. While the task remained schedulable, repeated alarm cycles could create another chat session every cycle. `TaskRunner` starts were keyed by task ID and idempotent, so duplicate starts became no-ops, but the already-created ProjectData sessions were left behind.

Terminal lifecycle cleanup was also split across several call sites. Some paths updated D1 task state, some stopped a workspace-linked session, and some relied on delayed cleanup or sweeps. That made ProjectData session state a repair concern instead of a normal terminal fan-out step.

## Timeline

- **2026-05-11**: Production incident observed for task `01KRB7ZM0N4WGQRE52QM7D8JHV`.
- **2026-05-11**: Investigation found one legitimate session and five active orphan sessions created roughly every 31 seconds while the task was queued.
- **2026-05-11**: Fix implemented to claim the D1 task before creating ProjectData session state and to route terminal task fan-out through a shared finalization path.

## Why It Wasn't Caught

1. The scheduler test coverage did not exercise multiple scheduling cycles against the same schedulable task.
2. TaskRunner idempotency was tested as a local safety property, but not together with the upstream session-creation side effect.
3. Terminal task handling was spread across routes and Durable Objects, so no single test asserted that terminal task state stops all active ProjectData sessions linked to that task.
4. Cleanup sweeps masked the missing event-driven finalization path by eventually repairing some stale state.

## Class of Bug

Cross-store lifecycle ordering bug: durable state was created in one store before the canonical D1 lifecycle claim succeeded, and terminal state changes did not fan out through one consistent event-driven path.

## Process Fix

Lifecycle code that creates cross-store state must first claim the canonical owner row with an atomic conditional write. Terminal task transitions must synchronously enqueue or invoke the normal finalization side effects before accepting terminal state; sweeps should only repair missed events. Regression tests must run at least two scheduler/lifecycle cycles and assert both the canonical row state and the external side effect count.

## Fix

The scheduler now atomically moves schedulable queued tasks to `delegated` before creating a ProjectData chat session or starting TaskRunner. Terminal task paths call a shared finalization helper that stops all active ProjectData sessions for the task, while completed callback/status paths also request workspace cleanup. Focused tests cover repeated scheduler cycles, duplicate TaskRunner starts, terminal finalization, and ProjectData orphan-session repair.
