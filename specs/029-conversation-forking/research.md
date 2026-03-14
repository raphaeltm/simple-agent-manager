# Research: 029-conversation-forking

**Date**: 2026-03-13
**Status**: Complete

## Technical Findings

### 1. Existing Infrastructure (No New Schema Needed)

**Decision**: Reuse existing schema fields — no D1 migrations required.

**Rationale**: The D1 `tasks` table already has:
- `parentTaskId` (text, nullable) — for linking forked tasks to their parent
- `outputBranch` (text, nullable) — for tracking the branch created by a task
- `outputSummary` (text, nullable) — for storing task completion summaries

The ACP sessions table in ProjectData DO already has:
- `parent_session_id` — for fork lineage
- `fork_depth` — for limiting fork chains
- `initial_prompt` — for storing context summary

**Alternatives considered**: Adding a new `context_summary` column to chat_sessions. Rejected because `initial_prompt` on ACP sessions already serves this purpose.

### 2. Message Filtering Approach

**Decision**: Add role-filtering parameter to existing `getMessages()` in ProjectData DO.

**Rationale**: The existing method returns all messages. For summarization, we need only `user` and `assistant` messages. Adding an optional `roles` parameter is minimal and avoids creating a separate method.

**Current signature** (`project-data.ts:475`):
```typescript
async getMessages(sessionId, limit = 1000, before = null)
```

**New signature**:
```typescript
async getMessages(sessionId, limit = 1000, before = null, roles?: string[])
```

### 3. Branch Checkout on Fork

**Decision**: Pass parent task's `outputBranch` as the branch for the new workspace.

**Rationale**: TaskRunner already supports a `branch` config parameter (`task-runner.ts:658-667`). When a task is created with `parentTaskId`, the submit handler can fetch the parent's `outputBranch` and pass it as the branch to check out. This requires adding a branch override to `SubmitTaskRequest`.

**Current flow**: Workspace always checks out the project's default branch.
**New flow**: If `parentTaskId` is set and parent has `outputBranch`, use that branch.

### 4. Workers AI Summarization

**Decision**: Follow the `task-title.ts` pattern with Mastra + workers-ai-provider.

**Rationale**: Proven pattern in the codebase with proper error handling, timeout, retry, and fallback. The same `@cf/meta/llama-3.1-8b-instruct` model is sufficient for conversation summarization.

**Key design choices**:
- System prompt requests structured output (markdown with sections)
- Input: filtered messages (user + assistant only), chunked by session size
- Output: structured summary ≤4000 chars
- Fallback: last 10 messages concatenated with role labels + task metadata
- Short-circuit: ≤5 filtered messages → include verbatim, no AI needed

### 5. UI Integration Point

**Decision**: Add "Continue" button to `SessionItem` component in `ProjectChat.tsx`.

**Rationale**: The session sidebar already shows session status. Adding a button for terminal sessions (stopped, completed) is a natural extension. Clicking opens a dialog with the AI-generated summary in an editable textarea, plus a field for the new task instruction.

**Component location**: `apps/web/src/pages/ProjectChat.tsx:SessionItem` (line ~483)

### 6. API Flow

**Decision**: Two new endpoints + modification to task submit.

1. `POST /api/projects/:id/sessions/:sessionId/summarize` — generates context summary (AI + fallback)
2. Modified `POST /api/projects/:id/tasks/submit` — accepts optional `parentTaskId` and `contextSummary`
3. Existing `POST /api/projects/:id/acp-sessions/:sessionId/fork` — already handles fork lineage

**Flow**:
```
UI: Click "Continue" on stopped session
  → POST /sessions/:id/summarize → returns summary text
UI: Show dialog with editable summary + new instruction field
  → POST /tasks/submit with { message, parentTaskId, contextSummary }
API: Submit handler detects parentTaskId
  → Fetches parent task's outputBranch
  → Creates task with parentTaskId set, branch = parent's outputBranch
  → Creates chat session, persists contextSummary as first system message
  → TaskRunner provisions workspace on the output branch
```
