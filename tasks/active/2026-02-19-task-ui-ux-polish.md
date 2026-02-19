# Task: Task UI/UX Polish

**Date:** 2026-02-19
**Branch:** feat/task-ui-ux-fixes
**Status:** in_progress

## Summary

Fix critical bug and UX gaps in the task management UI before delegation/execution features are built.

## Checklist

- [ ] Add task statuses to StatusBadge (draft/ready/queued/delegated/in_progress/completed/failed/cancelled)
- [ ] Fix TaskDelegateDialog: use shared Dialog component, add empty state for no running workspaces
- [ ] Improve TaskDetailPanel: add loading spinner, format timestamps, use StatusBadge for status field
- [x] Replace raw task count text in Project.tsx with styled badge pills

## Issues Being Fixed

1. **CRITICAL** StatusBadge missing all task statuses — all tasks render as "Unknown" with no color
2. TaskDelegateDialog uses raw div instead of shared Dialog (no Escape key, no focus lock)
3. TaskDelegateDialog shows empty select with no message when no workspaces running
4. TaskDetailPanel shows stale data with no loading indicator when switching tasks
5. Task counts in Project.tsx are raw text, hard to scan
6. TaskDetailPanel shows raw ISO timestamps
7. TaskDetailPanel shows raw status string instead of StatusBadge
