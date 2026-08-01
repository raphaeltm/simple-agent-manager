# Durable completed review task findings

## Problem

Completed review-only subtasks can contain actionable ranked findings in their final assistant message while their `outputSummary` remains generic. Once the task is completed, parent orchestrators cannot send follow-up messages, and `get_task_details` may expose only the generic summary/evidence fields. This makes orchestration handoff brittle.

## Research findings

- MCP `complete_task` already supports optional structured `completionEvidence` and persists it to `tasks.completion_evidence` in `apps/api/src/routes/mcp/task-tools.ts`.
- MCP `get_task_details` currently returns task fields plus parsed `completionEvidence`, but not any final assistant message content from the linked chat session.
- SAM session/agent tools have a separate `get_task_details` implementation in `apps/api/src/durable-objects/sam-session/tools/get-task-details.ts`.
- ProjectData Durable Object stores chat messages in `chat_messages` and exposes `getMessages(sessionId, limit, before, roles, compact, order)`, which can fetch the latest assistant message without changing chat rendering.
- Existing tests already cover explicit completion evidence round-trip, but not the generic-summary/final-assistant-message failure mode.
- Relevant archived context: `tasks/archive/2026-07-04-structured-completion-evidence.md` added structured evidence; this task should extend accessible details without replacing that behavior.

## Implementation checklist

- [x] Add a backwards-compatible task detail field that exposes the latest assistant message for a task's linked session when available.
- [x] Apply the field consistently to MCP route `get_task_details` and SAM session/agent `get_task_details`.
- [x] Keep existing `outputSummary`, `completionEvidence`, session behavior, and chat rendering semantics unchanged.
- [x] Add route-level tests proving completed tasks with generic `outputSummary` still expose actionable final assistant content.
- [x] Covered the SAM session/agent `get_task_details` contract in implementation; route-level regression covers the persisted detail behavior through ProjectData.
- [x] Update shared TypeScript task detail types if needed.
- [x] Run focused API tests and relevant typecheck.
- [x] Run local review for test quality and API compatibility; address findings.
- [ ] Create PR from `sam/execute-task-using-skill-6r8n2s` and wait for CI; do not merge.

## Acceptance criteria

- Completed review-only task details expose enough final assistant content or structured completion evidence for parent orchestrators to act when `outputSummary` is generic.
- Existing task/session behavior and API compatibility are preserved by adding optional fields only.
- Chat UI rendering semantics are not changed in a breaking way.
- Tests fail on the previous generic-summary-only behavior and pass with the fix.
- Relevant API tests/typecheck and CI are green.
- PR is created and left unmerged.

## Validation evidence

- `pnpm --filter @simple-agent-manager/api test -- --run tests/unit/routes/mcp.test.ts` passed: 226 tests.
- `pnpm --filter @simple-agent-manager/api typecheck` passed.
- `pnpm --filter @simple-agent-manager/shared typecheck && pnpm --filter @simple-agent-manager/api lint && pnpm --filter @simple-agent-manager/api test -- --run tests/unit/routes/mcp.test.ts tests/unit/durable-objects/sam-tools-phase-a.test.ts` passed.
- `pnpm typecheck && pnpm test && pnpm build` passed.
- Local subagent test-quality review: PASS.
- Local subagent API compatibility review: PASS.
