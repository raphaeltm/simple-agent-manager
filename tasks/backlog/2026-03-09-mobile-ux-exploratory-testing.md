# Mobile UX Exploratory Testing

**Date**: 2026-03-09
**Viewport**: 390x844 (iPhone 14 Pro)
**Goal**: Simulate a real developer using SAM on mobile — submit tasks, use project chat, workspace chat, follow up on agents, stress-test workflows.

## Summary

Tested the complete developer workflow on mobile: login, dashboard, project chat, task submission (2 concurrent tasks), multi-turn follow-up conversations, workspace view (terminal, file browser, git changes), nodes management, and settings. Found **30+ issues** ranging from critical rendering bugs to minor UX polish items.

### Critical Issues (High Priority)

| # | Category | Issue | Severity |
|---|----------|-------|----------|
| 6 | Chat List | All sessions show "Active" status regardless of actual state (failed, completed, idle) | HIGH |
| 16 | Multi-Task | No way to see multiple tasks' provisioning status simultaneously | HIGH |
| 28/42 | Chat Rendering | Every message in a conversation is rendered TWICE (systematic duplication) | HIGH |
| 44 | Tool Display | Project chat shows "tool tool" for all tool calls; workspace view shows correct names | HIGH |

### Medium Issues

| # | Category | Issue | Severity |
|---|----------|-------|----------|
| 4 | Navigation | Nav menu has no backdrop overlay; page content visible behind | MEDIUM |
| 7 | Chat List | Raw markdown in chat title (`**README.md** # Task Title...`) | MEDIUM |
| 8 | Chat Session | Failed task error message duplicated (banner + system message) | MEDIUM |
| 10 | Chat Session | Console error for `/api/terminal/token` on sessions with no workspace | MEDIUM |
| 14 | Task Input | Text input area too small on mobile (~2 lines), no auto-grow | MEDIUM |
| 17 | Provisioning | Timer resets when navigating between chat sessions | MEDIUM |
| 22 | Provisioning | No cancel button during server provisioning (only during agent execution) | MEDIUM |
| 23 | Chat Session | "Agent offline" banner shows after agent completed successfully | MEDIUM |
| 25 | Chat Rendering | Tool blocks show "tool tool" labels instead of actual tool names | MEDIUM |
| 29 | Chat Rendering | Tool blocks show "tool tool" collapsed; only show names during live streaming | MEDIUM |
| 31 | Chat List | Message count only shows user messages, not total conversation messages | MEDIUM |
| 36 | Chat Rendering | Tool name display inconsistent — works during streaming, degrades on re-render | MEDIUM |
| 46 | Workspace Header | Header extremely cramped on mobile — name truncated to 2 chars | MEDIUM |
| 53 | Dashboard | Task cards show redundant "In Progress" AND "Active" badges | MEDIUM |
| 54 | Dashboard | Task cards show "In Progress" after agents have completed | MEDIUM |
| 57 | Nodes | Workspaces show "Recovery" status after agents finish normally | MEDIUM |

### Low/Minor Issues

| # | Category | Issue | Severity |
|---|----------|-------|----------|
| 5 | Navigation | User email truncated, no tooltip | LOW |
| 9 | Chat Session | Error messages expose raw VM IDs | LOW |
| 11 | Chat Session | Branch name truncated, no copy/tooltip | LOW |
| 12 | Chat Session | "Open Workspace" shown for non-existent workspaces | LOW |
| 19 | Settings | Env var Key/Value inputs cramped on one row | LOW |
| 20 | Settings | Placeholder text confused with actual values | LOW |
| 30 | Chat Rendering | Expanded tool blocks only list tool names, no input/output | LOW |
| 33 | Chat Session | "Connecting to agent..." spinner after agent already finished | LOW |
| 55 | Dashboard | "0 ws" on project card despite workspaces existing | LOW |
| 58 | Nodes | Node names auto-truncated from task titles, not useful | LOW |
| 59 | Settings | Last settings tab truncated, no scroll indicator | LOW |
| 62 | Settings | "Save Credential" button shown when input empty | LOW |
| 63 | Nodes | Node deletion has no confirmation dialog | LOW |

## Detailed Findings

### Dashboard

1. **OK**: Dashboard loads correctly on mobile. Welcome message, Active Tasks section, Projects list all visible.
2. **OK**: "Import Project" button positioned well next to "Projects" heading.
3. **OK**: Project card shows "active" badge, name, stats, repo info, and action menu button.
52. **OK**: Active Tasks section shows task cards with useful timing info (submitted ago, last msg ago).
53. **BUG [Medium]**: Task cards show BOTH "In Progress" and "Active" badges — redundant.
54. **BUG [Medium]**: Task cards show "In Progress" after agents have completed their work. Status not updated.
55. **BUG [Low]**: Project card shows "0 ws" despite workspaces existing.

### Navigation

4. **BUG [Medium]**: Mobile nav menu has no backdrop overlay. Page content visible on the left side behind the slide-over panel.
   - **Screenshot**: `mobile-nav-menu.png`
5. **MINOR**: User email truncated in nav menu header. No tooltip or way to see the full email.

### Chat List

6. **BUG [High]**: ALL chat sessions show "Active" status with green dot regardless of actual state. Failed tasks, stale 4-day-old tasks, and genuinely active tasks are all indistinguishable.
   - **Repro**: Open chat list — all sessions show identical "Active" badge.
   - **Screenshot**: `mobile-chat-list-with-new-tasks.png`
7. **BUG [Medium]**: Chat title renders raw markdown: `**README.md** # Task Title Generator`.
   - **Screenshot**: `mobile-chat-list-sidebar.png`
31. **BUG [Medium]**: Chat list shows "1 msg" for sessions with multiple messages (counts only user msgs).

### Chat Session View

8. **BUG [Medium]**: Failed task error message duplicated — orange banner AND system message in chat body.
   - **Screenshot**: `mobile-chat-session-failed.png`
9. **BUG [Low]**: Error messages expose raw VM IDs (`vm-01kjy82pfm57fwtn5822wyn7vv`). Should be human-friendly.
10. **BUG [Medium]**: Console error for `/api/terminal/token` on sessions with no active workspace.
11. **MINOR**: Branch name truncated, no tooltip or copy button.
12. **MINOR**: "Open Workspace" button shown for non-existent workspaces.
23. **BUG [Medium]**: "Agent offline" banner shown after agent completed work. Should say "Completed" or not appear.
33. **BUG [Low]**: "Connecting to agent..." spinner shown after agent has already finished.

### Chat Message Rendering (Systematic Bug)

28. **BUG [High]**: User messages rendered TWICE — once before SYSTEM message and once after. Confirmed systematic.
   - **Screenshot**: `mobile-expanded-thought-tool.png`
42. **BUG [High — Confirmed]**: ALL messages (user, system, agent) are duplicated in the DOM:
   - Initial user message: rendered at 2 different DOM positions
   - Follow-up messages: each rendered twice
   - Agent response text: each rendered twice
   - Affects every message in every turn of the conversation.

### Tool Display (Systematic Bug)

25. **BUG [Medium]**: Tool blocks in collapsed state show generic "tool tool" instead of tool names.
29. **BUG [Medium]**: When expanded, tool blocks show "Tool: Glob\nTool: Read" but collapsed says "tool tool".
36. **BUG [Medium]**: During LIVE STREAMING, tool blocks show correct names ("bun outdated execute", "npm outdated execute"). But after page re-render/reload, they degrade to "tool tool".
44. **BUG [High]**: Project chat and Workspace view render the SAME tool calls differently:
   - **Workspace view**: "ToolSearch other", "Read package.json read", "Find `**/package.json` search" (CORRECT)
   - **Project chat**: "tool tool", "tool tool", "tool tool" (BROKEN)
   - This means the tool name data IS available, but the project chat rendering pipeline loses it.

### Task Submission & Provisioning

13. **OK**: Task submission works — type, send, task starts provisioning.
14. **UX [Medium]**: Text input area very small on mobile (~2 lines), no auto-grow for longer descriptions.
   - **Screenshot**: `mobile-task-input-filled.png`
15. **OK**: AI-generated task titles work well and are concise.
16. **UX [High]**: No way to see multiple tasks provisioning simultaneously. Must switch between chats.
17. **BUG [Medium]**: Provisioning timer resets on navigation between sessions (relative to component mount, not creation time).
22. **UX [Medium]**: 3+ minute provisioning wait with no cancel button, no ETA, no additional context. Cancel button only appears during agent execution, not during server provisioning.

### Multi-Turn Conversations

34. **OK**: Follow-up messages work correctly. Agent receives context from prior turns.
35. **OK**: Cancel button appears during agent execution.
37. **OK**: Streaming typing indicator (bouncing dots) works well.
40. **OK**: Multi-turn conversation flow is natural (3 turns tested successfully).
41. **Note**: Message duplication pattern: first messages in a session are always duplicated; later messages vary.

### Workspace View

43. **OK**: Tabbed interface (Task, Chat, Terminal) works well on mobile.
44. See above — tool display is much better in workspace view vs project chat.
45. **OK**: Workspace header shows status badge, settings, and cancel buttons.
46. **UX [Medium]**: Header cramped on mobile — workspace name truncated to ~2 characters ("T...").
47. **OK**: Terminal works great — colored output, commands execute, responsive.
49. **OK**: File browser is excellent on mobile — clean layout, folder icons, file sizes.
50. **OK**: File viewer renders markdown beautifully with Rendered/Source toggle.
51. **OK**: Git changes panel works cleanly.

### Project Settings (Drawer)

18. **OK**: Well-organized with node size selector, env vars, runtime files, project views.
19. **UX [Low]**: Env var Key/Value inputs cramped on one row at 390px.
20. **MINOR**: Placeholder text could be confused with actual values.

### Settings Pages

59. **UX [Low]**: Last settings tab truncated, no scroll indicator for horizontal tab bar.
60. **OK**: Cloud Provider settings clean and functional.
61. **OK**: Agent Keys page well laid out.
62. **UX [Low]**: "Save Credential" button shown when input is empty and disabled.

### Nodes Management

56. **OK**: Nodes view shows great detail — status, specs, location, resource usage, workspace list.
57. **BUG [Medium]**: Workspaces show "Recovery" status after agents finish normally.
58. **UX [Low]**: Node names auto-generated from task titles and truncated.
63. **BUG [Low]**: Node deletion has no confirmation dialog — destructive action too easy.
64. **OK**: Empty state is clean and informative.

### Performance

- Dashboard loads quickly (<2s)
- Chat list loads quickly
- Server provisioning takes 3-5 minutes (Hetzner VM + devcontainer setup)
- Agent responses stream in real-time with visible progress
- Terminal is responsive with no noticeable lag
- File browser loads quickly
- No performance issues observed during normal usage

## Recommendations (Priority Order)

1. **Fix message duplication bug** — every message renders twice. This is the most visible and impactful bug.
2. **Fix tool name display in project chat** — use the same rendering pipeline as workspace view.
3. **Add proper session status** — replace universal "Active" with actual states (Provisioning, Running, Completed, Failed, Idle).
4. **Add multi-task status overview** — dashboard Active Tasks is a start, but need real-time provisioning status for all tasks.
5. **Add cancel button during provisioning** — developers need a way to abort stuck provisioning.
6. **Add nav menu backdrop** — standard mobile UX pattern.
7. **Auto-grow text input** — critical for mobile task descriptions.
8. **Fix timer reset on navigation** — use creation timestamp, not component mount time.

## Test Cleanup

- Both test nodes deleted after testing
- 2 new chat sessions created (will persist in project history)

## Acceptance Criteria

- [x] All major mobile UX issues documented with screenshots and reproduction steps
- [x] Performance bottlenecks identified (none found — performance is good)
- [x] Missing developer workflows noted (multi-task overview, cancel during provisioning)
- [x] All findings triaged by severity (High: 4, Medium: 16, Low/Minor: 13)
