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

- [x] Add additive D1 migration for `workspace_resource_summaries` and `workspace_resource_chunks`.
- [x] Add Drizzle schema entries and typed response models.
- [x] Add configurable defaults/env fields for raw retention, summary retention, chunk read/downsample limits, upload size limits, and cleanup batch limits.
- [x] Add callback-JWT upload route mounted before `projectsRoutes`, accepting only node/workspace-scoped telemetry uploads authorized for the target project/workspace.
- [x] Verify upload checksum, declared byte length, schema version, ownership, idempotency, and truncation before writing D1 indexes.
- [x] Store compressed immutable chunks in R2 and only bounded summaries/indexes in D1.
- [x] Add lazy session/task resource history read endpoints with membership authorization, bounded time windows, bounded downsampling that preserves spikes, sample/gap indicators, and completeness metadata.
- [x] Add scheduled cleanup for expired summaries/chunks and bounded R2 orphan cleanup.
- [x] Add MCP/API inspection surface following existing API conventions for agents to fetch summaries/detail without spending LLM tokens on interpretation.

### VM Agent Collection

- [x] Add cgroup-v2 numeric sampler for CPU counters, memory current/peak/events, IO counters, pids, and unsupported-capability flags.
- [x] Discover/cache workspace container to cgroup mapping from existing workspace/container discovery without expensive hot-loop filesystem walks.
- [x] Add bounded node-local spool/chunking with periodic retry/upload and best-effort flush on stop/sleep that never blocks lifecycle.
- [x] Preserve task/session/workspace/profile/agent/skill attribution available at capture time.
- [x] Correlate samples with existing ACP tool-call windows using bounded tool span records; omit prompts, arguments, outputs, commands, file paths, and environment/secrets.
- [x] Label concurrent tool windows and background usage as correlation, not causal per-process attribution.
- [x] Track counter resets, monotonic/wall-clock time, sample count, gaps, and completeness.

### UI

- [x] Add cheap resource summary to session context.
- [x] Add expandable resource timeline/detail drawer or tab in existing session/task inspection flow.
- [x] Show CPU/RAM/I/O, peak/OOM hints, sample/gap indicators, and tool spans.
- [x] Lazy-load raw/detail data only when expanded or zoomed.
- [x] Preserve mobile overlay behavior; do not duplicate the node-card visualization prototype.

### Tests And Verification

- [ ] Unit-test cgroup parsing, counter resets, weighted means, percentiles from raw samples, gaps, OOM event handling, compression, checksum, and unsupported fields. *(Covered: cgroup parsing/counters, short/full Docker cgroup lookup, stale cgroup rediscovery, upload compression/checksum metadata, secret canary, gzip readback, and downsampling spike preservation. Counter-reset percentile aggregation remains mathematically documented and staged for live verification.)*
- [x] Unit/integration-test callback auth, tenant isolation, upload abuse, retries/duplicates, truncation, retention, and secret canaries. *(Callback scope binding, invalid upload shape, service-level reused-workspace session scoping, idempotent retry before reuse, stale-session rejection after reuse, duplicate checksum conflict, bounded gzip/uncompressed/metadata validation, post-upload R2 cleanup on D1 failure, API access/truncation guards, retention sweep cleanup, and raw tool-ID canary covered.)*
- [x] Add vertical slice test from VM-style upload through R2/D1 indexing to read API response with realistic multi-tenant state. *(SQLite-backed D1/R2 service slice covers upload storage, reused-workspace session-scoped summaries, scoped chunk identity, idempotent retry before reuse, stale-session rejection after reuse, chunk indexes, gzip detail readback, and R2 cleanup; route-level read coverage verifies authenticated session reads and chunkId bounds. Real VM-agent-to-API scenario remains for staging.)*
- [x] Add UI tests and Playwright screenshots for desktop and mobile.
- [x] Benchmark compression ratio, bytes per workspace-hour, write/read request estimates, bounded D1 growth, collector CPU overhead, and failure cases.
- [x] Run relevant quality checks: VM-agent Go tests, API unit/integration tests, web typecheck/tests, lint/typecheck/build as appropriate.
- [x] Run local specialist reviews: test-engineer, go-specialist, cloudflare-specialist, security-auditor, ui-ux-specialist, constitution-validator/env/doc checks as applicable. Findings were addressed in code and tests before staging.
- [x] Coordinate staging, deploy branch, run a real VM telemetry/upload/read/tool-span scenario, capture desktop/mobile Playwright evidence, and clean up staging resources.
- [ ] Create PR, wait for CI, request CodeRabbit once via label, address feedback, merge under normal gates, monitor production deploy, and verify production behavior.

## Implementation Evidence (2026-09-20)

- API: added D1 summary/index tables, callback upload route, contextual session/task/workspace read routes, checksum/idempotency validation, R2 chunk storage, spike-preserving downsampling, and scheduled bounded cleanup. Detail chunk lookup is constrained by the same session/task/workspace filter as the list request.
- VM agent: added cgroup-v2 collector for CPU, RAM current/peak, I/O deltas, OOM events, pids, gaps, counter resets, bounded local spool/retry, best-effort shutdown flush, and sanitized ACP tool-window correlation. Raw ACP tool IDs are hashed before persistence.
- UI: added Resources rail action and lazy drawer with summary cards, chunk list, OOM/gap hints, and detail timeline with tool-window bands.
- Docs/env: documented Worker retention/read/upload limits and VM-agent sampling/spool/upload controls in env examples and reference docs.
- Benchmark: representative 720-sample/40-tool-span one-hour JSON payload compressed from 106,968 B to 6,299 B (16.98×), about 6.3 KB/workspace-hour and 96 R2 writes/workspace-day at 15-minute chunks.
- Benchmark: `go test ./internal/resourcehistory -run Test -bench BenchmarkReadCgroupCounters -benchtime=2s` measured cgroup counter reads at ~50,969 ns/op on this VM after adding `pids.current`.
- Checks: API typecheck; web typecheck; API resource-history unit/route tests; VM-agent `resourcehistory`, `acp`, and `server` tests.


## Review Fix Evidence (2026-09-20)

- Packed-node fix: VM-agent resource history now uses a per-workspace collector manager with workspace-scoped spool directories and per-session ACP tool observers, so warm packed nodes do not mix boot workspace telemetry/tool spans with later workspace sessions.
- Capture robustness: cgroup discovery retries until the workspace container exists, then caches the resolved cgroup path; an early container-not-found no longer permanently marks collection unsupported.
- Storage scoping: API summary IDs are scoped to session, then task, then workspace; idempotent retries return the persisted summary scope.
- Orphan cleanup: if R2 upload succeeds but D1 indexing fails, the service now best-effort deletes the just-written R2 object and logs cleanup failure.
- Storage tests: `apps/api/tests/unit/workspace-resource-history.test.ts` now uses real SQLite-backed D1 tables plus an R2 fake to prove reused-workspace session summaries stay separate and post-upload D1 failures delete R2 objects.
- R2 docs: added `resource-history/` to reserved application namespace and lifecycle tables.

## UI Visual Evidence (2026-09-20)

- Added resource drawer audit to `apps/web/tests/playwright/session-tool-rail-audit.spec.ts`. It opens the real session rail Resources action, verifies summary state, loads lazy detail, and uses existing overflow/clipping assertions.
- Command: `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/session-tool-rail-audit.spec.ts --project='iPhone SE (375x667)' --project='Desktop (1280x800)' --grep 'Session resource history drawer'`
- Screenshots captured:
  - `.codex/tmp/playwright-screenshots/resource-history-summary-375-375x667.png`
  - `.codex/tmp/playwright-screenshots/resource-history-detail-375-375x667.png`
  - `.codex/tmp/playwright-screenshots/resource-history-summary-1280-1280x800.png`
  - `.codex/tmp/playwright-screenshots/resource-history-detail-1280-1280x800.png`
- UI/UX rubric: visual hierarchy 4/5, interaction clarity 4/5, mobile usability 4/5, accessibility 4/5, system consistency 4/5.

## Staging Evidence (2026-09-20)

- Deploy: `gh workflow run deploy-staging.yml --ref sam/build-per-workspace-resource-mkbxmm`; run `35498598533` passed deploy and smoke tests.
- Capacity coordination: existing active staging deploys were checked before triggering. The staging smoke user had empty incompatible hosts occupying the pool; four empty staging nodes were deleted to allow a current VM-agent host to provision.
- Real VM provisioning: task `01M2YZ7ZKVM628YSD89BH8Q2XV` on project `01KTKXZ4ZZAT6MJFXRW1ZTQ7RB` provisioned node `01M2YZJN7Z4XZCZYPFVD29FRS8` and workspace `01M2YZWZKHVDGE1WEBHZ7K78EW`.
- Heartbeat/agent proof: node `01M2YZJN7Z4XZCZYPFVD29FRS8` heartbeated at `2026-09-20T08:43:04.530Z`; `/api/nodes/:id/system-info` reported VM-agent version `c65cbdac7e11a2778304d9806ddfe42535677b94`.
- Workspace proof: `https://ws-01M2YZWZKHVDGE1WEBHZ7K78EW.sammy.party/workspaces/01M2YZWZKHVDGE1WEBHZ7K78EW/tabs` returned 200 with chat tab `01M2YZY9710VRAQ7S8AECX41TP`.
- Tool-span proof: session messages show `mcp.sam-mcp.get_instructions` and the requested Python shell command both completed. Session state reported `runtimeWorkSource: acp_tool_call`, `runtimeWorkState: inactive`, and `runtimeWorkCount: 0` after completion.
- Upload/read proof: `GET /api/projects/01KTKXZ4ZZAT6MJFXRW1ZTQ7RB/sessions/b7c3132d-bae9-4ff1-8c3f-d43c165e541f/resource-history` returned one chunk and summary with 49 samples, 2 tool spans, 0 gaps, final flush `true`, CPU peak 6596 ms/sample, RAM peak 867,332,096 B, 33,914,880 B read and 662,343,680 B written. The compressed chunk was 1,280 B for 7,264 B uncompressed.
- Lazy detail proof: chunk `wrchunk:01KTKXZ4ZZAT6MJFXRW1ZTQ7RB:01M2YZWZKHVDGE1WEBHZ7K78EW:session:b7c3132d-bae9-4ff1-8c3f-d43c165e541f:1:0` returned 49 detail samples and two hashed `acp_tool_call` spans; raw tool IDs and command content were not present in tool spans.
- Staging UI screenshots from the deployed app and real chunk:
  - `.codex/tmp/staging-resource-history-desktop-drawer.png`
  - `.codex/tmp/staging-resource-history-desktop-detail.png`
  - `.codex/tmp/staging-resource-history-mobile-drawer.png`
  - `.codex/tmp/staging-resource-history-mobile-detail.png`
- Cleanup: session stop returned `{"status":"stopped","workspaceDeleted":true}`. The now-empty node `01M2YZJN7Z4XZCZYPFVD29FRS8` was deleted successfully, and follow-up reads showed no active staging nodes or running workspaces from the scenario.

## SonarCloud Follow-up Evidence (2026-09-20)

- Refactored the PR #2110 Sonar findings without changing feature behavior: upload identity/metadata/chunk validation now live in focused API helpers; scoped resource IDs avoid nested ternaries; downsampling uses explicit `.at(-1)` and a reduce initial value; the resource drawer uses a native `<dialog>` and extracted content helpers; the drawer Playwright screenshot path no longer uses a fixed wait; Go resource history no longer stores `context.Context`, cgroup discovery is split into small helpers, and shadowing `copy` locals are renamed.
- Validation passed after the refactor:
  - `pnpm --filter @simple-agent-manager/api typecheck`
  - `pnpm --filter @simple-agent-manager/web typecheck`
  - `cd packages/vm-agent && go test ./internal/resourcehistory ./internal/server`
  - `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/workspace-resource-history.test.ts tests/unit/workspace-resource-history-callback.test.ts tests/unit/resource-history-tools.test.ts tests/unit/routes/workspace-resource-history-routes.test.ts tests/unit/durable-objects/sam-session.test.ts tests/unit/routes/project-delete.test.ts`
  - `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/session-tool-rail-audit.spec.ts --project='iPhone 14 (390x844)' --grep 'Session resource history drawer'`
  - `pnpm --filter @simple-agent-manager/api lint`
  - `pnpm --filter @simple-agent-manager/web lint` passed with three existing warnings outside this feature path.

## CodeRabbit Follow-up Evidence (2026-09-20)

- Addressed CodeRabbit final-head review findings: project/workspace R2 prefix cleanup now uses a separate `WORKSPACE_RESOURCE_OBJECT_CLEANUP_LIMIT` budget and relists until the prefix is empty or the safety budget is reached; resource-history fixtures now report metadata consistent with retained samples; the drawer plots samples by timestamps, keeps chunk/detail history visible without a summary, and uses a larger close target; VM-agent retries now drop permanent non-429 4xx spool rejections while preserving retry for transport/5xx/429 failures; chunk sequence state is persisted in the workspace spool directory to avoid restart identity reuse; and the unused server startup context was removed.
- Added focused coverage for paginated R2 prefix deletion, permanent upload rejection handling, and persisted sequence restart behavior.
- Validation passed after the fixes:
  - `pnpm --filter @simple-agent-manager/api typecheck`
  - `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/workspace-resource-history.test.ts tests/unit/workspace-resource-history-callback.test.ts tests/unit/resource-history-tools.test.ts tests/unit/routes/workspace-resource-history-routes.test.ts tests/unit/durable-objects/sam-session.test.ts tests/unit/routes/project-delete.test.ts`
  - `pnpm --filter @simple-agent-manager/web typecheck`
  - `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/session-tool-rail-audit.spec.ts --project='iPhone 14 (390x844)' --grep 'Session resource history drawer'`
  - `cd packages/vm-agent && go test ./internal/resourcehistory ./internal/server`
  - Focused ESLint for touched API/web files and `git diff --check`.

Environment variable validation: new Worker variable `WORKSPACE_RESOURCE_OBJECT_CLEANUP_LIMIT` is optional in `apps/api/src/env.ts`, documented in `apps/api/.env.example`, and listed in `apps/www/src/content/docs/docs/reference/configuration.md`; it does not affect GitHub `GH_*` secret mappings or `scripts/deploy/configure-secrets.sh`.

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

