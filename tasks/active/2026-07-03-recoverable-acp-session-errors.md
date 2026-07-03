# Recoverable ACP session errors

## Problem

Conversation-mode ACP prompt errors such as exhausted provider credits currently mark the task failed, stop the chat session, and eventually lose the workspace. Non-fatal prompt errors should instead leave project chat recoverable: the task remains in progress, the execution step becomes `awaiting_followup`, the error is visible to the user, and the same workspace/session can accept another prompt.

Autonomous task mode keeps existing terminal failure semantics. Fatal agent/session failures remain terminal in both modes. No idle cleanup, heartbeat coupling, attention-marker expiry, grace-window, or lifecycle timer behavior should change.

## Research Findings

- Idea `01KWKDYXNB97J4Z5Q9RGS8APPF` contains the human-approved design and six-phase plan. Follow it exactly.
- ACP prompt errors are completed from `packages/vm-agent/internal/acp/session_host_prompt.go` via `finishPromptWithError`; plain non-crash prompt errors currently notify stopReason `"error"`.
- Crash recovery fatal paths are centralized through `finishCrashRecoveryFailure` in `packages/vm-agent/internal/acp/session_host_process.go`; the shared recovered stop reason constant lives in `session_host_crash.go`.
- VM-agent callback mapping is in `packages/vm-agent/internal/server/server.go:makeTaskCompletionCallback`; existing cancellation and recovered reasons already map to `awaiting_followup`.
- Control-plane callback handling is in `apps/api/src/routes/tasks/callback.ts`; the execution-step branch currently ignores `errorMessage`, while the terminal branch persists error text, stops sessions, and sends failure notification.
- Project chat already consumes task `errorMessage` in `apps/web/src/pages/project-chat/useProjectChatState.ts` and related UI surfaces, but recoverable error wording/clearing must be made explicit and visually audited.
- Applicable rules: `.claude/rules/02-quality-gates.md` runtime-side lifecycle assertions, `.claude/rules/13-staging-verification.md`, `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/27-vm-agent-staging-refresh.md`, `.claude/rules/34-vm-agent-callback-auth.md`, `.claude/rules/35-vertical-slice-testing.md`.
- Retained incident lessons relevant to this work: callback routes must stay outside session-auth middleware; lifecycle control tests must assert the runtime boundary; staging verification must exercise the actual agent/session flow, not only page loads.

## Implementation Checklist

- [x] Phase 1: Add `fatalErrorStopReason = "fatal_error"` in ACP code and route fatal crash recovery, unrecoverable crash prompts, and deadline-exceeded prompt timeout to it.
- [x] Phase 1: Preserve plain non-crash prompt errors as stopReason `"error"` and verify post-retry prompt errors remain non-fatal.
- [x] Phase 2: Update `makeTaskCompletionCallback` so `fatal_error` is terminal failed in both modes, conversation-mode `"error"` maps to execution-step-only `awaiting_followup` with a redacted error message, and task-mode `"error"` remains terminal failed.
- [x] Phase 3: Update task callback execution-step handling to persist recoverable `errorMessage`, clear it on subsequent execution-step callbacks without an error, and record `task.agent_error_recoverable` activity without stopping sessions or notifying task failure.
- [x] Phase 4: Surface recoverable errors in project chat with non-terminal recovery guidance; keep input enabled and ensure the banner clears/supersedes after recovery.
- [ ] Phase 5: Add/update Go tests for callback mapping, crash recovery fatal stop reasons, deadline-exceeded prompt timeout fatal behavior, and post-retry non-fatal prompt errors.
- [x] Phase 5: Add/update API route and vertical-slice tests proving recoverable callbacks keep task/session/workspace alive and clear stale error messages.
- [x] Phase 5: Add/run Playwright visual audit screenshots for mobile 375px and desktop 1280px, including a long recoverable error message.
- [ ] Phase 5: Run required local quality checks, including Go `-race` for `packages/vm-agent`.
- [ ] Phase 6: Coordinate staging deploys, delete staging nodes immediately before deploy because `packages/vm-agent/` changed, deploy the output branch, and verify a real recovered-from-error project chat.

## Acceptance Criteria

- [ ] Conversation-mode non-fatal prompt error does not fail the task; it sets `executionStep` to `awaiting_followup`, persists an error message, leaves chat session active, and leaves workspace running.
- [ ] User can send a new prompt after the error on the same ACP session/workspace.
- [ ] Project chat shows recoverable error guidance, keeps input enabled, and clears the banner on recovery.
- [ ] Fatal paths including rapid exit, max restarts, unrecoverable crash recovery, recovery watchdog timeout, restart failure, and prompt timeout still fail terminally in both task modes.
- [ ] Task-mode non-fatal prompt errors still fail terminally.
- [ ] Existing cancellation and crash-recovery recovered behavior remains unchanged.
- [ ] No idle cleanup, heartbeat coupling, attention-marker expiry, grace-window, or lifecycle timer behavior changes.
- [ ] Required Go, TypeScript, build/lint/typecheck, local UI audit, staging deploy, and staging feature verification are complete before merge.

## References

- `packages/vm-agent/internal/acp/session_host_crash.go`
- `packages/vm-agent/internal/acp/session_host_prompt.go`
- `packages/vm-agent/internal/acp/session_host_process.go`
- `packages/vm-agent/internal/server/server.go`
- `packages/vm-agent/internal/server/task_callback_scoping_test.go`
- `apps/api/src/routes/tasks/callback.ts`
- `apps/api/src/schemas/tasks.ts`
- `apps/web/src/pages/project-chat/`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
