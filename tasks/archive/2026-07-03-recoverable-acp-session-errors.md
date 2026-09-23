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
- [x] Phase 5: Add/update Go tests for callback mapping, crash recovery fatal stop reasons, deadline-exceeded prompt timeout fatal behavior, and post-retry non-fatal prompt errors.
- [x] Phase 5: Add/update API route and vertical-slice tests proving recoverable callbacks keep task/session/workspace alive and clear stale error messages.
- [x] Phase 5: Add/run Playwright visual audit screenshots for mobile 375px and desktop 1280px, including a long recoverable error message.
- [x] Phase 5: Run required local quality checks, including Go `-race` for `packages/vm-agent`.
- [x] Phase 6: Coordinate staging deploys, delete staging nodes immediately before deploy because `packages/vm-agent/` changed, deploy the output branch, and verify a real recovered-from-error project chat.

## Acceptance Criteria

- [x] Conversation-mode non-fatal prompt error does not fail the task; it sets `executionStep` to `awaiting_followup`, persists an error message, leaves chat session active, and leaves workspace running.
- [x] User can send a new prompt after the error on the same ACP session/workspace.
- [x] Project chat shows recoverable error guidance, keeps input enabled, and clears the banner on recovery.
- [x] Fatal paths including rapid exit, max restarts, unrecoverable crash recovery, recovery watchdog timeout, restart failure, and prompt timeout still fail terminally in both task modes.
- [x] Task-mode non-fatal prompt errors still fail terminally.
- [x] Existing cancellation and crash-recovery recovered behavior remains unchanged.
- [x] No idle cleanup, heartbeat coupling, attention-marker expiry, grace-window, or lifecycle timer behavior changes.
- [x] Required Go, TypeScript, build/lint/typecheck, local UI audit, staging deploy, and staging feature verification are complete before merge.

## Validation Evidence

- Local full validation passed: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- VM-agent validation passed: `go test ./internal/acp ./internal/server` and `go test -race ./...` in `packages/vm-agent`.
- Targeted API callback tests passed, including recoverable callback persistence/clearing and session-not-stopped assertions.
- Local Playwright visual audit passed for desktop 1280px and mobile 375px:
  - `.codex/tmp/playwright-screenshots/project-chat-recoverable-error-desktop.png`
  - `.codex/tmp/playwright-screenshots/project-chat-recoverable-error-mobile.png`
- Staging deploy coordination:
  - Checked `deploy-staging.yml` queued/running runs before deploy: none.
  - Deleted smoke-user staging node `01KWKGXZY8B5NWWG6X0D6XAT7Y` before the final deploy; `/api/nodes` returned `[]`.
  - Final staging deploy run `28648434336` completed successfully; deploy job uploaded VM-agent binaries and smoke tests passed (`12 passed`).
  - Served Pages bundle `index-KSKvCNWf.js` contains `Agent error:` and the retry guidance.
- Live staging feature evidence before the final redeploy:
  - Task `01KWKGXSMF7WJGVX1M7D133F0Z`, session `313e5700-bd59-431c-b8e3-7f655eb9f32b`, workspace `01KWKH2RPJJHSDNJ666MP6BH92`.
  - First invalid-model prompt produced `status=in_progress`, `executionStep=awaiting_followup`, persisted error message, active session, running workspace.
  - Follow-up prompt was accepted on the same workspace/session and again returned `awaiting_followup`, proving same-workspace recovery.
- Deployed staging UI evidence after the final redeploy:
  - Real staging session `313e5700-bd59-431c-b8e3-7f655eb9f32b` renders `Agent error:` and `You can send another message to retry; your session and workspace are preserved.`
  - Screenshot: `.codex/tmp/playwright-screenshots/staging-recoverable-desktop.png`.
- Fresh post-deploy staging feature verification passed:
  - Task `01KWKKQPBAFJC2R4KTY7S59HZ8`, session `b357890c-9cf5-4057-b7a9-e966028dd79f`, workspace `01KWKKYBG6W1C8GZS6BZ0JHZSS`.
  - First invalid-model ACP prompt produced `status=in_progress`, `executionStep=awaiting_followup`, persisted error message, active session, running workspace.
  - Follow-up prompt was accepted and ended in `awaiting_followup` on the same workspace.
  - Cleanup completed: verifier session stopped, profile `01KWKKQN30NCVN580VDZNS27QW` deleted, node `01KWKKQV7FQ957MJPNVRK810VG` deleted, `/api/nodes` and `/api/workspaces` returned `[]`.

## Resolved Staging Blocker

Initial post-final-deploy verifier attempts were temporarily blocked by staging infrastructure, not the implementation:

- Fresh verifier attempts after deploy failed before workspace creation with `hetzner API error (403): server limit reached`.
- Failed task IDs: `01KWKJ1DR91X1ZQRH16KEF1BPE`, `01KWKJ65ZWZZ5K1RJZ2DJ5KGQD`.
- Corresponding temporary profiles were deleted.
- Error node records were deleted; `/api/nodes` returned `[]` and `/api/workspaces` returned `[]`.
- Admin usage reported zero active nodes for both `system_anonymous_trials` and the smoke user.
- Scaleway provider check failed fast with `Cloud provider credentials required`; no VM was created.
- Subsequent staging token-login attempts returned `429 RATE_LIMIT_EXCEEDED`, preventing further retries during this run.
- A later retry succeeded and is recorded above.

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
