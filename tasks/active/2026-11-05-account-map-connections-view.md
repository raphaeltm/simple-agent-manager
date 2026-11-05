# Account Map: replace the graph canvas with the "Connections" view

## Problem

The Account Map (`/account-map`) draws every project, node, workspace, chat, task and idea as one
auto-laid-out React Flow graph. With a real account (38 projects, 90 tasks) it collapses into a
thin, unreadable line (Raphaël's screenshot, 2026-11-05). He compared two prototypes and chose
direction B, "Connections" ("I like B better. It's more of a fun thing than a useful thing...
Ship it. Skip prod."). Library: `/design/account-map-prototypes-2026-11-05/`.

"Skip prod" is read as: no production feature testing after deploy (policy: never full production
tests). Normal gates (staging, review, PR, deploy monitoring) still apply.

## Research Findings

- Page: `apps/web/src/pages/AccountMap.tsx`; components in `apps/web/src/components/account-map/`
  (canvas, toolbar, empty state, 6 React Flow node types, animated edge, dagre layout,
  `useAccountMapData` hand-rolled loader, `useMapFilters`).
- Data: `GET /api/account-map` (`AccountMapResponse` in `apps/web/src/lib/api/projects.ts`):
  projects, nodes, workspaces (nodeId, projectId, chatSessionId), sessions (workspaceId, taskId),
  tasks (workspaceId, status, executionStep, agentActivityState), ideas, `relationships`
  (`idea_session` links ideas to chats), truncation flags, `ideaScan`, `activeOnly` param.
- No PR state or cost in the response: the shipped view must not show them (prototype did, from mock data).
- The old map shipped ideas with real idea links (`/projects/:id/ideas/:ideaId`, #2434). The new
  view keeps idea links (on chat rows and in the chat's path). Per-project idea counts were dropped:
  the API only returns ideas linked to visible chats, so a count would mislead.
- Rule 48/60: new or materially changed fetch surfaces use TanStack Query with identity-scoped keys
  (`useQueryScope`, `lib/query-options/*`).
- `/account-map` is not a full-bleed route: the page renders inside the shell's content pane and
  paints no background of its own (SAM Glass rule 80).
- Existing tests: `tests/unit/pages/account-map.test.tsx`, `tests/unit/account-map-ideas-filter.test.tsx`,
  `tests/playwright/account-map-ideas-audit.spec.ts` — all assert React Flow internals and must be rewritten.

## Implementation Checklist

- [x] Pure view-model builder `buildConnectionsModel(response)` → projects, work items (a chat and
      its task merged into one item), machines with their workspaces, edges, idea links
- [x] State derivation: working / needs attention (failed task) / idle / asleep / done, from real fields only
- [x] Filters: Everything / Live / Needs attention (failed) + search + "Include finished" (activeOnly=false)
- [x] Chain highlight (upstream + downstream, never sideways) and path bar with real links
      (project, idea, chat, machine)
- [x] Desktop three columns with SVG lines measured from the DOM; phone layout grouped by project with inline path
- [x] Workspaces without a node (Instant/containers) grouped under an "Instant" machine entry
- [x] Loading, error (retry), empty and truncation notice states
- [x] TanStack Query options in `lib/query-options/account-map.ts`, identity-scoped
- [x] Remove the React Flow canvas, node/edge components, dagre layout, old hooks, and the
      `@xyflow/react` / `dagre` deps if nothing else uses them
- [x] Remove the prototype (`pages/account-map-prototype/`, dev route in `App.tsx`)
- [x] Unit tests for the view-model (chat+task merge, edges, chain, filters, Instant grouping)
- [x] Rendered page tests (filters, selection → path bar links, activeOnly toggle refetch, error/empty)
- [x] Playwright audit at 375 and 1280 with normal, long text, many items, empty and error data; overflow asserted
- [x] Docs: update any public docs that describe the Account Map

## Acceptance Criteria

- [x] `/account-map` shows projects → chats and tasks → machines with lines between related items
- [x] Selecting an item highlights its chain and shows its path with working links
- [x] Filters and search narrow the view; "Include finished" refetches with `activeOnly=false`
- [x] Phone layout has no horizontal overflow and shows each chat's path
- [x] No React Flow code remains in the Account Map (the workflow run graph keeps it); no prototype route remains
- [ ] Staging: the page renders real data for the smoke user and selection works

## Implementation Notes

- API now passes `sessions[].attention` (open attention marker: kind, reason, createdAt) and
  `tasks[].outputPrUrl` (https only; anything else becomes null). KV cache key bumped to `v4`.
  No new I/O: both fields were already read and then dropped.
- `@xyflow/react` and `dagre` stay as dependencies: the workflow run graph uses both. The dagre
  helper moved to `pages/automation/workflows/dagre-layout.ts`.
- Ideas with no chat on the map are not drawn (the API only returns ideas linked to visible chats);
  linked ideas show on chat rows and in the path with links to the idea page.
- Below 1024px (tablets and phones) the page uses the grouped list; three columns need ~760px.
- Old "Reorganize" and per-type chips are gone: there is no free layout to reorganize, and the
  Everything / Needs you / Live filter plus search replace the type chips.
