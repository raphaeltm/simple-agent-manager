# Project-scoped agent MCP messaging authorization

## Problem

SAM's non-destructive agent-to-agent MCP communication tools still enforce direct parent/child task lineage in places where the intended trust boundary is the verified MCP token's project. After sleep/wake recovery, the caller may have a new task row while existing project peers still point at the old parent task ID, causing same-project messaging or wait registration to fail even though both agents belong to the same project.

The product decision for this task is explicit: any active task agent in a project may send a message to any other active task agent in the same project. Cross-project messaging remains blocked. Sender identity, sender project, and provenance must continue to come from the verified MCP token.

## Research findings

- Referenced idea `01M0SD6W5SR7FWFVWTK7DWV318` identifies direct `parent_task_id` checks in:
  - `apps/api/src/routes/mcp/task-wait-tools.ts`
  - `apps/api/src/routes/mcp/orchestration-comms.ts`
  - `apps/api/src/routes/mcp/mailbox-tools.ts`
  - `apps/api/src/routes/mcp/orchestration-tools.ts`
  - `apps/api/src/routes/mcp/workspace-tools-direct.ts`
- Current task scope narrows the idea: change non-destructive communication/delivery tools and shared auth seams only. Do not broaden destructive controls.
- `send_message_to_subtask` resolves target tasks through `resolveChildAgent()` in `apps/api/src/routes/mcp/orchestration-comms.ts`; the same helper is also used by destructive `stop_subtask`, so the helper must split project-peer messaging from direct-child stopping rather than simply removing the parent check.
- `send_durable_message` resolves targets through `resolveChildForMailbox()` in `apps/api/src/routes/mcp/mailbox-tools.ts`; this is a non-destructive durable messaging path and should become project-scoped while retaining active-status, workspace/session, length, metadata, mailbox cap, and delivery semantics.
- `wait_for_subtasks` currently rejects non-child task IDs. It is non-destructive durable coordination/delivery and should register waits for same-project task IDs while retaining task-agent-only, non-terminal caller, session-matching, wait-key, wait-size, and durable-delivery checks.
- `stop_subtask`, `retry_subtask`, and `remove_pending_subtask` are destructive lifecycle controls that stop/cancel/retry/remove work. Their direct-parent restrictions remain in scope as regression coverage, not as changes.
- `add_dependency` mutates the execution graph and uses lineage to preserve workflow shape, not messaging authorization. It remains unchanged unless an implementation dependency proves otherwise.
- `list_project_agents` and `get_peer_agent_output` are already project-scoped discovery/read tools. `get_task_dependencies` is lineage-shaped discovery and is out of this communication/delivery change.
- Existing tests include mock-heavy `send_message_to_subtask` coverage and real-SQL `wait_for_subtasks` cross-project scoping tests. New authorization tests must use real SQLite D1 fixtures where SQL predicates are the protection boundary.
- `$api-reference` currently documents direct-child behavior for `wait_for_subtasks` and messaging definitions describe child-only targets. Update the reference/tool descriptions if behavior changes.

## Implementation checklist

- [x] Split shared MCP target resolution so non-destructive messaging uses a same-project active target check while destructive stop keeps direct-parent authorization.
- [x] Update `send_message_to_subtask` to allow same-project non-parent/sibling targets and preserve verified-token provenance (`sourceTaskId`, `senderId`, `userId`, metadata).
- [x] Update `send_durable_message` to allow same-project non-parent/sibling targets and preserve rate limits, size caps, mailbox limits, message class behavior, immediate-delivery fallback, and provenance.
- [x] Update `wait_for_subtasks` to allow same-project task IDs without direct-child lineage while preserving caller/session/wait registration checks.
- [x] Keep `stop_subtask`, `retry_subtask`, `remove_pending_subtask`, and `add_dependency` direct-parent/workflow restrictions unchanged.
- [x] Update MCP tool descriptions and API reference text from direct-child-only to project-scoped where applicable.
- [x] Add real-SQL authorization tests for same-project non-parent/sibling success, cross-project rejection, inactive/terminal target rejection, verified sender provenance, and parent-flow regression coverage.
- [x] Add regression tests proving destructive parent-only tools still reject non-parent/sibling callers.
- [ ] Run focused tests, then the appropriate local quality suite.
- [ ] Run required specialist reviews: security-auditor, cloudflare-specialist, test-engineer, task-completion-validator, and constitution-validator.
- [ ] Create and push a focused PR. Do not deploy to staging and do not merge.

## Acceptance criteria

- Same-project active non-parent/sibling agents can use non-destructive MCP messaging/delivery tools.
- Cross-project target task IDs are rejected without leaking access or queuing/delivering messages.
- Terminal or otherwise inactive targets keep existing rejection behavior for active-agent messaging.
- Delivery writes continue to derive `sourceTaskId`, `senderId`, project ID, and user ID from the verified MCP token, not caller-supplied parameters.
- Direct parent flows continue to work.
- Destructive controls remain direct-parent restricted.
- Local tests and CI evidence are recorded in the PR.
- Staging is intentionally skipped by explicit user instruction, and the PR is left unmerged.

## References

- SAM idea: `01M0SD6W5SR7FWFVWTK7DWV318`
- `.claude/rules/11-fail-fast-patterns.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md`
