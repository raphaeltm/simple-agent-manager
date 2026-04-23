# Postmortem: Idle Cleanup Could Stop A Chat Session While Fresh Agent Output Was Still Arriving

Date: 2026-04-22

## Summary

A chat session could be auto-stopped by the ProjectData idle-cleanup timer even though the VM agent was still persisting fresh assistant messages. Once that happened, the workspace-side message reporter hit permanent `400` responses and discarded those messages, so the UI could briefly show live agent output and then fall back to older durable history after a refresh.

## Impact

- Fresh assistant replies could disappear from persisted chat history.
- The VM agent deleted message outbox rows after the control plane returned permanent client errors.
- A workspace could remain running while its linked chat session had already been stopped, creating inconsistent live-vs-persisted chat state.

## Root Cause

The system armed idle cleanup when a task entered `awaiting_followup`, but the server did not extend that cleanup deadline when later messages were actually persisted.

Before the fix:

- Idle cleanup was scheduled from [tasks/crud.ts](/workspaces/simple-agent-manager/apps/api/src/routes/tasks/crud.ts:535)
- The browser could explicitly reset the deadline via [chat.ts](/workspaces/simple-agent-manager/apps/api/src/routes/chat.ts:223)
- But ProjectData persistence did **not** extend the deadline inside [project-data/index.ts](/workspaces/simple-agent-manager/apps/api/src/durable-objects/project-data/index.ts:92) or [project-data/index.ts](/workspaces/simple-agent-manager/apps/api/src/durable-objects/project-data/index.ts:108)
- Once the session was stopped, [messages.ts](/workspaces/simple-agent-manager/apps/api/src/durable-objects/project-data/messages.ts:125) rejected further batch writes
- The API surfaced that as a permanent `400` from [runtime.ts](/workspaces/simple-agent-manager/apps/api/src/routes/workspaces/runtime.ts:592)

This made session liveness depend too heavily on the browser calling `idle-reset` at the right time, instead of on authoritative persisted activity.

## Trigger Conditions

The regression required:

- A session with an active idle-cleanup schedule
- Later agent output reaching the ProjectData persistence path
- No server-side extension of the cleanup deadline before it expired

At that point the session could be stopped even though fresh output was still in flight.

## Fix

The ProjectData DO now extends any existing idle-cleanup schedule whenever it successfully persists messages through:

- `persistMessage()`
- `persistMessageBatch()`

Updated code:

- [project-data/index.ts](/workspaces/simple-agent-manager/apps/api/src/durable-objects/project-data/index.ts:92)
- [project-data/index.ts](/workspaces/simple-agent-manager/apps/api/src/durable-objects/project-data/index.ts:108)

Regression coverage:

- [project-data-do.test.ts](/workspaces/simple-agent-manager/apps/api/tests/workers/project-data-do.test.ts:1245)

## Prevention

- Server-side lifecycle timers must be refreshed from authoritative persisted activity.
- Client-side timer resets should be treated as hints, not correctness boundaries.
- Idle-cleanup changes must include a regression test proving that fresh persisted output extends the cleanup deadline.
