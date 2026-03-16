# Task Mode vs Conversation Mode

**Created**: 2026-03-16
**Context**: Discussion about dispatch_task failing from completed tasks. Root cause: all tasks get "push and complete" instructions regardless of intent. An agent exploring a question calls `complete_task` then can't dispatch follow-up work.

## Problem

Today, every chat submission is treated identically: create a task, provision a workspace, tell the agent to push changes and call `complete_task`. This doesn't match two distinct usage patterns:

1. **Task mode** — "Fix the light mode styles on the website." The agent should do work, push, create a PR, and complete.
2. **Conversation mode** — "What MCP tools do you have?" or "Explore this issue and dispatch tasks for what you find." The agent should respond, stay available for follow-ups, and be able to dispatch work — the *human* decides when the conversation is done.

The current design forces conversation-mode interactions into the task-mode lifecycle, causing:
- Agents prematurely call `complete_task` (because instructions say to)
- `dispatch_task` fails from completed tasks (`ACTIVE_STATUSES` check in `mcp.ts:658-664`)
- Lightweight exploration workspaces can't delegate to full workspaces
- The human loses control of the conversation lifecycle

## Desired Behavior

### Task Mode (current behavior, refined)
- Agent receives instructions to push changes, create PR, call `complete_task`
- Task moves through: `queued` → `in_progress` → `completed`
- Workspace lifecycle tied to task completion + idle timeout
- Good for: bug fixes, feature implementation, `/do` workflows

### Conversation Mode (new)
- Agent receives instructions to respond conversationally, use `dispatch_task` freely, and **not** call `complete_task`
- Task stays `in_progress` while the human is engaged
- After agent responds, task moves to `awaiting_followup` (not `completed`)
- Human sends another message → back to `in_progress`
- Human explicitly closes the conversation, OR idle timeout (configurable, default 15 min via `SESSION_IDLE_TIMEOUT_MINUTES`) eventually cleans up
- Good for: exploration, triage, dispatching work, Q&A

## Design

### 1. Task Mode Selection (UI)

**Where**: `ProjectChat.tsx` submit form, alongside the existing workspace profile selector.

Add a mode toggle or selector with two options:
- **Task** (default for "full" workspace profile) — "Agent will do the work, push changes, and create a PR"
- **Conversation** (default for "lightweight" workspace profile) — "Chat with an agent. You decide when it's done."

The mode could be inferred from workspace profile as a sensible default:
- `workspaceProfile: 'full'` → default to task mode
- `workspaceProfile: 'lightweight'` → default to conversation mode

But the user should be able to override (e.g., a lightweight workspace doing a quick task, or a full workspace for open-ended exploration).

### 2. API Changes

**`SubmitTaskRequest`** (`packages/shared/src/types.ts`): Add field:
```typescript
taskMode?: 'task' | 'conversation'  // default: 'task'
```

**`tasks/submit.ts`**: Persist `taskMode` to D1 task record. Pass through to TaskRunner DO config.

**D1 schema**: Add `task_mode TEXT DEFAULT 'task'` column to tasks table.

### 3. MCP Instruction Differentiation

**`mcp.ts` `get_instructions` handler** (line 433-438): Branch on task mode:

```typescript
// Task mode (current)
instructions: [
  'Call `update_task_status` to report progress as you complete significant milestones.',
  'Call `complete_task` with a summary when all work is done.',
  'Push your changes to the output branch before calling `complete_task`.',
  'If you encounter blockers, report them via `update_task_status` with a clear description.',
]

// Conversation mode (new)
instructions: [
  'You are in a conversation with a human. Respond to their messages directly.',
  'Use `dispatch_task` to spawn follow-up work to other agents when needed.',
  'Use `update_task_status` to report significant findings or progress.',
  'Do NOT call `complete_task` — the human will end the conversation when they are ready.',
  'If you encounter blockers, report them via `update_task_status` with a clear description.',
]
```

### 4. Task State Machine Changes — No New MCP Tools Needed

The key insight: **no new MCP tools are required**. The VM agent's `OnPromptComplete` callback already fires when the agent finishes its turn. The control plane already knows the task mode. All lifecycle decisions can be made programmatically:

**`complete_task` behavior in conversation mode**: Map it to `awaiting_followup` instead of `completed`. If an agent ignores the instructions and calls `complete_task` anyway, the control plane silently treats it as a yield — no breakage, no need for agent cooperation.

**`OnPromptComplete` callback** (`server.go`): Already fires when the agent finishes. In conversation mode, this signals `awaiting_followup` to the control plane (which it already does today). The only behavioral change is: skip auto-PR creation. The control plane already receives the `executionStep=awaiting_followup` signal — it just needs to NOT transition the task to `completed` in conversation mode.

**No `yield_turn` tool**: The agent doesn't need to explicitly yield. The existing `OnPromptComplete` mechanism handles it. The `TASK_MODE` env var on the VM tells the completion callback whether to create a PR or just push.

**Human-initiated completion**: Add a UI action to explicitly end a conversation-mode task. This could be:
- A "Close conversation" button in the chat UI
- Calls a new API endpoint: `POST /api/projects/:projectId/tasks/:taskId/close`
- Moves task to `completed`, triggers idle cleanup

### 5. Conversation Mode Lifecycle

```
Human sends message
  → task created, status='queued'
  → workspace provisioned, agent starts
  → agent responds (task status='in_progress', step='running')
  → agent yields (step='awaiting_followup')
  → human sends follow-up
  → agent resumes (step='running')
  → agent dispatches tasks to other workspaces
  → agent yields again
  → ... repeat as needed ...
  → human clicks "Close conversation" → task='completed'
  OR
  → no activity for SESSION_IDLE_TIMEOUT_MINUTES → auto-cleanup
```

### 6. `dispatch_task` Gating Fix

With conversation mode, the dispatch problem is solved naturally:
- Task stays in `awaiting_followup` (an `ACTIVE_STATUS`) between turns
- Agent can dispatch at any point during the conversation
- No need to add `completed` to `ACTIVE_STATUSES`

### 7. VM Agent Completion Callback — Minimal Change

**`server.go:makeTaskCompletionCallback()`**: Read `TASK_MODE` env var. Branch behavior:

| Action | Task Mode | Conversation Mode |
|--------|-----------|-------------------|
| `git push` | Yes | Yes |
| `gh pr create` | Yes | No (deferred to close/cleanup) |
| Signal to control plane | `executionStep=awaiting_followup` | `executionStep=awaiting_followup` |

The callback behavior is almost identical — the only difference is skipping PR creation. The control plane handles the rest: in task mode, `awaiting_followup` + idle timeout → `completed`. In conversation mode, `awaiting_followup` stays until human closes or idle timeout fires.

`TASK_MODE` is passed through: TaskRunner DO config → workspace creation API → cloud-init template → VM agent systemd env.

## Files Affected

| File | Change |
|------|--------|
| `packages/shared/src/types.ts` | Add `taskMode` to `SubmitTaskRequest`, `Task`, `TaskDetailResponse` |
| `apps/api/src/db/schema.ts` | Add `task_mode` column to tasks table |
| `apps/api/src/db/migrations/` | New migration for `task_mode` column |
| `apps/api/src/routes/tasks/submit.ts` | Accept and persist `taskMode` |
| `apps/api/src/routes/mcp.ts` | Branch `get_instructions` on task mode; remap `complete_task` → `awaiting_followup` in conversation mode |
| `apps/api/src/durable-objects/task-runner.ts` | Pass `taskMode` through config; adjust completion behavior |
| `apps/web/src/pages/ProjectChat.tsx` | Add mode selector to submit form; add "Close conversation" button |
| `packages/cloud-init/src/template.ts` | Pass `TASK_MODE` env var to VM agent |
| `packages/vm-agent/internal/server/server.go` | Read `TASK_MODE`; adjust completion callback behavior |
| `apps/api/src/routes/tasks/crud.ts` | Add `POST /:taskId/close` endpoint for human-initiated completion |

## Acceptance Criteria

- [ ] User can choose task mode or conversation mode when submitting a chat message
- [ ] Workspace profile selection provides sensible defaults (full→task, lightweight→conversation)
- [ ] Task-mode agents receive current "push and complete" instructions
- [ ] Conversation-mode agents receive "respond and yield" instructions (no `complete_task`)
- [ ] Conversation-mode tasks stay in `awaiting_followup` between agent turns (not `completed`)
- [ ] `dispatch_task` works from conversation-mode tasks at any point in the conversation
- [ ] Human can send follow-up messages that re-engage the agent
- [ ] Human can explicitly close a conversation-mode task via UI
- [ ] Idle timeout still cleans up conversation-mode tasks after inactivity
- [ ] Conversation-mode `OnPromptComplete` pushes code but does NOT auto-create PR
- [ ] Task-mode behavior is unchanged (backward compatible)
- [ ] Conversation mode type/field persisted in D1 and visible in task details API

## Design Decisions (Resolved)

1. **Workspace always provisioned** — conversation mode still needs a workspace (agent needs to read code, use tools, dispatch tasks). Lightweight workspace profile is the sensible default.
2. **Mode is explicit, not auto-detected** — the user selects it (with defaults from workspace profile). Auto-detection is a future enhancement.
3. **No new MCP tools** — the existing `OnPromptComplete` callback + control plane `taskMode` field handle all lifecycle transitions programmatically. `complete_task` is silently remapped to `awaiting_followup` in conversation mode. No agent cooperation required.

## Open Questions

1. **What happens to the workspace when a conversation-mode task is awaiting_followup?** The VM stays alive per idle timeout rules (activity-based), but if the human takes 30 minutes between messages, the node warm pool might reclaim it. Need to ensure re-provisioning works smoothly if the workspace is gone.
2. **Should conversation-mode idle timeout be longer than task-mode?** Currently `SESSION_IDLE_TIMEOUT_MINUTES` (15 min) is the same for both. Conversations might benefit from a longer window since the human is expected to come back.
