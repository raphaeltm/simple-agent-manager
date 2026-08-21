# Manual Session Sleep Before Archive

## Problem Statement

Project chat's center lifecycle dock still exposes the destructive archive path as the normal action for an awake idle conversation. The product decision is stricter: make irreversible archive intentionally harder by forcing users through a reversible sleep state first.

The center lifecycle action must map:

- Working session → Stop / interrupt the active agent work
- Awake idle session → Sleep
- Sleeping session → Archive

Sleeping sessions must retain the composer and continue to wake when the user sends a message.

## Research Findings

- `apps/web/src/components/project-message-view/CompletionDock.tsx` owns the circular center lifecycle button and currently morphs between working `Interrupt agent` and idle `Archive conversation`.
- `apps/web/src/components/project-message-view/index.tsx` already treats `sleeping` as active enough to keep the composer mounted. Its placeholder says `Send a message to wake the agent...`, and `useSessionLifecycle.handleSendFollowUp()` already routes sleeping-session follow-ups through the existing durable wake path.
- `apps/web/src/pages/project-chat/useProjectChatState.ts` currently has one destructive `handleCloseConversation()` path, which calls `closeConversationTask()` for task-backed sessions or `stopChatSession()` for taskless instant sessions.
- `apps/web/src/lib/api/workspaces.ts` has stop/restart/rebuild/delete wrappers but no wrapper for the existing `POST /api/workspaces/:id/sleep` endpoint.
- `apps/api/src/routes/workspaces/lifecycle.ts` already exposes `POST /api/workspaces/:id/sleep`, protected by `requireAuth()` + `requireApproved()`, and it calls `sleepWorkspaceSession()` with the caller's user id.
- `apps/api/src/services/session-sleep.ts` already performs strict sleep gating: it requires persistent-session metadata, a resumable agent session, idle ProjectData activity, no active/settling harness-work lease, stable activity before/after final snapshot capture, verified R2 artifacts, ProjectData `sleepSession()`, and runtime teardown.
- The existing workspace sleep endpoint is intentionally caller-owned through `getOwnedWorkspace()`, matching the existing archive cleanup constraint that project-authorized members must not tear down another member's compute.
- Existing docs in `apps/www/src/content/docs/docs/guides/instant-sessions.md` describe automatic sleep/wake and destructive archive but do not mention manual sleep from the lifecycle dock.

## Relevant Lessons / Constraints

- `tasks/archive/2026-07-02-completion-dock-integration.md`: keep the lifecycle dock always mounted for conversation-mode active sessions so the lifecycle control does not disappear when activity signals are stale.
- `tasks/archive/2026-07-04-confirm-chat-archive-dialog.md`: archive remains destructive and must stay behind confirmation; check `CompletionDock` effect collisions for interactive changes.
- `tasks/archive/2026-08-16-prevent-hidden-harness-work-sleep-and-add-durable-task-waits.md`: do not sleep while harness-owned background work is active; rely on the shared sleep gate.
- `tasks/archive/2026-08-17-fix-slept-session-classified-as-dead.md`: sleeping/restorable sessions are not terminal; do not collapse sleeping into stopped/deleted behavior.
- Stored project policy: "Require sleep before session archive" — awake idle sessions must not expose Archive as the normal center action.

## Interaction Variants Considered

1. Add a separate top-level "Sleep" button while leaving the center dock as Archive.
   - Rejected: preserves the current unsafe primary action and adds duplicate lifecycle controls.
2. Change the center dock into an explicit three-state lifecycle action: Stop while working, Sleep while awake idle, Archive while sleeping.
   - Selected: exactly matches the product rule and preserves the existing single-control dock mental model.
3. Require a confirmation dialog before Sleep, then keep Archive confirmation.
   - Rejected for now: Sleep is reversible and should be the normal idle action; the destructive Archive confirmation remains the safety gate.

## Implementation Checklist

- [x] Add a typed `sleepWorkspace()` client wrapper for `POST /api/workspaces/:id/sleep`.
- [x] Split project chat lifecycle handlers into manual Sleep and destructive Archive paths.
- [x] Wire awake idle conversation sessions to Sleep, using the selected session's `workspaceId` and refreshing session state after success.
- [x] Keep destructive Archive using the existing `closeConversationTask()` / `stopChatSession()` path and confirmation.
- [x] Update `CompletionDock` to support center action modes: interrupt, sleep, archive.
- [x] Preserve working-state immediate interrupt behavior.
- [x] Preserve sleeping-session Archive confirmation and composer/wake affordance.
- [x] Add unit tests for CompletionDock action modes and ProjectMessageView routing.
- [x] Update Playwright completion dock audit to cover awake idle Sleep, sleeping Archive, and working Stop/Interrupt on mobile and desktop.
- [x] Update user-facing docs to mention manual Sleep and the Sleep-before-Archive lifecycle.
- [x] Run local UI visual validation and full quality gates.

## Acceptance Criteria

- [x] An awake idle conversation-mode session shows `Sleep session` as the center lifecycle action, not `Archive conversation`.
- [x] Clicking `Sleep session` calls `POST /api/workspaces/:id/sleep` through the web client and does not complete/cancel/archive the task.
- [x] A sleeping conversation keeps the composer visible and shows `Archive conversation` as the center lifecycle action.
- [x] Clicking `Archive conversation` while sleeping still opens the destructive confirmation dialog before the archive callback runs.
- [x] Working sessions still show the immediate Stop/Interrupt action and do not show sleep/archive confirmation first.
- [x] Task-mode idle sessions keep their existing no-dock behavior unless they are actively working.
- [x] The existing backend sleep gate remains the authority for idleness and harness-work safety; the frontend does not invent a weaker idle predicate.
- [x] Mobile and desktop Playwright screenshots show no clipping, overlap, or horizontal overflow for Sleep, Archive, and working states.

## Validation Evidence

- Focused lifecycle/API unit coverage: `pnpm --filter @simple-agent-manager/web test -- tests/unit/lib/workspaces-api.test.ts tests/unit/components/CompletionDock.test.tsx tests/unit/components/project-message-view.test.tsx tests/unit/pages/project-chat.test.tsx tests/unit/components/chat/project-message-view-resume.test.tsx` — 5 files / 133 tests passed before Phase 5 review; expanded after review to cover Sleep loading/failure and ProjectChat missing-workspace/rejected-sleep paths.
- Local UI visual audit: `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/completion-dock-audit.spec.ts --project="iPhone SE (375x667)" --project="Desktop (1280x800)"` — mobile and desktop screenshots captured under `.codex/tmp/playwright-screenshots/` for Sleep, Archive confirmation, and working states.
- Full local quality suite: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — exit 0 after the direct sleep client coverage was added. Remaining output was known baseline lint/template/sourcemap warnings.
- Phase 5 review follow-ups added durable vertical-slice evidence: Playwright now clicks the real `Sleep session` button in the real project chat UI and asserts `POST /api/workspaces/ws-1/sleep`; API route coverage verifies `POST /api/workspaces/:id/sleep` auth middleware, same-user ownership gate, and `sleepWorkspaceSession()` delegation payload.

## References

- `apps/web/src/components/project-message-view/CompletionDock.tsx`
- `apps/web/src/components/project-message-view/index.tsx`
- `apps/web/src/pages/project-chat/useProjectChatState.ts`
- `apps/web/src/lib/api/workspaces.ts`
- `apps/api/src/routes/workspaces/lifecycle.ts`
- `apps/api/src/services/session-sleep.ts`
- `apps/www/src/content/docs/docs/guides/instant-sessions.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/14-do-workflow-persistence.md`
