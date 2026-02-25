# Contract: Enhanced Task Status Callback

**Endpoint**: `POST /api/projects/:projectId/tasks/:taskId/status/callback`
**Purpose**: Extended callback from VM agent to report agent completion with git push results and trigger idle cleanup timer.
**Research Reference**: R2 (Agent Completion Git Push), R3 (Idle Cleanup Timer), R10 (Finalization Guard)

## Changes from Existing

The existing callback endpoint accepts `toStatus` to transition task state. This enhancement adds:

1. New `executionStep` field for signaling agent completion without terminal transition
2. New `gitPushResult` object for reporting git operation outcomes
3. New server-side behavior: starting idle cleanup timer on agent completion

## Request

### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | string | Yes | Project ULID |
| `taskId` | string | Yes | Task ULID |

### Headers

- `Authorization: Bearer <callback-token>` (workspace JWT, verified via `verifyCallbackToken()`)

### Body (Agent Completion Signal)

```json
{
  "executionStep": "awaiting_followup",
  "outputSummary": "Added input validation to signup form with email format check and password strength meter",
  "outputBranch": "sam/add-input-validation-01jk9m",
  "outputPrUrl": "https://github.com/user/repo/pull/42",
  "gitPushResult": {
    "pushed": true,
    "commitSha": "abc123def456...",
    "branchName": "sam/add-input-validation-01jk9m",
    "prUrl": "https://github.com/user/repo/pull/42",
    "prNumber": 42,
    "hasUncommittedChanges": false,
    "error": null
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `executionStep` | string | No | New execution step. When `'awaiting_followup'`, signals agent completed without terminal transition. |
| `toStatus` | TaskStatus | No | Terminal status transition. Mutually exclusive with `executionStep: 'awaiting_followup'`. |
| `outputSummary` | string | No | Human-readable summary of work done |
| `outputBranch` | string | No | Branch name (confirms/overrides the pre-generated name) |
| `outputPrUrl` | string | No | URL of created PR |
| `errorMessage` | string | No | Error details (for failed status) |
| `gitPushResult` | object | No | Detailed git operation results (see below) |

### gitPushResult Object

| Field | Type | Description |
|-------|------|-------------|
| `pushed` | boolean | Whether git push succeeded |
| `commitSha` | string \| null | SHA of the pushed commit |
| `branchName` | string \| null | Branch that was pushed to |
| `prUrl` | string \| null | URL of created/existing PR |
| `prNumber` | number \| null | PR number |
| `hasUncommittedChanges` | boolean | True if uncommitted changes remain after push attempt |
| `error` | string \| null | Error message if push failed |

## Response

### 200 OK

```json
{
  "id": "01JK9M2X4N...",
  "status": "running",
  "executionStep": "awaiting_followup",
  "finalizedAt": "2026-02-25T10:30:00.000Z",
  "updatedAt": "2026-02-25T10:30:00.000Z"
}
```

### Error Responses

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Invalid or expired callback token |
| 404 | `TASK_NOT_FOUND` | Task doesn't exist |
| 409 | `TASK_ALREADY_TERMINAL` | Task already in completed/failed/cancelled (cron recovery beat us) |

## Server-Side Logic

### When `executionStep: 'awaiting_followup'`

```
1. Validate callback token matches task's workspaceId
2. Verify task is in 'running' status with executionStep 'running'
3. If task already terminal (cron beat us): return 409, abort
4. Update task:
     - executionStep = 'awaiting_followup'
     - outputSummary = request.outputSummary (if provided)
     - outputBranch = request.outputBranch (if provided)
     - outputPrUrl = request.outputPrUrl (if provided)
5. If gitPushResult.pushed && task.finalizedAt IS NULL:
     - Set task.finalizedAt = now
6. Signal ProjectData DO:
     - Set chat_sessions.agent_completed_at = now
     - Schedule idle cleanup: scheduleIdleCleanup(sessionId, workspaceId, taskId)
     - Idle timeout: SESSION_IDLE_TIMEOUT_MINUTES (default: 15)
7. Record activity event: 'task.agent_completed'
8. Return updated task
```

### When `toStatus` is a terminal status (existing behavior, unchanged)

```
1. Validate callback token
2. Validate status transition
3. Update task status
4. Stop chat session
5. Trigger workspace cleanup
6. Return updated task
```

### Idle Cleanup Flow (triggered by DO alarm)

```
When idle_cleanup_schedule alarm fires for a session:
  1. Verify session is still active and workspace exists
  2. Call task status transition: task → 'completed'
  3. Stop chat session in DO
  4. Trigger workspace cleanup (same as existing cleanupTaskRun)
  5. If cleanup fails:
     a. Reschedule alarm with IDLE_CLEANUP_RETRY_DELAY_MS
     b. Increment retry count
     c. If retries exhausted: log error, keep workspace alive for cron sweep
```

## VM Agent Changes Required

The VM agent's `SessionHost.OnPromptComplete` (or `monitorProcessExit`) callback must be updated:

```go
// After ACP session ends:
1. Check for uncommitted changes: git status --porcelain
2. If changes exist:
   a. git add -A
   b. git commit -m "Changes from SAM agent session"
   c. git push origin {branchName}
3. Optionally create PR via gh CLI (if push succeeded and no existing PR)
4. POST callback to control plane:
   {
     executionStep: "awaiting_followup",
     gitPushResult: { pushed, commitSha, branchName, prUrl, error },
     outputSummary: "..."
   }
5. Do NOT exit the container — workspace stays alive for follow-ups
```

## Notes

- The `executionStep` and `toStatus` fields are mutually exclusive when `executionStep` is `'awaiting_followup'`. If both are provided, `executionStep` takes precedence.
- The VM agent should NOT send `toStatus: 'completed'` when the ACP session ends. It should send `executionStep: 'awaiting_followup'` instead. Terminal transitions are now triggered by idle cleanup or explicit user action.
- The existing `toStatus: 'failed'` path remains unchanged for error cases during execution.
