# Conversation Recovery Prompt

## Problem

Conversational agent sessions can survive a mid-prompt agent disconnect through VM-side `LoadSession` recovery, but then appear stalled from the user's perspective. The session does not crash, which is an improvement, but the control plane does not make it obvious that a recoverable error happened or that the agent should continue.

## Research Findings

- `packages/vm-agent/internal/acp/session_host_prompt.go` detects crash-style prompt errors and defers to crash recovery when `LoadSession` is available.
- `packages/vm-agent/internal/acp/session_host_process.go` reports successful crash recovery with stop reason `recovered` and no error payload.
- `packages/vm-agent/internal/server/server.go` maps `recovered` to `executionStep=awaiting_followup` with no `errorMessage`, so `apps/api/src/routes/tasks/callback.ts` cannot persist the diagnostic.
- `apps/api/src/routes/tasks/callback.ts` already persists recoverable execution-step `errorMessage` values and emits `task.agent_error_recoverable`, keeping conversation sessions alive.
- `apps/api/src/durable-objects/project-data/reconciliation.ts` has the right delivery path for orchestrator check-ins, but currently excludes all `task_mode = 'conversation'` rows.
- The debug bundle for node `01KX2NQEHHG9BXJQCDX0GD964H` confirms a recovered `peer disconnected before response` incident at 2026-07-09T17:31:27Z followed by `LoadSession succeeded` and an `awaiting_followup` callback without an error.

## Implementation Checklist

- [x] Preserve a sanitized recovered-crash diagnostic in the VM agent task callback payload.
- [x] Extend ProjectData reconciliation to select conversation-mode tasks only when a persisted recoverable error exists and no later activity supersedes it.
- [x] Send a one-time conversation recovery prompt with bounded diagnostic context through the existing node delivery path.
- [x] Persist/broadcast the recovery prompt and create an unresolved marker to avoid duplicate prompts without failing conversational sessions on the task-mode response deadline.
- [x] Keep ordinary conversation-mode idle sessions excluded from task reconciliation.
- [x] Add/update Go tests for recovered callback error payload redaction.
- [x] Add/update TypeScript reconciliation tests for conversation recovery selection, delivery, and normal conversation exclusion.

## Validation

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/task-callback-recoverable-error.test.ts tests/unit/durable-objects/reconciliation.test.ts` — 55 passed.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed with pre-existing warnings.
- `go test ./internal/acp ./internal/server -run 'TestSessionHost_CrashRecoveryReportsDiagnosticError|TestSessionHost_CodexCrashRecovery_ReportsRecovered|TestTaskCompletionCallback'` — passed.
- `git diff --check` — passed.

## Review Notes

- `$go-specialist`: PASS. Crash-recovery diagnostic is captured under existing host mutex state and delivered through the existing prompt-completion callback.
- `$test-engineer`: PASS. Added focused Go tests plus DO reconciliation tests that carry realistic session, activity, task, workspace, and VM-agent delivery state.
- `$constitution-validator`: PASS. No new internal URLs, deployment identifiers, timeouts, or operational limits. The diagnostic truncation cap is a local presentation-safety constant.
- `$security-auditor`: PASS after adding control-plane diagnostic redaction before recovery prompts are persisted/broadcast.
- `$task-completion-validator`: PASS. Research findings, checklist items, and acceptance criteria are covered by implementation and validation above.

## Acceptance Criteria

- A recovered mid-prompt agent disconnect in conversation mode stores a sanitized recoverable diagnostic instead of silently clearing it.
- A conversation task with that recoverable diagnostic receives an orchestrator recovery prompt after the normal idle threshold if no later activity arrived.
- The recovery prompt includes bounded diagnostic context and asks the agent to continue carefully.
- Normal conversation-mode idle sessions without a recoverable error are still not auto-prompted.
- Task-mode reconciliation behavior remains unchanged.
