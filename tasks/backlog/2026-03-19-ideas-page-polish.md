# Ideas Page Polish Items

**Created**: 2026-03-19
**Source**: UI/UX specialist review of PR #458

## Problem

Several non-blocking UX improvements identified during the Ideas page review that should be addressed in a follow-up.

## Items

### 1. Delete idea has no confirmation guard
- `handleDelete` in `IdeasPage.tsx` calls the destructive API immediately on click
- Add a `window.confirm` or inline undo toast to prevent accidental deletions

### 2. TaskDetail breadcrumbs under ideas route
- `handleIdeaClick` navigates to `/projects/:id/ideas/:taskId` which renders `TaskDetail`
- Verify `TaskDetail` page title and breadcrumbs don't say "Task" when accessed from ideas context

### 3. Session idea-tag overflow in narrow drawers
- The idea tag in `ProjectChat` sidebar uses `whitespace-nowrap` + `overflow-hidden text-ellipsis`
- `max-w-full` on the tag inside a flex parent could still cause overflow in very narrow mobile drawers
- Low priority

### 4. Native select styling inconsistency
- Status filter `<select>` ignores most custom styling on Windows/Android Chrome
- Consider a custom dropdown component if consistent styling is important

## Acceptance Criteria

- [ ] Delete action shows confirmation before proceeding
- [ ] TaskDetail renders appropriate context (Ideas vs Tasks) based on route
- [ ] Idea tags don't overflow in narrow mobile drawers
- [ ] Status filter appearance is acceptable cross-platform (or custom dropdown implemented)
