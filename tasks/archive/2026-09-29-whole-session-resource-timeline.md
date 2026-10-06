# Whole-session resource timeline (ship the prototype)

## Problem

The session Resources drawer shows one 15-minute storage chunk at a time and gives no information on hover or tap. Raphaël said it left him "a bit misled": he did not realise he was looking at a thin slice of time. He approved the whole-session timeline prototype for production ("let's get this ui into prod", 2026-09-29).

Idea: `01M3P13H0W6EG1FS47PCG0N2EG`. Prototype branch: `sam/looks-resources-details-timeline-51112h` (commits af95d2969..75420e910).

## Research findings (verified on main af1544127/c17508d51 and prod, 2026-09-29)

1. **Only the newest chunk is drawn.** `SessionResourceHistoryDrawer` auto-loads the newest chunk. Chunks are 15 minutes (`collector.go` `DefaultChunkInterval`) of 5 s samples.
2. **Older history is unreachable.** `getWorkspaceResourceHistory` (`services/workspace-resource-history.ts`) lists only the newest 24 chunks (`DEFAULT_LIST_LIMIT`) with no disclosure. Prod session 449d73f8 ran about 27 h; its first ~20 h cannot be reached.
3. **Stat cards describe the last wake only.** The summary query returns the newest `(workspace, session)` row, and each wake is a new workspace. 449d73f8 spans 8 workspaces on 3 nodes and reports 258 samples.
4. **Lines have no absolute scale.** The sparkline normalises each line to its chunk peak, and CPU is shown as "ms/sample".
5. **The upload path already decodes each chunk** (`validateWorkspaceResourceChunkBytes` → `readBoundedGzipJson`). A per-minute rollup can be computed there at negligible CPU and stored per chunk, so the whole session draws from D1 alone.
6. **Workspace reservations exist** in `workspaces.resolved_reservation_json`. The parser is `parseStoredResolvedReservationJson` (`services/resource-requirements-input.ts`); it throws on malformed rows, so wrap it per row.
7. **Instant sessions collect nothing yet** (idea 01M3NV89R0CKFNMX6AQSK9FY5Q). `nodes.runtime = 'cf-container'` identifies them, and the empty state must say so rather than promise data in 15 minutes.
8. **Sibling tasks change the data** (coordinated by durable messages 01M3P2NE…, 01M3P2NJ…):
   - Tool labels (task 01M3NV760JFXQD4Y53VCW5TTC5): spans carry `kind` (ACP kind) and `toolName`.
   - Working set (task 01M3NV7MBCSASWHAT0W0JPJ3NT, migration 0176): sample `memoryWorkingSetBytes`; summary `memoryWorkingSetMeanBytes` / `memoryWorkingSetPeakBytes`.
   - Attribution (PR #2181, migration 0175).
   - All three touch the old drawer, `workspace-resource-history.ts` and the tool-rail audit spec. Keep shared-file edits small and put new logic in new modules.
9. **Library: uPlot 1.6.32** (MIT, ~23 KB gz). ECharts 6 is the runner-up. Highcharts and AG Charts Enterprise are rejected on licence (SAM is AGPL). Recharts is SVG without zoom. No library caches fetched data, so level-of-detail loading is app code in every option.
10. **Bundle.** The drawer is statically imported into the project-chat route, so the timeline (and uPlot) must load through a dynamic import. Measured: uPlot ends up only in the lazy `ResourceTimeline` chunk (36 KB gz).
11. **Rules that apply.**
    - Prototype route and mock data must be removed before merge (rule 37).
    - Request budget: index ≤ 8 round-trips (rule 60).
    - Scope predicates are tested on a real SQL engine with an attack case plus an owner control (rules 11, 28).
    - Per-row fault isolation (rule 50).
    - Additive migration only (rule 31).
    - Capped selection must disclose what it dropped (rule 65).
    - Every limit is configurable (constitution XI).

## Implementation checklist

### Backend
- [x] Migration `0177_workspace_resource_chunk_rollups.sql` (numbered after #2181's 0175; the working-set branch added no migration): `ALTER TABLE workspace_resource_chunks ADD COLUMN rollup_json TEXT` (+ schema.ts)
- [x] `services/workspace-resource-rollup.ts`: pure per-minute rollup from a decoded chunk payload. It holds CPU mean/max in cores, memory mean/max, working set mean/max, disk bytes, OOM kills, tool-call starts and sample count. Bucket count is bounded and configurable, and the result is compact and columnar.
- [x] Upload hook: compute and store `rollup_json` in `storeWorkspaceResourceChunk`. A rollup failure must never fail the upload.
- [x] `services/workspace-resource-timeline.ts`: the session index lists every chunk for `(project, session)`, newest first, capped by `WORKSPACE_RESOURCE_TIMELINE_MAX_CHUNKS` with `omittedChunkCount` disclosure. It groups chunks into runs with each workspace's reservation, and tolerates a malformed row. With no chunks, it reports whether the session's runtime collects at all (cf-container → unsupported).
- [x] Chunk read by id scoped to project + session, reusing `readChunkPayload`.
- [x] Routes `GET /api/projects/:id/sessions/:sessionId/resource-timeline` and `.../resource-timeline/chunks/:chunkId`, gated by project access.
- [x] Env var documented: `.env.example`, env.ts, env-reference skill, configuration.md.

### Web
- [x] API client + types for the two endpoints; the API source adapter reads the index (rollups → overview, summary fallback for older chunks) and the chunk endpoint
- [x] Per-run reservation lines
- [x] Empty state distinguishes "not uploaded yet" from "not recorded for Instant sessions"
- [x] ToolKind covers the full ACP set (read, edit, delete, move, search, execute, think, fetch, switch_mode, other)
- [x] Working-set fields read by the sibling's names (`memoryWorkingSetBytes`, `memoryWorkingSetMeanBytes`, `memoryWorkingSetPeakBytes`)
- [x] Remove the prototype route, page, mock data and the DEV_ONLY entry
- [x] Remove dead code: the old-API index adapter, and `getSessionResourceHistory` if unused
- [x] Playwright visual audit with stress data (27 h multi-wake, empty, Instant, older agent) at 375 and 1280, plus the rail audit

### Docs
- [x] `apps/www/.../guides/session-resources.md` rewritten for the timeline
- [x] `reference/api.md` lists the new endpoints

### Tests
- [x] Rollup unit tests (buckets, gaps, working set present and absent, tool starts, bounded bucket count)
- [x] Upload stores `rollup_json` (real SQL engine + fake R2)
- [x] Index on a real SQL engine: all chunks across workspaces; a foreign project/session is excluded (attack) while the owner is served (control); cap + disclosure; malformed row tolerated; reservation join; Instant detection
- [x] Chunk read: a foreign session's chunk id → 404 (attack) + owner control
- [x] Routes through the Hono app with project-access gating
- [x] Web data-layer tests updated for the new adapter

## Acceptance criteria
- [x] Opening Resources on a multi-wake session shows the whole session, with no chunk UI and no silent cap (disclosed only past the configured cap)
  - _Reconciled 2026-09-30:_ PR #2185 staging: a retained two-wake session read "22m active over 28m · 2 wake cycles · Whole session"; the Playwright audit includes a truncated history (612 omitted) that discloses the cap.
- [x] Hover, tap or keyboard shows exact values and says whether each is a 5 s sample or an average
  - _Reconciled 2026-09-30:_ PR #2185: the readout says whether a value is one 5-second sample or an average; Playwright hover, tap and keyboard-slider coverage.
- [x] Zoom (pinch, drag, chips, busiest moments) loads 5 s detail for the visible window only; chunks are fetched once
  - _Reconciled 2026-09-30:_ PR #2185: 5-second detail is fetched only for the visible window, each chunk once (TanStack Query); staging 15m zoom made three real R2 chunk reads, all 200; pinch proven discriminating (`b73317938`).
- [x] Reservation lines and OOM kills are visible; Instant sessions explain that no data is recorded
  - _Reconciled 2026-09-30:_ PR #2185: per-wake reserved lines and OOM markers verified by screenshot (canvas-drawn); Instant, pending and expired empty states captured at 375 and 1280.
- [x] Newly uploaded chunks carry a per-minute rollup; older chunks still render from their summary
  - _Reconciled 2026-09-30:_ PR #2185 staging: a fresh VM chunk uploaded at 10:55Z carried `rollup_json` (1,596 bytes, 181 samples); the pre-rollup session still rendered from its summary.
- [x] uPlot is not in the initial or chat-route bundle
  - _Reconciled 2026-09-30:_ PR #2185: verified with a production build that uPlot is only in the lazy `ResourceTimeline` chunk.
- [x] Staging: a real VM session shows its resource timeline end to end, including a chunk uploaded after deploy with a rollup
  - _Reconciled 2026-09-30:_ PR #2185: task `01M3PBHQCGR0RMTK5GQ6YQG197` on a fresh VM showed its timeline at 1280 and 375 with zero failed requests; its workspace and node were deleted afterwards.

## References
- `.claude/rules/37` (prototypes), `60` (request budgets), `11` and `28` (scope tests), `50` (row isolation), `31` (migrations), `65` (capped selection), `62` (real trigger), `17` and `56` (visual audit)
- Idea 01KZP2972NHBXVRM4695E3DCB3 (telemetry), 01M3P13H0W6EG1FS47PCG0N2EG (this work)

## Implementation notes (2026-09-29)
- The first implementation session hit its limit before committing; the migration/env edits were redone from scratch.
- Added `collection: 'expired'` (not in the original plan): once raw chunks pass retention the summary remains, and the drawer would otherwise have said "No resource samples yet" for a months-old session — the same kind of misleading copy this work exists to remove.
- A truncated history labels its all-in-view card "Everything shown", not "Whole session", found in the Playwright screenshot review.
- Sibling field names verified on their branches: spans `kind`/`toolName`; samples `memoryWorkingSetBytes`; summaries `memoryWorkingSetMeanBytes`/`memoryWorkingSetPeakBytes`.
- Rebased onto #2181 (attribution); its upload query joins tasks/agent_sessions/agent_profiles/skills, so the timeline test harness seeds those tables.
- Scope predicates proven discriminating: deleting the project/session conjuncts reddened exactly the two attack tests.
- Prototype route, page and mock data removed; the stress generator lives on as `apps/web/tests/playwright/resource-timeline-scenarios.ts`, serving real API shapes to the real chat rail.

---

_Reconciled 2026-09-30 (weekly queue reconciliation): shipped via PR #2185 (`2075aa074`, merged 2026-09-29), first successful production deploy run 36638567882._
