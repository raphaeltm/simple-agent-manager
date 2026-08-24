---
name: workflow
description: 'Orchestrate multi-step workflows by decomposing and dispatching subtasks, then waiting through SAM durable parent wake delivery. Use when coordinating multiple agents or multi-phase work.'
---

# Workflow Orchestrator

Read the full workflow from `.claude/commands/workflow.md` and execute it.

## Quick Summary

1. **Decompose** — break the user's request into discrete subtasks with dependencies
2. **Dispatch** — send subtasks to other agents via `dispatch_task` (with `/do` instructions)
3. **Wait** — persist state and a stable workflow-step `waitKey`, register `wait_for_subtasks`, and end the turn
4. **React** — dispatch dependent tasks as predecessors complete, retry failures
5. **Complete** — summarize results when all subtasks finish

## Why This Exists

SAM owns durable child-task status and can wake a sleeping parent exactly once when a registered wait resolves. The orchestrator therefore releases its prompt turn instead of maintaining an expensive foreground poller. Bounded foreground polling is a compatibility fallback only when the connected server does not advertise `wait_for_subtasks` or reports that durable wake delivery is disabled.

## State Persistence

Maintain `.workflow-state.md` (gitignored) as external memory. Write it before registering a wait and re-read it whenever SAM wakes the session. This survives sleep, recovery, and context compaction. See `.claude/commands/workflow.md` for the full state file format.
