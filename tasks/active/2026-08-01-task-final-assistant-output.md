# Expose completed task final assistant output

## Problem

Parent orchestrators can inspect completed child tasks with `get_task_details`, but the returned `outputSummary` can be generic and may not include the child agent's final actionable findings. Completed tasks cannot receive follow-up messages, so the parent needs a direct read path for the final assistant output that already exists in the task's chat session.

## Research Findings

- `apps/api/src/routes/mcp/task-tools.ts` implements MCP `complete_task` and `get_task_details` for SAM-managed agents.
- `apps/api/src/durable-objects/sam-session/tools/get-task-details.ts` implements the older in-DO tool shape.
- `apps/api/src/routes/mcp/session-tools.ts` already groups streaming assistant tokens into logical messages via `groupTokensIntoMessages`.
- `apps/api/src/services/project-data.ts` exposes `getMessages(..., roles, compact, order)`, which can retrieve assistant messages from the ProjectData Durable Object.
- Existing clients depend on `outputSummary`, `completionEvidence`, and `sessionId`, so the safe change is an optional additive field rather than replacing existing values.

## Implementation Checklist

- [x] Add a bounded helper that resolves the latest grouped assistant message for completed tasks with a session.
- [x] Include an optional `finalAssistantOutput` field in MCP `get_task_details` without changing existing fields.
- [x] Mirror the compatible field in the SAM-session/project-agent task details tool where practical.
- [x] Add tests proving a parent/orchestrator can retrieve final actionable assistant output from a completed task.

## Acceptance Criteria

- `get_task_details` still returns all existing fields with unchanged names.
- Completed task details include `finalAssistantOutput` when assistant session output exists.
- The final output is sourced from session assistant messages, not from the generic `outputSummary`.
- Tests cover grouped/streamed assistant output and fallback absence behavior.

## References

- `apps/api/src/routes/mcp/task-tools.ts`
- `apps/api/src/durable-objects/sam-session/tools/get-task-details.ts`
- `apps/api/src/routes/mcp/session-tools.ts`
