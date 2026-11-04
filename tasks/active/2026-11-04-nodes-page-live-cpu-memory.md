# Nodes page: sessions first, with live CPU and memory per machine

## Problem

Raphaël asked (2026-11-04, conversation task `01M6KHM7JE54SN3P23EK4S1NFY`) to ship the "Live: CPU + memory" prototype as the real `/nodes` page. The current page lists node cards named after the task that first started them, links to workspaces (an expert/debugging concept) rather than to chats, and shows only node-level CPU/MEM/DISK percentages. It does not show what each session reserved or what it uses.

Prototype: `/prototype/nodes-glass?concept=both` on branch `sam/feel-keep-talking-redoing-4s1nfy` (`apps/web/src/pages/nodes-glass-prototype/ConceptLiveBoth.tsx`, commit `4d1bafe68`). Screenshots and comparison: library `/design/nodes-page-2026-11-04/`. The prototype is never merged: this branch is cut from `main`.

## Research findings

- **Node list**: `GET /api/nodes` (`apps/api/src/routes/nodes.ts:72`) returns the caller's non-deleted nodes via `toNodeResponse` (`routes/nodes/response.ts`). `lastMetrics` is passed through as parsed JSON and already carries `workspaceMemory[]` (per-workspace live memory from the 60s heartbeat, container mode, schema `apps/api/src/schemas/misc.ts:103-119`), but `NodeMetrics` in `packages/shared/src/types/workspace.ts:120` does not declare it.
- **Workspaces**: `GET /api/workspaces` (`routes/workspaces/crud.ts:40`) is user-scoped (`workspaces.user_id = me`) and returns `chatSessionId`, `projectId`, `resolvedReservationJson` (raw JSON string).
- **Resource history**: VM agent collects 5s cgroup samples and uploads a chunk every 15 minutes (`packages/vm-agent/internal/resourcehistory/collector.go:31-32,383-407`). Each chunk row in D1 `workspace_resource_chunks` has a per-minute columnar rollup in `rollup_json` (`cpuMeanCores`, `memoryMeanBytes`, …; parser `parseWorkspaceResourceRollup`, `workspace-resource-rollup.ts:226`). Index `(project_id, workspace_id, started_at)`; no `node_id` index. **History lags by up to ~15 minutes**; the in-progress chunk exists only in agent memory. There is **no live per-workspace CPU** anywhere.
- **Titles/projects/owners without hitting each ProjectData DO**: D1 `session_summaries` (`schema.ts:3962`, `id` = chat session id, `topic`, `created_by_user_id`), `tasks.title` via `tasks.chat_session_id`, `projects.name`, `users.name`. Prior art joining `session_summaries` with `projects` across projects: `routes/chats.ts:39-51`.
- **Authorization**: resource-history routes require project membership; node routes require node ownership (`nodes.user_id = me`). A node-scoped usage read authorizes by the caller's own workspaces on the caller's own nodes and scopes chunk reads by both `project_id` and `workspace_id` from those rows.
- **D1 bind limit** is 100 (`apps/api/src/lib/d1-limits.ts`): batch `IN (...)` lists.
- **Runtime tunables** go in the typed admin settings registry (`apps/api/src/services/admin-settings-*-definitions.ts`); precedent `chat.profileUsageWindowDays` (`admin-settings-features-definitions.ts:191`, resolver in `agent-profile-picker.ts:33`).
- **Web**: `Nodes.tsx` (404 lines) uses TanStack Query (`nodeListQueryOptions`, `workspaceListQueryOptions`), poll cadences in `apps/web/src/lib/poll-intervals.ts`. `NodeCard` (+ `NodeWorkspaceMiniCard`, `MiniMetricBadge`) render the current cards; used by `tests/unit/components/node/NodeCard.test.tsx` and Playwright fixture `tests/playwright/fixtures/native-hardware-harness.tsx`. Existing page tests: `tests/unit/pages/nodes.test.tsx`.
- **Design**: SAM Glass (`docs/guides/sam-glass-design-system.md`); green = working, amber = waiting on you only, person colours = who. Memory over its reservation is the danger case (OOM); CPU over its reservation is compressible and must not read as an error (`workspace-resource-capacity.ts` says the same).

### Consequence for the design

Because history arrives in 15-minute batches, the per-machine chart covers the last **60 minutes** by default (admin setting `nodes.usageWindowMinutes`, 15–360), not 30, and the page says plainly that history arrives in batches. Live memory from the heartbeat (≤60s old) is used for the "now" memory numbers and drawn as a point at the right edge. CPU "now" is the latest history minute, shown with its age.

## Implementation notes

- Names changed during implementation to avoid confusion with the existing vCPU-hour billing "node usage" (`services/node-usage.ts`): service `services/node-resource-usage.ts`, route `GET /api/nodes/resource-usage`, types `NodeResourceUsageResponse`, `NodeWorkspaceResourceUsage`, `NodeResourceUsageSeries`, `NodeResourceReservation`.
- `main` rejects direct pushes (repository rule), so this task file travels in the PR rather than being committed to `main` first.
- Guards proven discriminating: removing `n.user_id = ?` or `w.user_id = ?` fails the cross-user test; removing the chunk project pairing fails only when both the SQL predicate and the in-code check are removed (defence in depth). Web: removing the heartbeat-freshness check or the memory-over flag each fails exactly one page test.
- Playwright audit had to dismiss the onboarding overlay (localStorage `sam-onboarding-wizard-dismissed-<user>`) or it would cover the page.

## Implementation checklist

### Shared types
- [x] Add `NodeWorkspaceMemoryMetric` and `workspaceMemory?` to `NodeMetrics`.
- [x] Add `NodeUsageResponse` / `NodeWorkspaceUsage` types (`packages/shared/src/types/node-usage.ts`), exported from the types barrel.

### API
- [x] Admin setting `nodes.usageWindowMinutes` (default 60, range 15–360) + name in the union.
- [x] Service `apps/api/src/services/node-usage.ts`: one joined D1 read of the caller's non-deleted workspaces on the caller's nodes (title: session topic → task title → workspace display name; project name; owner; reservation parsed fault-tolerantly), then batched chunk reads (`project_id` + `workspace_id`, `ended_at > windowStart`, `rollup_json IS NOT NULL`), per-row fault isolation for malformed rollups, merged into per-minute series clipped to the window.
- [x] Route `GET /api/nodes/usage` registered before `/:id`.
- [x] Tests against a real SQL engine (`tests/helpers/sqlite-d1.ts`): owner path; another user's workspace/chunks excluded (attack + owner control, verified discriminating); chunk with mismatched `project_id` excluded; window filter; malformed rollup skipped while good rows remain; title fallback order; malformed reservation → null; rollup built by the real `buildStoredRollupJson` producer.
- [x] API docs (`apps/www/src/content/docs/docs/reference/api.md`) and admin settings docs if they list settings.

### Web
- [x] Query options + poll cadence `NODE_USAGE_POLL_MS` (default 60s, env-overridable).
- [x] Pure model (`components/node/usage/node-usage-model.ts`): align/sum series per machine, live memory merge, latest values, over-limit flags, hardware title.
- [x] `MirrorChart` (memory up, CPU down, dashed set-aside lines, labels outside the chart, live memory point).
- [x] `NodeUsagePane`: hardware title + location + spec, status/health chips, price, Stop/Delete menu, Details link, error/cleanup message, machine chart, session rows, Advanced (workspace links, node name/id); deployment-node and empty/creating/stopped states.
- [x] `NodeSessionRow`: status, chat title linking to `/projects/:projectId/chat/:sessionId`, owner/project/age, mirrored sparkline, used/reserved numbers, "over limit" (memory, danger) / "burst, fine" (CPU, muted), no-history state.
- [x] `Nodes.tsx`: new layout; create-node form extracted to its own component (keep behaviour); keep stale-while-revalidate behaviour.
- [x] Remove `NodeCard`, `NodeWorkspaceMiniCard`, `MiniMetricBadge` if no longer used, with their tests; update the Playwright native-hardware harness.
- [x] Unit tests: model; Nodes page (sessions render with chat links; create/stop/delete still work; error/empty states; live memory overrides history).
- [x] Playwright visual audit (mobile 375 + desktop 1280, dark + light): normal, long text, empty, many items (30 sessions), error; `assertNoOverflow`.

### Docs
- [x] Update user-facing docs that describe the Nodes page.

## Acceptance criteria

- [x] `/nodes` shows each machine by hardware (provider, type, location, vCPU/RAM/disk), never by task name.
- [x] Each machine shows a mirrored chart of the last `nodes.usageWindowMinutes` minutes: memory above the line, CPU below, dashed lines at what is set aside.
- [x] Each session on a machine is a row with its chat title linking to the chat, owner, project, age, a mirrored sparkline and used/reserved numbers for memory and CPU.
- [x] Memory over its reservation reads as danger; CPU over its reservation does not.
- [x] Workspace links are only under "Advanced".
- [x] Create node, Stop and Delete still work; node detail is still reachable.
- [x] The page says that history arrives in batches (the docs say every 15 minutes by default); live memory is used when available.
- [x] A user never sees another user's workspaces or usage.
- [x] No horizontal overflow at 375px and 1280px; light and dark themes.
- [x] No prototype files on `main`.

Evidence: `apps/api/tests/unit/routes/node-resource-usage.test.ts` (9 tests, real SQL, cross-user attack + owner control), `apps/web/tests/unit/pages/nodes.test.tsx` (15 tests), `apps/web/tests/unit/components/node/usage/node-resource-model.test.ts` (6), `apps/web/tests/playwright/nodes-usage-audit.spec.ts` (14 at 375 and 1280, dark and light, `assertNoClippedOverflow`). The branch was cut from `origin/main`; no `nodes-glass-prototype` files are in the diff. Staging verification: see PR.

## References

- Prototype branch `sam/feel-keep-talking-redoing-4s1nfy`; library `/design/nodes-page-2026-11-04/`
- `.claude/rules/28-credential-resolution-fallback-tests.md` (real SQL for SQL-predicate guards), `apps/api/.claude/rules/50-list-read-row-fault-isolation.md`, `.claude/rules/60-request-io-and-bundle-budgets.md`, `.claude/rules/81-work-bounds-must-state-throughput.md`, `apps/web/.claude/rules/17-ui-visual-testing.md`, `apps/web/.claude/rules/80-sam-glass.md`
