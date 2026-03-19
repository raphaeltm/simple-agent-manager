# Ideas Page and Ideation System

**Created**: 2026-03-19
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Large
**Origin**: Brainstorming session on task UX/UI redesign (session `ab65c5e4`, task `01KM27SG248RVMHYTF96HK8SKB`)

## Summary

Replace the current tasks page (which is unusable — overflows on mobile, exposes raw data, kanban view is inaccessible) with a ground-up "Ideas" page. An idea is the user-facing concept for what is currently a `draft` task — something you want to explore, brainstorm, and eventually execute. The current tasks page should be either completely redesigned or removed and rebuilt.

## Problem Statement

The current tasks page is a direct exposure of the underlying task data model. It shows statuses, IDs, execution steps — none of which help a user think about what they want to build. The kanban board exists in code but is either hidden or unfindable. On mobile it overflows wildly. It's not a tool for thinking; it's a database viewer.

Meanwhile, the *actual* workflow for ideation happens outside SAM entirely — in `tasks/backlog/` markdown files in the repo. Users write up ideas as markdown, brainstorm them in conversation-mode sessions, and then run `/do` against the markdown file when ready. This works but is invisible to SAM's UI and loses the connection between brainstorming sessions and the ideas they explored.

## Core Concept: Ideas, Not Tasks

The user-facing mental model should be:

- **Ideas** — things you might want to build, explore, or investigate
- **Brainstorming** — conversations where you explore an idea with an agent (prototyping UI, researching approaches, talking through architecture)
- **Execution** — when an idea is ready, send an agent to make it real

"Task" is an implementation detail. The user thinks in ideas.

## Data Architecture

No new data types needed. An idea maps to the existing `tasks` table:

| Concept | Implementation |
|---------|---------------|
| Idea | Task with `status: 'draft'` |
| Idea title/description | `tasks.title`, `tasks.description` (may need to be added/expanded) |
| Brainstorming sessions | Multiple `chat_sessions` linked via `task_id` (currently 1:1, needs to become 1:N in practice) |
| Promotion to execution | Status transition from `draft` → `ready` → normal task execution flow |
| Execution session | Another `chat_session` linked to the same task, but in task mode |

### Key Schema Change

The current system assumes one task → one chat session. This needs to become one task → many chat sessions. The database schema already supports this (chat_sessions has a `task_id` FK with no uniqueness constraint), but the task runner and UI assume 1:1. Changes needed:

- Task runner creates a new session for execution without conflicting with existing brainstorming sessions
- UI shows all sessions associated with an idea, distinguishing brainstorming from execution
- Project chat list tags sessions with their associated idea

## UX Design

### The Ideas Page

A dedicated page in the project sidebar navigation. Ground-up design, not a reskin of the tasks page.

Core requirements:
- **Search and filter** — find ideas by text, status, date
- **Idea cards** — each idea shows title, description snippet, number of brainstorming sessions, status
- **Status groups** — exploring (draft), ready, executing (in_progress), done (completed), parked
- **New Idea action** — lightweight: just a title and optional description. No forms with dropdowns for VM size and priority.
- **Brainstorm action** — spins up a lightweight conversation-mode workspace session attached to the idea
- **Execute action** — promotes the idea to ready and triggers execution (agent selection, etc.)
- **Mobile-first** — must work well on mobile. The current tasks page is the cautionary tale.

### Integration with Project Chat

Brainstorming sessions should appear in the project chat list but be visually tagged:
- Show which idea the session belongs to
- Clicking the idea tag navigates to the idea on the Ideas page
- The idea's detail view links back to all its chat sessions

### What to Do with the Current Tasks Page

Options (to be decided during implementation):
1. **Replace entirely** — the Ideas page IS the new tasks page
2. **Hide execution details** — keep a minimal "running tasks" view somewhere (maybe a section on the Ideas page showing ideas currently executing) but remove the raw task list/kanban
3. **Admin-only** — move the raw task view to the admin section for debugging

Recommendation: Option 1. The Ideas page shows ideas in all states. "Executing" is just a state an idea can be in, shown inline. No separate tasks page needed.

## Artifacts from Brainstorming Sessions

During brainstorming, agents can produce artifacts — Playwright screenshots, running UI prototypes (via port forwarding), code experiments. Currently these exist only in the workspace filesystem and chat history. Future enhancement: first-class artifact attachment to ideas (screenshots, links, files). Not required for v1, but the architecture should not preclude it.

## What This Is NOT

- Not a project management tool (no sprints, no story points, no burndown charts)
- Not a Kanban board (the kanban metaphor doesn't fit ideation)
- Not a task scheduler (that's the task runner's job internally)
- Not a serverless chat mode (brainstorming uses real VM workspaces, keeping the ability to run code, spin up UIs, use Docker)

## Acceptance Criteria

- [ ] New Ideas page accessible from project sidebar navigation
- [ ] Ideas can be created with title and description (lightweight action)
- [ ] Ideas list supports search and filtering
- [ ] Ideas show their associated brainstorming sessions
- [ ] "Brainstorm" action on an idea starts a conversation-mode session linked to that idea
- [ ] "Execute" action promotes an idea to execution
- [ ] Multiple chat sessions can be associated with a single task/idea
- [ ] Project chat list visually tags sessions belonging to ideas
- [ ] Works well on mobile
- [ ] Current raw tasks page is replaced or hidden
- [ ] No new database tables needed — builds on existing task + chat_session schema

## Open Questions

- How does the description/spec for an idea evolve across brainstorming sessions? Does the system auto-summarize conversations into an updated idea description?
- Should there be a "notes" or "scratchpad" field on an idea that accumulates context across sessions?
- When promoting to execution, should the brainstorming history be injected into the executing agent's context? How much?
- How does this interact with the MCP `dispatch_task` flow? An agent brainstorming an idea might want to kick off execution directly.

## Related

- `tasks/backlog/2026-03-19-graph-execution-model.md` — longer-term task decomposition and graph execution
- `tasks/backlog/2026-03-18-code-context-for-task-submission.md` — complementary: how context flows into task submission
- `tasks/backlog/2026-03-09-quick-chat-mode-design.md` — serverless chat was considered and deferred in favor of VM-backed brainstorming
