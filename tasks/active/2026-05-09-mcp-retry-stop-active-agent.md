# MCP retry_subtask must stop active child agents

## Problem

The MCP `retry_subtask` implementation marks an active child task as failed and starts a replacement task, but it only stops the ProjectData chat session. It does not stop the actual running node agent session. That allows the original child agent to keep executing in the workspace while the replacement task starts, which violates the orchestration contract and can cause duplicated commits, conflicting workspace writes, and confusing parent/child task state.

## Research Findings

- `apps/api/src/routes/mcp/orchestration-tools.ts` handles `retry_subtask`, `add_dependency`, and `remove_pending_subtask`.
- `handleRetrySubtask()` updates active child tasks to `failed` and calls `projectDataService.stopSession()` when a workspace has a `chatSessionId`, but it never resolves the running `agent_sessions` row or calls `stopAgentSessionOnNode()`.
- `apps/api/src/routes/mcp/orchestration-comms.ts` already has the stricter stop path for `stop_subtask`: resolve workspace, node, running agent session, call `stopAgentSessionOnNode()`, then update task state.
- `apps/api/tests/unit/routes/mcp-orchestration-tools.test.ts` has a test named "should stop running child task before retrying", but it only asserts a successful response. It would not have caught the missing node-agent stop.
- Relevant rules:
  - `.claude/rules/02-quality-gates.md`: bug fixes require regression tests that would have caught the bug.
  - `.claude/rules/03-constitution.md`: no new hardcoded limits, URLs, or identifiers that should be configurable.
  - `.claude/rules/06-api-patterns.md`: route behavior must be tested through the mounted app where applicable.

## Implementation Checklist

- [x] Add a focused helper in the MCP retry path that resolves the child workspace, node, and latest running agent session when retrying an active task.
- [x] Call `stopAgentSessionOnNode()` for active child tasks before dispatching the replacement task.
- [x] Keep ProjectData `stopSession()` as best-effort cleanup after the node stop attempt.
- [x] Log node-stop failures and decide whether retry should fail or continue. The contract says stop before retry, so failures should block replacement dispatch.
- [x] Update the regression test so the active retry path proves the node agent stop service is invoked with the expected node, workspace, session, env, and user.
- [x] Add or update negative coverage for node-stop failure so replacement dispatch does not happen when the original active child cannot be stopped.
- [x] Run the focused MCP orchestration tests.
- [x] Add the required bug-fix post-mortem and process-rule update.
- [x] Run relevant API type/lint checks if available in the workspace.

## Validation

- `pnpm --filter @simple-agent-manager/api test -- mcp-orchestration-tools.test.ts` passed, 29 tests.
- `pnpm --filter @simple-agent-manager/api test -- mcp-orchestration-comms.test.ts mcp-orchestration-tools.test.ts` passed, 50 tests.
- `pnpm --filter @simple-agent-manager/api typecheck` passed.
- `pnpm --filter @simple-agent-manager/api lint` passed with existing warning debt.
- `pnpm --filter @simple-agent-manager/api build` passed.
- `git diff --check` passed.

## Acceptance Criteria

- Retrying an active child task stops the node agent session before the replacement is started.
- If node-agent stop fails for an active child, `retry_subtask` returns an error and does not dispatch the replacement.
- Existing failed-task retry behavior still works.
- Tests prove the regression contract and would fail if the node-agent stop call is removed.
