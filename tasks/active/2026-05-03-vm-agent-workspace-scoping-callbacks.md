# Fix VM Agent Workspace Scoping and Callbacks

## Problem

Production debug evidence from idea `01KQQVNSHJAA8K46Y3ZAZQG109` showed long-lived VM agents leaking boot-time node/task state into later workspace-scoped operations. Message reporting attempted workspace message endpoints with node-scoped identity, task completion callbacks used stale boot task/workspace IDs, and callback logs lacked enough response detail to diagnose API rejections.

## Research Findings

- `packages/vm-agent/internal/server/server.go` initializes ACP and boot-time message reporting with `defaultWorkspaceScope(cfg.WorkspaceID, cfg.NodeID)`, which can turn a node ID into a workspace endpoint target.
- `packages/vm-agent/internal/server/agent_ws.go` creates `SessionHost` instances per workspace/session, but currently inherits the server-level `OnPromptComplete` callback.
- `packages/vm-agent/internal/server/workspaces.go` starts agent sessions from control-plane requests, but the start payload does not include task ID or task mode.
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts` knows the task ID when calling `startAgentSessionOnNode`, so it can pass per-session task context to the VM agent.
- `apps/api/src/routes/tasks/crud.ts` correctly rejects callback tokens whose `workspace` claim does not match `task.workspaceId`; callbacks must use workspace-scoped tokens.
- `apps/api/src/routes/workspaces/_helpers.ts` correctly rejects node-scoped callback tokens for workspace message endpoints.
- Relevant postmortems:
  - `docs/notes/2026-03-12-message-misrouting-and-metadata-loss-postmortem.md`: shared reporter state and wrong workspace attribution caused cross-workspace contamination.
  - `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`: wrong identity boundary caused chat/session routing bugs.

## Checklist

- [ ] Add regression tests for boot-time reporter initialization so node IDs are never used as workspace IDs for message endpoints.
- [ ] Add regression tests for task completion callbacks showing two workspaces/sessions can use independent task IDs and workspace-scoped tokens.
- [ ] Pass task ID/task mode from task runner start-session calls into the VM agent.
- [ ] Bind `OnPromptComplete` per `SessionHost` using workspace/session/task context instead of inheriting stale server boot config.
- [ ] Ensure conversation-mode or no-workspace tasks do not attempt git push against an empty workspace ID.
- [ ] Add bounded response body logging for task callback and message reporter permanent failures.
- [ ] Update docs or comments that describe the new identity boundary.
- [ ] Run focused Go/TypeScript tests, then full quality gates.
- [ ] Complete staging verification with real VM provisioning, project chat usage, multi-conversation switching, node monitoring/debug package checks, and node cleanup.

## Acceptance Criteria

- Starting workspace A and workspace B on the same node produces independent task callbacks.
- A prompt completion in workspace B cannot post status for workspace A's task.
- `POST /api/workspaces/:id/messages` is only attempted when the reporter has a real workspace ID and workspace-scoped callback token.
- Node-scoped boot reporter does not enqueue or flush chat messages to workspace endpoints.
- Task callback and message reporter failures log safe bounded response bodies.
- Staging verification proves the fixed behavior through real user-like project chat sessions and cleans up created nodes/workspaces.
