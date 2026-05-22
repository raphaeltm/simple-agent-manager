# Improve Dispatch Task Mode Visibility

## Problem

Agent-to-agent dispatch can silently resolve to `conversation` mode through profile settings or the SAM dispatch path's lightweight workspace fallback. Dispatch responses do not expose the resolved `taskMode`, so parent agents can assume task lifecycle semantics, poll status only, and miss child messages that require active management.

## Research Findings

- `apps/api/src/routes/mcp/dispatch-tool.ts` already resolves `resolvedTaskMode` with explicit value, profile value, then `'task'`, and persists/logs it, but the JSON-RPC response does not return it.
- `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts` resolves `resolvedTaskMode` with explicit value, profile value, then `resolvedWorkspaceProfile === 'lightweight' ? 'conversation' : 'task'`; this is the SAM-only default that must be removed for delegated work.
- `apps/api/src/routes/tasks/submit.ts` is the human UI submit path and must remain unchanged so lightweight chat submissions can still default to conversation mode.
- Tool schemas needing clearer guidance are `apps/api/src/routes/mcp/tool-definitions-task-tools.ts`, `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts`, and `apps/api/src/routes/mcp/tool-definitions-profile-tools.ts`.
- Related postmortem: `docs/notes/2026-05-13-conversation-idle-timeout-task-completion-postmortem.md` shows that conversation mode has different lifecycle behavior and can leave tasks awaiting follow-up if cleanup paths are wrong.
- Existing test search did not find obvious dispatch-specific unit tests via `*.test.ts`/`*.spec.ts`; implementation should identify the nearest local test pattern and add focused coverage.

## Implementation Checklist

- [ ] Add `taskMode: resolvedTaskMode` to the MCP `dispatch_task` success response.
- [ ] Add a conversation-mode warning to the MCP response that tells agents the child will not auto-complete, to use `send_message_to_subtask` / `get_session_messages`, and to pass `taskMode: "task"` to override.
- [ ] Add `taskMode: resolvedTaskMode` to the SAM `dispatch_task` success response.
- [ ] Add the same conversation-mode warning to the SAM response.
- [ ] Change the SAM dispatch fallback from lightweight-to-conversation to unconditional `'task'`, with the requested comment explaining that workspace profile controls provisioning shape, not completion reporting.
- [ ] Update MCP `dispatch_task` tool definition guidance to recommend `task` for subtasks and warn that `conversation` requires active lifecycle management via `send_message_to_subtask`.
- [ ] Update SAM `dispatch_task` tool definition guidance with the same treatment.
- [ ] Update profile tool `taskMode` description to say most profiles should use `task` or leave it unset.
- [ ] Add unit coverage for MCP dispatch response `taskMode`.
- [ ] Add unit coverage for MCP dispatch conversation warning when profile resolves to conversation mode.
- [ ] Add unit coverage for SAM dispatch response `taskMode`.
- [ ] Add a SAM dispatch regression test proving lightweight workspace profile defaults to `task`.
- [ ] Run relevant unit tests plus lint/typecheck as required by the `/do` workflow.

## Acceptance Criteria

- MCP `dispatch_task` success responses include the resolved `taskMode`.
- MCP `dispatch_task` success responses include an actionable `warning` when `taskMode` resolves to `conversation`.
- SAM `dispatch_task` success responses include the resolved `taskMode`.
- SAM `dispatch_task` success responses include the same actionable `warning` for conversation mode.
- SAM dispatch defaults to `task` even when the resolved workspace profile is `lightweight`, unless an explicit or profile `taskMode` says otherwise.
- Human UI task submission behavior in `apps/api/src/routes/tasks/submit.ts` is unchanged.
- Tool descriptions steer subtask dispatch toward task mode and make conversation-mode lifecycle responsibilities explicit.
- Unit tests cover the changed response/default behavior.

## References

- `apps/api/src/routes/mcp/dispatch-tool.ts`
- `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts`
- `apps/api/src/routes/mcp/tool-definitions-task-tools.ts`
- `apps/api/src/routes/mcp/tool-definitions-profile-tools.ts`
- `apps/api/src/routes/tasks/submit.ts`
- `docs/notes/2026-05-13-conversation-idle-timeout-task-completion-postmortem.md`
