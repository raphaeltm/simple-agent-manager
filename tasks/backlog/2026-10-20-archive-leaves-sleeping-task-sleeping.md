# Archiving a sleeping chat leaves its task "sleeping"

## Problem

Stopping (archiving) a chat whose session is already asleep stops the chat and deletes its
workspace, but leaves the backing task's status at `sleeping` indefinitely.

`stopTaskBackedSession` (`apps/api/src/routes/chat-stop.ts`) treats a task as terminal only when it
is `completed`, `failed` or `cancelled` (`getTerminalTaskStatus`), and otherwise cancels it through
`cancelExecutableTaskForArchive`. That function returns early unless the status is one of
`TASK_EXECUTION_STATUSES` (`queued`, `delegated`, `in_progress` in
`apps/api/src/services/task-status.ts`). `sleeping` is in neither list, so the task row is never
updated. This is the shape `.claude/rules/79-new-enum-values-audit-every-denylist.md` warns about:
`sleeping` was added to `TASK_STATUSES` and this allowlist was not revisited.

## Context

Found on staging on 2026-10-20 while cleaning up the shared-session teammate-controls E2E run
(PR #2383). Chat `1cdf29f2-7216-4b6e-bc6c-8b1e798777a6` (VM) went to sleep after 15 idle minutes;
the cleanup's `POST /sessions/:id/stop` then stopped the chat (session `stopped`), deleted workspace
`01M5BZ3PCRCJ6MYAMEFE7WKYS8` and its node, but task `01M5BYX0A22F5ARZE422XKJ0B9` stayed `sleeping`
(last updated 06:36:35 UTC, before the stop). The four other test chats, which were awake when
stopped, got `cancelled` tasks as expected. No snapshot, workspace or node is held; only the task
row's status is wrong.

## Acceptance Criteria

- [ ] Archiving a chat whose task is `sleeping` leaves the task `cancelled` with an "Archived by
      user" status event, through the real stop route
- [ ] A test drives the real sleep transition (not a seeded status) and fails before the fix
- [ ] Every other allowlist and denylist over task statuses used by archive and stop is checked for
      `sleeping` and listed in the PR
