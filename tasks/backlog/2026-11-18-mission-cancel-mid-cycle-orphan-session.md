# Mission cancellation during a scheduler cycle leaves an empty active chat session

## Problem

When a mission is cancelled while the ProjectOrchestrator scheduling cycle is creating the chat
session for a task (`autoDispatchSchedulableTasks`,
`apps/api/src/durable-objects/project-orchestrator/auto-dispatch.ts`), the cycle sees the
cancelling marker and returns before claiming the task. The task is correctly cancelled and no
TaskRunner starts, but the chat session the cycle already created stays `active` with no task
bound to it and no agent. It shows as an idle session in the project chat list.

## Context

Found 2026-11-18 by SAM task `01M7PX499FF397BR3VWYTD3HQT` while confirming Codex Security PR
#2868 against main. The draft's race test `cancellation wins while an in-flight cycle is creating
its dispatch session` (adapted to main's serialized cancellation: cancel issued without awaiting,
cycle released, then cancel awaited) passed its security assertions on main (task `cancelled`,
`scheduler_state='cancelled'`, `chat_session_id` NULL, no TaskRunner) and failed only on
`getSession(...).status` being `active` instead of `stopped`. Not a security issue.

## Acceptance Criteria

- [ ] An early return after `createSession` in the dispatch cycle stops the session it created
- [ ] A worker test holds the cycle inside `createSession`, cancels the mission, releases the
      cycle, and asserts the session is `stopped` while the task is cancelled with no runner
- [ ] When `persistMessage` rejects after `createSession`, the dispatch cycle's `catch`
      (`auto-dispatch.ts`) also stops the session it created; a worker test rejects
      `persistMessage` after `createSession` and asserts the session is `stopped`, with or without
      cancellation
- [ ] Control: an uncancelled cycle still binds the session and starts the runner
