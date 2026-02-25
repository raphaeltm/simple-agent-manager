# Contract: Task Submit (Single-Action)

**Endpoint**: `POST /api/projects/:projectId/tasks/submit`
**Purpose**: Single-action task submission from chat UI. Combines task creation, branch name generation, chat session creation, first message recording, and task run initiation into one atomic operation.
**Research Reference**: R1 (Single-Action Submit), R6 (Branch Name Generation)

## Request

### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | string | Yes | Project ULID |

### Headers

- `Cookie`: Session cookie (standard BetterAuth session auth)

### Body

```json
{
  "message": "Add input validation to the signup form",
  "vmSize": "medium",
  "vmLocation": "nbg1",
  "nodeId": "01JK9M2..."
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `message` | string | Yes | — | User's task description. Becomes task title AND first chat message. Min 1 char, max 2000 chars. |
| `vmSize` | `'small' \| 'medium' \| 'large'` | No | Project default or platform default | VM size override for this task |
| `vmLocation` | string | No | `'nbg1'` | Hetzner datacenter location |
| `nodeId` | string | No | — | Force execution on a specific node (must be running and owned by user) |

## Response

### 202 Accepted

```json
{
  "taskId": "01JK9M2X4NABCDEF12345678",
  "sessionId": "sess_01JK9M2X4N...",
  "branchName": "sam/add-input-validation-01jk9m",
  "status": "queued"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | string | ULID of the created task |
| `sessionId` | string | ID of the created chat session (in ProjectData DO) |
| `branchName` | string | Generated branch name (stored as `outputBranch` on task) |
| `status` | string | Always `'queued'` — execution starts asynchronously |

### Error Responses

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_MESSAGE` | Message is empty or exceeds 2000 chars |
| 400 | `INVALID_VM_SIZE` | vmSize not in allowed values |
| 403 | `NO_CLOUD_CREDENTIALS` | User has no Hetzner credentials configured |
| 403 | `NO_GITHUB_INSTALLATION` | Project's repo has no GitHub App installation |
| 404 | `PROJECT_NOT_FOUND` | Project doesn't exist or user doesn't own it |
| 404 | `NODE_NOT_FOUND` | Specified nodeId doesn't exist or isn't running |
| 429 | `TASK_LIMIT_EXCEEDED` | User has hit max concurrent tasks |

## Server-Side Logic

### Sequence

```
1. Validate request (auth, project ownership, credentials)
2. Generate branch name from message (R6 algorithm)
3. Insert task record:
     - status: 'queued'
     - title: message (truncated to 200 chars for display)
     - description: message (full text)
     - outputBranch: generated branch name
     - executionStep: 'node_selection'
4. Record status event: null → 'queued' (actorType: 'user')
5. Create chat session in ProjectData DO:
     - Link to task via taskId
     - Topic: task title
6. Record first message in chat session:
     - role: 'user'
     - content: message
7. Return 202 immediately
8. via waitUntil: executeTaskRun(task, vmSize, vmLocation, nodeId)
```

### Branch Name Generation (R6)

```
Input:  "Add dark mode toggle to settings"
Output: "sam/add-dark-mode-toggle-01jk9m"

Algorithm:
  1. Lowercase the message
  2. Remove non-alphanumeric characters (keep spaces, hyphens)
  3. Split into words
  4. Filter stop words (a, an, the, to, for, in, on, of, is, it, etc.)
  5. Take first 4 meaningful words
  6. Join with hyphens
  7. Append '-' + first 6 chars of task ULID (lowercase)
  8. Prefix with BRANCH_NAME_PREFIX (default: 'sam/')
  9. Truncate to BRANCH_NAME_MAX_LENGTH (default: 60)
  10. Ensure valid git ref name (no consecutive dots, no trailing dot/slash)
```

### Key Differences from Existing Task Creation

| Aspect | Existing (3-call) | New (submit) |
|--------|-------------------|--------------|
| Calls | POST /tasks → POST /tasks/:id/status → POST /tasks/:id/run | POST /tasks/submit |
| Initial status | draft | queued |
| Branch name | Set during workspace creation as `task/{taskId}` | Set at creation from message content |
| Chat session | Created during workspace creation (step 3) | Created immediately at submit time |
| First message | None recorded | User's message recorded |
| Credential validation | Checked at /run | Checked at submit |

## Notes

- The existing 3-call task creation flow (tasks + status + run) remains available for programmatic/advanced usage. This endpoint is the simplified path for the chat UI.
- The submit endpoint DOES NOT wait for task execution. It returns as soon as the task is queued. The frontend uses WebSocket/polling to track progress.
- If chat session creation fails (DO unavailable), the task still runs. Session creation is best-effort with retry.
