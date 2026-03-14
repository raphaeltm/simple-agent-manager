# API Contracts: 029-conversation-forking

## New Endpoints

### POST `/api/projects/:projectId/sessions/:sessionId/summarize`

Generate a context summary from a session's message history.

**Auth**: Requires authenticated user who owns the project.

**Request**: No body required.

**Response** (200):
```json
{
  "summary": "## Previous Task Context\n- **Task**: Fix login timeout...\n- **Branch**: sam/fix-login-timeout\n...",
  "messageCount": 87,
  "filteredCount": 42,
  "method": "ai" | "heuristic" | "verbatim"
}
```

**Errors**:
- `404`: Session not found
- `400`: Session has no messages

**Notes**:
- `method` indicates how the summary was generated:
  - `verbatim`: ≤5 filtered messages, included as-is
  - `ai`: Workers AI generated the summary
  - `heuristic`: AI failed/timed out, fell back to concatenation

---

## Modified Endpoints

### POST `/api/projects/:projectId/tasks/submit`

**Added fields** to `SubmitTaskRequest`:

```typescript
{
  message: string;              // Required: new task instruction
  agentType?: string;           // Optional: agent type
  parentTaskId?: string;        // NEW: ID of parent task to continue from
  contextSummary?: string;      // NEW: context from parent session (max 64KB)
}
```

**Behavior when `parentTaskId` is provided**:
1. Fetch parent task from D1, verify it belongs to the same project
2. If parent has `outputBranch`, pass it as the branch for workspace creation
3. If `contextSummary` is provided, persist it as a system message in the new chat session before the user's message
4. Set `parentTaskId` on the new task record

**Errors**:
- `404`: Parent task not found
- `400`: Parent task belongs to a different project
- `400`: `contextSummary` exceeds 64KB

---

## Existing Endpoints (No Changes)

### POST `/api/projects/:projectId/acp-sessions/:sessionId/fork`

Already handles fork lineage. No modifications needed.

### GET `/api/projects/:projectId/acp-sessions/:sessionId/lineage`

Already returns fork ancestry tree. No modifications needed.

### GET `/api/projects/:projectId/sessions/:sessionId`

Already returns session with messages. No modifications needed for the fork flow.
