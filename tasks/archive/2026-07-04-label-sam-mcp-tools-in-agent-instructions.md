# Label SAM MCP tools in agent instructions

**Created**: 2026-07-04
**Priority**: High
**Classification**: `bug`

## Problem

In session `32a107df-6aff-4e35-867f-777d8032336b`, an agent repeatedly said it could not call `complete_task()` because the tool was not exposed. After the user explicitly called it the `complete_task` SAM MCP tool, the agent searched the deferred MCP tool surface and found `mcp__sam_mcp.complete_task`.

The task-start prompt already names `get_instructions` as coming from the `sam-mcp` MCP server, but the follow-up instructions returned by `get_instructions` describe tools like `complete_task`, `dispatch_task`, and `update_task_status` as generic tool calls. That wording can make agents look for local commands or only initially visible tools instead of discovering/calling the SAM MCP tools.

## Research Findings

- Referenced session evidence shows the failure pattern: repeated "tool is not exposed" responses followed by discovery of `mcp__sam_mcp.complete_task` after the user called it a SAM MCP tool.
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts` already tells new task agents to call the `get_instructions` tool from the `sam-mcp` MCP server.
- `apps/api/src/routes/mcp/instruction-tools.ts` builds the instructions returned by `get_instructions`; this is the right place to make subsequent tool references explicit.
- Existing MCP route tests in `apps/api/tests/unit/routes/mcp.test.ts` already exercise `get_instructions` output and can carry a focused regression assertion.
- Relevant retained lesson: `tasks/archive/2026-04-03-fix-mcp-streamable-http-compliance.md` documents prior Codex/MCP integration strictness, so MCP behavior should be tested directly.

## Implementation Checklist

- [x] Update `get_instructions` task-mode wording to label `update_task_status` and `complete_task` as SAM MCP tools.
- [x] Update `get_instructions` conversation-mode wording to label `dispatch_task`, `update_task_status`, and `complete_task` as SAM MCP tools.
- [x] Add or update focused API test assertions so the returned instructions include the SAM MCP wording.
- [x] Run targeted MCP route tests and relevant quality checks.
- [x] Deploy to staging and verify live MCP instruction wording before PR.
- [x] Prepare PR for merge. Post-merge production monitoring is tracked in `/do` Phase 7 and SAM task status after this archive commit.

## Acceptance Criteria

- Agents receiving `get_instructions` see SAM MCP tool names explicitly described as SAM MCP tools.
- The instructions still preserve task-mode versus conversation-mode behavior.
- Automated tests fail if the explicit SAM MCP wording is removed from the main instruction payload.
- Staging deployment verifies the changed instructions on the live Worker before merge.
- Production deploy is monitored after merge.

## Validation

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/mcp.test.ts`
- `pnpm --filter @simple-agent-manager/api lint`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

## Review Evidence

- `$task-completion-validator`: PASS. Research findings, checklist items, diff, and test coverage were aligned; post-merge production monitoring remains a workflow step.
- `$cloudflare-specialist`: PASS. No Wrangler, D1, KV, R2, or migration changes; Worker route behavior is covered by MCP route tests.
- `$constitution-validator`: PASS. No new hardcoded configurable URLs, timeouts, limits, or identifiers.
- `$test-engineer`: PASS. Regression tests cover task and conversation mode through JSON-RPC `tools/call`.

## Staging Evidence

- Staging workflow `Deploy Staging` run `28711486479` passed for branch `sam/32a107df-6aff-4e35-867f-01kwpt`.
- Cloudflare Worker script `sam-api-staging` contains:
  - Tool names in these instructions refer to SAM MCP tools from the `sam-mcp` MCP server.
  - Call the SAM MCP `complete_task` tool.
  - Use the SAM MCP `dispatch_task` tool.
- Cloudflare Worker script `sam-api-staging` no longer contains the old bare wording: Call `complete_task` with a summary when all work is done.
- Live staging `/mcp` JSON-RPC `tools/call get_instructions` returned all expected task-mode fragments for an existing staging MCP token: top-level SAM MCP server note, `update_task_status`, `complete_task`, and the push-before-`complete_task` instruction.

## References

- Session: `32a107df-6aff-4e35-867f-777d8032336b`
- `apps/api/src/routes/mcp/instruction-tools.ts`
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts`
- `apps/api/tests/unit/routes/mcp.test.ts`
