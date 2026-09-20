# Per-Workspace Resource History

## Problem

SAM needs retained per-workspace resource history with tool-call correlation so users and agents can inspect why a session spiked CPU, memory, I/O, or OOMed. The first shipped version must collect data, retain bounded raw history outside ProjectData, expose cheap summaries plus lazy detailed reads, and render it contextually in session/task inspection surfaces.

The implementation must not repeat current ProjectData storage problems. Raw samples and detailed tool-span correlations belong in compressed immutable R2 chunks. D1 should hold only bounded summary rows and chunk indexes. ProjectData may remain the source of existing ACP/tool timing context, but this feature must not add raw metrics, per-tool rows, or per-sample writes to ProjectData.

## Research Findings

- SAM task `01M2YQARAAMZAG8N5AAWMKBXMM` is authorized for implementation, staging, PR, merge, and production verification on branch `sam/build-per-workspace-resource-mkbxmm`.
- Idea `01KZP2972NHBXVRM4695E3DCB3` is the design record. Its older D1 per-tool-rollup phase is superseded by the Sept 20 addendum: detailed tool spans/rollups should be stored in compressed R2 chunks, with D1 storing bounded workspace/session summaries and chunk indexes.
- PR #1980 shipped live resource guard/OOM monitoring in `packages/vm-agent/internal/resourcemon`. Current code has pressure/OOM events and Docker-stat admission signals; those are not retained workspace history.
- `packages/vm-agent/internal/server/health.go` sends coarse `metrics.workspaceMemory` on heartbeat for admission. It is overwritten into `nodes.last_metrics` and is capped/omitted under pressure, so it is unsuitable as retained telemetry.
- VM-agent callback routes must be separate callback-JWT-auth routes mounted before browser-auth project routes. New upload/ingest callbacks must follow `apps/api/src/routes/projects/node-acp-heartbeat.ts` and `.claude/rules/34-vm-agent-callback-auth.md`.
- R2 direct upload/checksum patterns exist in session snapshot upload relay and attachment upload services. Reuse narrow ownership, checksum, size, and content-type verification rather than inventing a broad upload surface.
- App session timeline drawers already lazy-load contextual data and overlay on mobile. This is the right first UI surface; the separate node-card resource visualization prototype belongs to task `01M2YB0DBM0E69GW1NR7DS09HA` and is out of scope.
- UI changes require local Playwright screenshots for desktop and mobile with mock data that stresses long text, empty/gap states, and dense samples.
- Additive D1 migrations are required. Never recreate FK parent tables.
- Configurable defaults are required for all cadences, chunk sizes, retention, read/downsample limits, spool budgets, and cleanup limits.

## Implementation Checklist

### Data Model And API

- [ ] Add additive D1 migration for `workspace_resource_summaries` and `workspace_resource_chunks`.
- [ ] Add Drizzle schema entries and typed response models.
- [ ] Add configurable defaults/env fields for raw retention, summary retention, chunk read/downsample limits, upload size limits, and cleanup batch limits.
- [ ] Add callback-JWT upload route mounted before `projectsRoutes`, accepting only node/workspace-scoped telemetry uploads authorized for the target project/workspace.
- [ ] Verify upload checksum, declared byte length, schema version, ownership, idempotency, and truncation before writing D1 indexes.
- [ ] Store compressed immutable chunks in R2 and only bounded summaries/indexes in D1.
- [ ] Add lazy session/task resource history read endpoints with membership authorization, bounded time windows, bounded downsampling that preserves spikes, sample/gap indicators, and completeness metadata.
- [ ] Add scheduled cleanup for expired summaries/chunks and bounded R2 orphan cleanup.
- [ ] Add MCP/API inspection surface following existing API conventions for agents to fetch summaries/detail without spending LLM tokens on interpretation.

### VM Agent Collection

- [ ] Add cgroup-v2 numeric sampler for CPU counters, memory current/peak/events, IO counters, pids, and unsupported-capability flags.
- [ ] Discover/cache workspace container to cgroup mapping from existing workspace/container discovery without expensive hot-loop filesystem walks.
- [ ] Add bounded node-local spool/chunking with periodic retry/upload and best-effort flush on stop/sleep that never blocks lifecycle.
- [ ] Preserve task/session/workspace/profile/agent/skill attribution available at capture time.
- [ ] Correlate samples with existing ACP tool-call windows using bounded tool span records; omit prompts, arguments, outputs, commands, file paths, and environment/secrets.
- [ ] Label concurrent tool windows and background usage as correlation, not causal per-process attribution.
- [ ] Track counter resets, monotonic/wall-clock time, sample count, gaps, and completeness.

### UI

- [ ] Add cheap resource summary to session context.
- [ ] Add expandable resource timeline/detail drawer or tab in existing session/task inspection flow.
- [ ] Show CPU/RAM/I/O, peak/OOM hints, sample/gap indicators, and tool spans.
- [ ] Lazy-load raw/detail data only when expanded or zoomed.
- [ ] Preserve mobile overlay behavior; do not duplicate the node-card visualization prototype.

### Tests And Verification

- [ ] Unit-test cgroup parsing, counter resets, weighted means, percentiles from raw samples, gaps, OOM event handling, compression, checksum, and unsupported fields.
- [ ] Unit/integration-test callback auth, tenant isolation, upload abuse, retries/duplicates, truncation, retention, and secret canaries.
- [ ] Add vertical slice test from VM-style upload through R2/D1 indexing to read API response with realistic multi-tenant state.
- [ ] Add UI tests and Playwright screenshots for desktop and mobile.
- [ ] Benchmark compression ratio, bytes per workspace-hour, write/read request estimates, bounded D1 growth, collector CPU overhead, and failure cases.
- [ ] Run relevant quality checks: VM-agent Go tests, API unit/integration tests, web typecheck/tests, lint/typecheck/build as appropriate.
- [ ] Run local specialist reviews: task-completion-validator, go-specialist, cloudflare-specialist, security-auditor, ui-ux-specialist, test-engineer, constitution-validator, env-validator, doc-sync-validator as applicable.
- [ ] Coordinate staging, deploy branch, run a real VM telemetry/upload/read/tool-span scenario, capture desktop/mobile Playwright evidence, and clean up staging resources.
- [ ] Create PR, wait for CI, request CodeRabbit once via label, address feedback, merge under normal gates, monitor production deploy, and verify production behavior.

## Acceptance Criteria

- A running VM workspace emits retained resource history into compressed R2 chunks with D1 summary/index rows and bounded local retry/spool semantics.
- Existing session/task context can show a cheap resource summary and lazy detail timeline with tool-call correlation labels and completeness/gap indicators.
- Project membership and callback identity prevent cross-tenant upload/read access.
- Raw samples and detailed tool spans are never stored in ProjectData and are never written per-sample to D1.
- Retention and cleanup are configurable and bounded.
- Tests cover security, math, retries/idempotency, truncation, retention, and vertical slice behavior.
- Staging verification proves real VM collection/upload/read/UI behavior with desktop and mobile screenshot evidence.

## References

- SAM idea `01KZP2972NHBXVRM4695E3DCB3`
- SAM task `01M2YQARAAMZAG8N5AAWMKBXMM`
- Separate node-card visualization prototype task `01M2YB0DBM0E69GW1NR7DS09HA`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/35-vertical-slice-testing.md`

