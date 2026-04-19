# Nested Chat Sidebar — Support Deeply Nested Sessions

**Task ID**: 01KPH47ZT7GHX5PC7CEG1DWXE9
**Output branch**: `sam/sidebar-menu-project-chat-01kph4`

## Problem

The project chat sidebar currently only groups sessions at one level of nesting (a parent task and its direct children). It breaks down in two related ways:

1. **Depth ≥ 2 is unsupported.** A grandchild session (child of a child task) is never grouped under its ancestor. It falls through to the standalone render path with no visual indication of lineage.
2. **Stale ancestors hide descendants.** When a parent or grandparent session is stopped and stale (no activity in 3+ hours), it is filtered into the collapsed "Older" section. Because the grouping algorithm only groups a child with a parent that is present in the current rendered list (`taskToSession.has(info.parentTaskId)` in `useTaskGroups.ts:89`), the descendant is either orphaned into a disconnected standalone row or — if the user has a lot of recent noise — visually lost entirely.

Real-world repro: the user has a grandchild session they are actively working in. Its parent task and grandparent task both have stopped/stale sessions. The session is either invisible to them or appears disconnected from its lineage.

The system technically supports unlimited task nesting depth (`dispatch_task` and `parentTaskId` schema have no depth cap beyond `MAX_DISPATCH_DEPTH`), so the UI must handle **arbitrary depth**.

## Research Findings

### Current architecture

- Sessions are loaded flat via `GET /api/projects/:id/sessions` (`apps/api/src/durable-objects/project-data/sessions.ts:119`). The API returns a flat list, no lineage.
- Tasks have `parentTaskId` (n-level nesting supported). `ChatSession` has only `taskId`. Grouping is derived client-side via tasks.
- Frontend grouping: `apps/web/src/pages/project-chat/useTaskGroups.ts` — `groupSessions()` builds a **single level** of grouping. A child's parent must be in the same input list, otherwise the child becomes standalone. There is no recursion.
- Rendering: `SessionList.tsx` → `TaskGroup.tsx`. `TaskGroup` renders parent + flat children. No recursion.
- Filtering: `useProjectChatState.ts:140-166` splits sessions into `recentSessions` and `staleSessions` via `isStaleSession()` (3-hour threshold, `chat-session-utils.ts:60`). Only `filteredRecent` is passed to the primary `SessionList`. Stale sessions go into a collapsed "Older" section.

### Root causes of the visible bug

1. `groupSessions()` is strictly one level deep (`useTaskGroups.ts:81-119`). Grandchildren fall to the standalone render branch.
2. When a parent session is in `filteredStale` but its grandchild is in `filteredRecent`, the `SessionList` that renders `filteredRecent` receives the grandchild without its parent context. `taskToSession.has(info.parentTaskId)` returns false, so the grandchild is not added to any group.
3. If the grandparent is also stale, the whole lineage collapses. The "Older" section only shows flat stale items — there is no connection drawn between the active leaf and its stopped ancestors.

### Prior art

Tree-rail / indent-with-vertical-line is the standard pattern for arbitrary-depth hierarchies in sidebars:
- VS Code file explorer, JetBrains Project view (indent + expand chevron).
- Reddit / HackerNews threaded comments (indent + tree rail).
- Notion page hierarchy (indent with subtle rail).
- Slack threaded replies (flat but with indicator — different model, not applicable here).

For mobile (375px-wide viewport — Raphaël's primary interaction surface), deep indent becomes problematic. Cap visible indent to ~4–5 levels and surface depth as a subtle badge beyond that. Alternatively, allow full indent but make the text clamp aggressively.

### Files / line numbers

| File | Lines | Purpose |
|---|---|---|
| `apps/web/src/pages/project-chat/useTaskGroups.ts` | 68–147 | `groupSessions()` — needs to become recursive |
| `apps/web/src/pages/project-chat/SessionList.tsx` | 34–94 | Switch on render-item type |
| `apps/web/src/pages/project-chat/TaskGroup.tsx` | 16–156 | Flat parent + children — needs to accept nested children recursively |
| `apps/web/src/pages/project-chat/useProjectChatState.ts` | 140–166 | Stale/recent split that breaks lineage |
| `apps/web/src/pages/project-chat/index.tsx` | 128–165 | Desktop sidebar render site |
| `apps/web/src/pages/project-chat/MobileSessionDrawer.tsx` | 39–63 | Mobile drawer — same issue |
| `apps/web/tests/unit/useTaskGroups.test.ts` | entire | Tests — currently only 1-level |

## Design

### Data shape: tree instead of flat

Replace `SessionRenderItem` (flat, single-level `group`/`standalone`) with a recursive tree node:

```ts
interface SessionTreeNode {
  session: ChatSessionResponse;
  children: SessionTreeNode[];
  /** Depth from the tree root (0 = root-level). */
  depth: number;
  /**
   * True if this node is a "context anchor" — a stale or otherwise-hidden
   * ancestor that we're including because it has a non-stale descendant.
   * Rendered dimmed so it's visually distinct from first-class recent sessions.
   */
  isContextAnchor: boolean;
  /** Aggregated progress across all descendants. */
  totalDescendants: number;
  completedDescendants: number;
}
```

`buildSessionTree(sessions, taskInfoMap, options)` walks the task hierarchy to build the forest, attaching sessions to their parent task's node when present.

### Lineage preservation — "context anchor" ancestors

When the input is `filteredRecent`, if any recent session's ancestors are NOT in `filteredRecent` but ARE in `sessions` (all loaded), include them as **context anchors** (dimmed, not individually selectable as primary). This produces a connected tree from leaves to roots.

Truly stale sessions with no recent descendants go into the "Older" section as their own (smaller) forest.

This keeps the user's mental model intact even when ancestors are stopped.

### Rendering — recursive tree

Replace `TaskGroup` with `SessionTreeItem` that renders:
- The session row (using existing `SessionItem` component).
- If `children.length > 0`, an expand/collapse chevron and a recursive children container with indent + green rail (matching current `TaskGroup` visual language).
- Depth-aware indent: 12px per level up to 4 levels; after that, continue to indent but add a small `+N` depth badge.
- Context-anchor rows dimmed (opacity ~0.7) and not highlighted on hover as strongly.

### Scope — what's NOT changing

- No backend/API changes. Grouping stays client-side.
- No schema changes. Task hierarchy and `parentTaskId` are already there.
- Keep the recent/stale split in the outer shell (Older section still exists) — just make the tree inside each section aware of lineage.
- Keep search behavior (auto-expand ancestors of matching nodes).

## Implementation Checklist

- [ ] **Phase A: Data model**
  - [ ] Add `SessionTreeNode` type to `useTaskGroups.ts` (or sibling file `sessionTree.ts`)
  - [ ] Implement `buildSessionTree(sessions, taskInfoMap, { allSessions })` that produces a forest with arbitrary depth
  - [ ] When `allSessions` is provided and differs from `sessions`, include ancestor "context anchors" for any leaf whose ancestors aren't in `sessions`
  - [ ] Aggregate `totalDescendants` / `completedDescendants` recursively across the subtree
  - [ ] Preserve input order at each level (roots ordered by session order in input; children ordered by session order)
  - [ ] Keep `groupHasMatchingChild` semantics — replace with `treeHasMatchingDescendant` (recursive)

- [ ] **Phase B: Rendering**
  - [ ] Create `SessionTreeItem` component that renders one node + recursive children with expand/collapse
  - [ ] Indent per-depth (12px/level) with a green rail matching current `TaskGroup` style
  - [ ] Dim context-anchor rows (opacity 0.7) and mark them as anchors in aria-label
  - [ ] Replace `SessionList` internals to render `SessionTreeNode[]`
  - [ ] Handle auto-expand when search matches a descendant (`treeHasMatchingDescendant`)
  - [ ] After ~4 levels, add a `+N` depth indicator instead of continuing visual indent for accessibility

- [ ] **Phase C: Stale / recent integration**
  - [ ] Pass `allSessions` into `SessionList` so tree can reach stale ancestors
  - [ ] Re-partition: recent-with-stale-ancestors lifts those ancestors as anchors; truly-stale (no recent descendants) stays in "Older"
  - [ ] Update desktop `index.tsx` and `MobileSessionDrawer.tsx` consumers

- [ ] **Phase D: Tests**
  - [ ] `buildSessionTree`: depth 0, 1, 2, 3, 5 cases
  - [ ] `buildSessionTree`: grandchild recent, parent+grandparent stale → anchors included, tree connected
  - [ ] `buildSessionTree`: sibling branches at depth 2
  - [ ] `buildSessionTree`: sessions with no task, mixed into hierarchy
  - [ ] `buildSessionTree`: orphan child (parent task not in any input) renders as root
  - [ ] `treeHasMatchingDescendant`: search matches through multiple levels
  - [ ] Component test: render a 3-level tree, expand/collapse, verify each level is accessible
  - [ ] Component test: context-anchor row is present but visually dimmed and labeled

- [ ] **Phase E: UI visual audit**
  - [ ] Playwright local screenshots at 375px and 1280px
  - [ ] Mock data scenarios: depth 0, depth 2, depth 4, depth 6 (stress), context-anchor case, mixed standalone + tree
  - [ ] Assert no horizontal overflow on 375px
  - [ ] Visual rail continuity at each depth

## Acceptance Criteria

1. Given sessions with task hierarchy depth ≥ 2, every session appears in the sidebar in its correct tree position, at arbitrary depth.
2. Given a recent (active) leaf whose parent/grandparent sessions are stale/stopped, the parent and grandparent appear as dimmed "context anchors" in the Recent tree above the leaf. The user can navigate from leaf to ancestor directly from the sidebar without expanding "Older".
3. Given a fully stale subtree (no recent descendants anywhere), it stays in "Older" as before (but rendered as a tree, not flat).
4. At 375px wide (mobile), trees of depth ≥ 5 do not cause horizontal overflow. Deep branches show a `+N` depth badge.
5. Search auto-expands any ancestor path needed to reveal matching descendants.
6. Expand/collapse state is per-node and preserved within a single session mount (no global reset on re-render).
7. All existing 1-level grouping behaviors continue to work identically (back-compat for the common case).

## References

- `.claude/rules/06-technical-patterns.md` — React interaction-effect analysis (useState vs useEffect for expand state)
- `.claude/rules/16-no-page-reload-on-mutation.md`
- `.claude/rules/17-ui-visual-testing.md` — Playwright visual audit requirements
- `.claude/rules/18-file-size-limits.md` — keep new files under 500 lines
- `.claude/rules/26-project-chat-first.md` — project chat is the primary UX
- User preference: mobile-first (375px is critical), minimize `useEffect` usage
- Existing `TaskGroup` visual language (green rail) should be preserved/extended
