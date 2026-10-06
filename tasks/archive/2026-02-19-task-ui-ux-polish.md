# Task: Task UI/UX Polish

**Date:** 2026-02-19
**Branch:** feat/task-ui-ux-fixes
**Status:** in_progress

## Summary

Fix critical bug and UX gaps in the task management UI before delegation/execution features are built.

## Checklist

- [x] Add task statuses to StatusBadge (draft/ready/queued/delegated/in_progress/completed/failed/cancelled)
- [x] Fix TaskDelegateDialog: use shared Dialog component, add empty state for no running workspaces
- [x] Improve TaskDetailPanel: add loading spinner, format timestamps, use StatusBadge for status field
- [x] Replace raw task count text in Project.tsx with styled badge pills

## Issues Being Fixed

1. **CRITICAL** StatusBadge missing all task statuses — all tasks render as "Unknown" with no color
2. TaskDelegateDialog uses raw div instead of shared Dialog (no Escape key, no focus lock)
3. TaskDelegateDialog shows empty select with no message when no workspaces running
4. TaskDetailPanel shows stale data with no loading indicator when switching tasks
5. Task counts in Project.tsx are raw text, hard to scan
6. TaskDetailPanel shows raw ISO timestamps
7. TaskDetailPanel shows raw status string instead of StatusBadge

---

## Reconciliation — 2026-09-23 (weekly queue audit)

**Closed. All four items verified against `main`, one by one — nothing here is still open.**

The first pass of this audit demoted the file to `tasks/backlog/` on the assumption that the
`TaskDelegateDialog` item was outstanding. A task-completion validator challenged that, and
re-checking each item individually proved the demotion wrong:

| #   | Item                                                    | Evidence in `main`                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Task statuses on `StatusBadge`                          | `packages/ui/src/components/StatusBadge.tsx:61-62` has `queued` and `delegated`                                                                                                                                                                |
| 2   | `TaskDelegateDialog` uses shared `Dialog` + empty state | `apps/web/src/components/project/TaskDelegateDialog.tsx:2` imports `Dialog` from `@simple-agent-manager/ui`, line 41 wraps in `<Dialog isOpen … maxWidth="md">`, line 65 renders "No running workspaces. Start a workspace first."             |
| 3   | Improve `TaskDetailPanel`                               | **Moot.** `TaskDetailPanel.tsx` was built in `f97c1edcc` and deleted one commit later in `7f424319a` ("finalize project task redesign"). Task detail now renders through `TaskList`/`ProjectTasks.tsx`; there is no such component to improve. |
| 4   | Badge pills for task counts                             | already checked when the file was written                                                                                                                                                                                                      |

Item 3 is ticked to mean "resolved", not "built" — the component it targeted has not existed
for seven months, so leaving it open would send a future agent hunting for a deleted file.

One live caveat that is **not** this task's work: `TaskDelegateDialog` is still wired into
`ProjectTasks.tsx`, while policy `65c2ac35` says not to expose a manual
task-to-running-workspace delegation modal in normal user flows. That is a product decision
about whether the control should be reachable, not the UI-polish work tracked here.
