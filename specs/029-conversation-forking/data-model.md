# Data Model: 029-conversation-forking

## Entities

### Context Summary (New Value Object)

A structured text output from the summarization service, not stored as a separate entity. It flows through the system as a string.

**Attributes**:
- Content: string (max 64KB, matches existing `contextSummary` API limit)
- Generated via AI or heuristic fallback
- Contains: original task description, files mentioned, decisions made, current state, branch name

**Lifecycle**: Created on-demand when user requests a fork. Stored as `initial_prompt` on the new ACP session.

### Summarization Configuration (New Constants)

All values configurable via environment variables with defaults in `packages/shared/src/constants.ts`.

| Constant | Default | Env Var | Description |
|----------|---------|---------|-------------|
| `DEFAULT_CONTEXT_SUMMARY_MODEL` | `@cf/meta/llama-3.1-8b-instruct` | `CONTEXT_SUMMARY_MODEL` | Workers AI model |
| `DEFAULT_CONTEXT_SUMMARY_MAX_LENGTH` | `4000` | `CONTEXT_SUMMARY_MAX_LENGTH` | Max output chars |
| `DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS` | `10000` | `CONTEXT_SUMMARY_TIMEOUT_MS` | Per-attempt timeout |
| `DEFAULT_CONTEXT_SUMMARY_MAX_MESSAGES` | `50` | `CONTEXT_SUMMARY_MAX_MESSAGES` | Max messages to process |
| `DEFAULT_CONTEXT_SUMMARY_RECENT_MESSAGES` | `20` | `CONTEXT_SUMMARY_RECENT_MESSAGES` | Recent msgs to always include |
| `DEFAULT_CONTEXT_SUMMARY_SHORT_THRESHOLD` | `5` | `CONTEXT_SUMMARY_SHORT_THRESHOLD` | Below this, skip AI |

## Existing Entities (No Changes Needed)

### Task (D1 — `tasks` table)

Already has all required fields:
- `parentTaskId` — links forked task to parent
- `outputBranch` — branch where agent pushed work
- `outputSummary` — agent-generated summary

### ACP Session (DO SQLite — `acp_sessions` table)

Already has all required fields:
- `parent_session_id` — fork lineage
- `fork_depth` — chain depth limit
- `initial_prompt` — stores context summary

### Chat Message (DO SQLite — `chat_messages` table)

Already has `role` field used for filtering:
- `user`, `assistant` — included in summaries
- `tool`, `system`, `thinking`, `plan` — excluded from summaries

## State Transitions

No new state machines. The fork flow uses existing transitions:

```
Parent Task: completed/failed → (user clicks "Continue")
New Task: → queued → delegated → in_progress → ...
Parent ACP Session: completed/interrupted → fork → New ACP Session: pending → assigned → running → ...
```

## Relationships

```
Parent Task (completed)
  ├── outputBranch: "sam/fix-login-timeout"
  └── Chat Session (stopped)
       └── Messages [user, assistant, tool, system, ...]
            │
            ↓ (summarize: filter user+assistant, chunk, AI/fallback)
            │
       Context Summary (text)
            │
            ↓ (fork)
            │
New Task (queued)
  ├── parentTaskId: parent.id
  ├── outputBranch: "sam/add-tests-01KXYZ" (new branch)
  └── Chat Session (active)
       ├── System Message: context summary
       └── User Message: new instruction
            │
            ↓ (provision workspace on parent's outputBranch)
            │
       Workspace (checks out parent's branch, then creates new branch)
```
