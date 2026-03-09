# Mobile UX Exploratory Testing

**Date**: 2026-03-09
**Viewport**: 390x844 (iPhone 14 Pro)
**Goal**: Simulate a real developer using SAM on mobile — submit tasks, use project chat, workspace chat, follow up on agents, stress-test workflows.

## Findings

### Dashboard

1. **OK**: Dashboard loads correctly on mobile. Welcome message, Active Tasks section, Projects list all visible.
2. **OK**: "Import Project" button positioned well next to "Projects" heading.
3. **OK**: Project card shows "active" badge, name, stats (0 ws, 6 sessions), repo info, and action menu button.

### Navigation

4. **BUG [Medium]**: Mobile nav menu does not have a backdrop overlay. Underlying page content is visible behind the menu on the left side, making it feel unfinished. The menu slides in from the right but leaves the left edge of the page visible.
   - **Repro**: Tap hamburger menu on any page.
   - **Screenshot**: `mobile-nav-menu.png`

5. **MINOR**: User email is truncated in the nav menu header (`raphael+serverspresentation@e...`). No tooltip or way to see the full email.

### Chat List

6. **BUG [High]**: ALL chat sessions show "Active" status with green dot regardless of actual state. Failed tasks, stale 4-day-old tasks with no workspace, and genuinely active tasks are all indistinguishable. Status should reflect actual state: Failed, Completed, Idle, Provisioning, Running.
   - **Repro**: Open chat list — all 8 sessions show identical "Active" badge.
   - **Screenshot**: `mobile-chat-list-with-new-tasks.png`

7. **BUG [Medium]**: Second chat title renders raw markdown: `**README.md** # Task Title Generator`. The title generation or display does not strip/parse markdown formatting.
   - **Repro**: Open chat list, look at second entry.
   - **Screenshot**: `mobile-chat-list-sidebar.png`

### Chat Session View

8. **BUG [Medium]**: Failed task error message is duplicated — shown both as orange text banner below session header AND as a "SYSTEM" message in the chat body. Same error message appears twice.
   - **Repro**: Open the "Hello, can you list the files..." chat session.
   - **Screenshot**: `mobile-chat-session-failed.png`

9. **BUG [Low]**: Error messages expose raw VM IDs (`vm-01kjy82pfm57fwtn5822wyn7vv`) which are meaningless to developers. Should show human-friendly error messages (e.g., "Server provisioning failed — please try again").
   - **Repro**: Open any failed chat session.

10. **BUG [Medium]**: Console error for `/api/terminal/token` fires when viewing a chat session with no active workspace. Unnecessary network request that returns 401/404.
    - **Repro**: Navigate to any failed/stale chat session, check console.

11. **MINOR**: Session details branch name (`sam/hello-list-files-repository-01kjy8`) is truncated with no way to see the full name. No tooltip or copy button.

12. **MINOR**: "Open Workspace" button shown for workspaces that no longer exist (failed provisioning). Clicking it would lead to a 404 or error state.

### Task Submission

13. **OK**: Task submission works correctly. Type description, press Send or Enter, task starts provisioning.

14. **UX [Medium]**: Text input area at the bottom is very small on mobile (~2 lines visible). The beginning of longer messages is cut off with no scroll indication. No auto-grow behavior. Developers writing detailed task descriptions are frustrated by this.
    - **Screenshot**: `mobile-task-input-filled.png`

15. **OK**: AI-generated task titles work well. "Check the package.json for outdated dependencies..." was titled "List outdated dependencies in package.json" — concise and accurate.

### Multi-Task Workflows

16. **UX [High]**: No way to see multiple tasks provisioning simultaneously. The provisioning status bar only shows the currently-viewed chat's progress. A developer who fires off 3 tasks has to manually switch between chats to check each one. Need a task queue/dashboard showing all active task statuses.
    - **Repro**: Submit 2 tasks, switch between them in chat list.

17. **BUG [Medium]**: Provisioning timer resets when navigating between chat sessions. After submitting task 1, switching to task 2 and back, task 1's timer shows "1s" instead of actual elapsed time. Timer appears to be relative to component mount, not task creation time.
    - **Screenshot**: `mobile-first-task-still-provisioning.png`

### Project Settings (Drawer)

18. **OK**: Settings drawer is well-organized with node size selector, env vars, runtime files, and project views sections.

19. **UX [Low]**: Env var Key/Value inputs are on one row, very cramped at 390px. Would benefit from stacking vertically on mobile.

20. **MINOR**: Placeholder text in env var inputs (`API_TOKEN`, `Value`) could be confused with actual values. Need clearer visual distinction.

### Workspace Chat

*(Testing in progress — waiting for tasks to finish provisioning)*

### Agent Follow-ups

*(Testing in progress — waiting for agents to complete)*

### Performance

*(Testing in progress)*

## Acceptance Criteria

- [ ] All major mobile UX issues documented with screenshots and reproduction steps
- [ ] Performance bottlenecks identified
- [ ] Missing developer workflows noted
- [ ] All findings triaged by severity
