# Session Header Enhancements

## Problem Statement

The project chat session header (SessionHeader.tsx) needs enhanced information display:
1. Copyable reference ID pills for Task, Session, Workspace, and ACP Session IDs
2. Task execution step display showing current runner phase
3. Task status badge with color coding
4. Session timing (start time + running duration)

Users need to quickly access and copy reference IDs for debugging and cross-referencing, and see at-a-glance task status and timing.

## Research Findings

- **Prototype built** on branch `sam/use-sam-mcp-tools-01kpza` with 4 commits
- Implementation already in `SessionHeader.tsx` with:
  - `CopyableId` component (click-to-copy pill with truncated display)
  - `formatDuration`, `formatTime`, `formatExecutionStep` helpers
  - Reference IDs section with Hash/Tag icons
  - Task execution step + status badge + timing in expanded panel
- **Prototype page** at `apps/web/src/pages/SessionHeaderPrototype.tsx` and route at `/__test/session-header` — must be removed before merge
- **Existing tests failing** (17/23) because lucide-react mock missing new icons: Hash, Copy, Tag, Timer, Clock, RotateCcw, GitFork
- Knowledge directive: user prefers copyable values and MCP reference ID surfaced prominently

## Implementation Checklist

- [x] CopyableId component with click-to-copy
- [x] Reference IDs section (Task, Session, Workspace, ACP)
- [x] Task execution step display
- [x] Task status badge with color coding
- [x] Session timing (started + duration)
- [ ] Fix existing test failures (add missing icons to lucide-react mock)
- [ ] Add unit tests for CopyableId, reference IDs, timing display
- [ ] Run Playwright visual audit (mandatory for UI changes)
- [ ] Remove prototype page (SessionHeaderPrototype.tsx + route in App.tsx) before merge

## Acceptance Criteria

- [ ] CopyableId pills render for Task, Session, Workspace, and ACP Session IDs when available
- [ ] Clicking a CopyableId copies the full value to clipboard and shows checkmark feedback
- [ ] Task execution step shows current phase when task is in_progress
- [ ] Task status badge shows with appropriate color coding (success/danger/accent/muted)
- [ ] Session timing shows start time and running/completed duration
- [ ] Prototype page removed — no `/__test/session-header` route or `SessionHeaderPrototype.tsx`
- [ ] All existing session header tests pass
- [ ] New behavioral tests for CopyableId, reference IDs, and timing
- [ ] No horizontal overflow on mobile (375px) or desktop (1280px)
