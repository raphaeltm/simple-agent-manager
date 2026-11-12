# W1: extract ProjectData into `@simple-agent-manager/project-data`

Workstream W1 of `tasks/active/2026-11-12-worker-modularization.md` (the brief; it overrides the
usual `/do` defaults). Coordinator task `01M77BJHHNW5714E98DEEMBCZA`, channel
`feature.worker-modularization`, branch `sam/w1-project-data-extract-f1wa0b`, draft PR into the
core branch `sam/help-identify-parts-worker-embcza`.

## Scope

- `apps/api/src/durable-objects/project-data/**` (DO class and modules)
- `apps/api/src/durable-objects/migrations.ts` (ProjectData SQLite migrations; only ProjectData
  imports it — content unchanged, location moves with the DO)
- `apps/api/src/services/project-data*.ts` (client)
- `apps/api/src/project-data-archive/**`
- `apps/api/src/scheduled/project-data-*.ts` where they move cleanly

## Research findings (measured 2026-11-12 on `bbb1c82ca`, scripts in `.tmp/w1/`)

- ~62K lines in scope; 39 in-scope modules imported from outside, `services/project-data.ts`
  by 167 files. ~260 env fields read.
- The DO already declares a narrow `Env` in `durable-objects/project-data/types.ts`. Every call
  into a worker service goes through `env as unknown as WorkerEnv` (12 sites) — those are the
  port seams.
- Outside imports split into:
  - **W0 kernel** (worker-core): `lib/logger`, `lib/ulid`, `lib/runtime-validation`,
    `lib/d1-limits`, `middleware/error` (AppError). Requested from W0 on the channel:
    `lib/route-helpers` (`parsePositiveInt`), `services/durable-object-retry`.
  - **ProjectData-owned, move with the package**: `durable-objects/migrations.ts`,
    `services/project-lifecycle-event-inputs.ts`, `services/shared-session-names.ts`
    (pure parts), `services/reserved-task-session-revocations.ts`, `lib/search-query-limits.ts`,
    `lib/fts5.ts`, `lib/agent-wake-policy.ts`; ACP liveness snapshot types
    (`TaskAcpLivenessSignals` and friends) describe ProjectData data and move to the package.
  - **Scheduler-core (W2)**: `services/provider-limit-policy.ts` (`parseProviderLimitWait`).
  - **Ports** (worker implements, package declares): task terminal transition, task-runner
    cleanup, failed-task preservation, task status sets, task runtime liveness (the DO-side
    liveness adapter `durable-objects/project-data/task-runtime-liveness.ts` is task-liveness
    glue mirroring `scheduled/stuck-tasks.ts`; it moves to the worker as the port
    implementation), session recovery authority, snapshot wake claim, session idleness, session
    sleep predicates, node agent calls, VM prompt delivery adapter, telemetry metrics,
    observability `persistError`, notices (`sam-notice-builders`), operational kill switch,
    stalled-task classifier, reserved task submission, trigger execution sync, container
    lifecycle, Notification / NodeLifecycle / VmAgentContainer stubs.

## Design decisions

- **Port registry.** The package exports `ProjectDataPorts` and `configureProjectDataPorts()`.
  The worker entry configures it once at module load with one module per port in
  `apps/api/src/project-data-ports/`, installed by `apps/api/src/project-data-wiring.ts`. Port methods take the caller's narrow env; the worker
  implementation casts it to the worker `Env` in that one file (rule 51 sanctioned
  guard-then-cast: a DO receives the full Worker env at runtime). This relocates the 12
  existing `env as unknown as WorkerEnv` casts into one documented boundary.
  - Why not a constructor-injected subclass: ports are needed ~20 module functions deep; a
    registry avoids re-plumbing dozens of signatures, keeps the `ProjectData` class and its
    prototype identical (no inherited-RPC risk), and keeps existing `vi.mock` paths in tests
    working because the worker port implementation still imports the same worker modules.
- **Narrow env.** `ProjectDataEnv` (package) lists every binding/var the package reads; the
  worker `Env` extends it.
- **Client re-export.** `apps/api/src/services/project-data.ts` stays as a thin re-export of the
  package entry so its 167 importers and `vi.mock` paths do not change.

## Checklist

### Step 1 — decouple in place
- [x] `ProjectDataEnv` (`durable-objects/project-data/types.ts`) + `ports.ts` registry
- [x] Worker port implementation `src/project-data-ports/` (one module per port); `src/project-data-wiring.ts`
      configures it and re-exports the class; unit tests configure in `tests/setup/project-data-ports.ts`
- [x] Replace every outside import in scope with ports / moved modules (remaining: W0 kernel
      candidates route-helpers, search-query-limits, fts5, durable-object-retry; W2's
      provider-limit-policy → scheduler-core)
- [x] Move ProjectData-owned helpers into scope (agent-wake-policy, shared-session-names,
      lifecycle event inputs, session revocations, migrations.ts, mapRows/parseRowOrNull)
- [x] Remove `WorkerEnv` casts from scope (DO liveness adapter moved to
      `services/task-runtime-liveness-local.ts`, the port implementation)
- [x] Typecheck clean
- [x] Lint clean; unit pool green (1,087 files / 16,016 tests, 0 failed); pushed `ea0089160`

### Step 2 — lift into `packages/project-data` (after "W0 ready")
- [x] Package scaffold from W0 template (`package.json` entries `.`, `./durable-object`,
      `./scheduled`, `./internal/*`; tsconfig; vitest config with `cloudflare:workers` alias)
- [x] `git mv` scope into the package (207 files, `ddf1badc4`); named re-exports at the old
      worker paths the worker imports; `services/project-data.ts` re-exports the client wholesale
- [x] Tests that do not need the worker pool move with the code (43 files, `9694413a5`); 3 that
      reach worker ports stay; the SqlStorage helper is a package fixture
- [x] Docs/rules path references updated; source scanners include the package
- [x] Template wiring: CI path filters, runtime-boundary scan, dependency evidence, build order,
      lint rule keeping `./internal/*` out of worker source
- [x] Test file and case counts recorded below

## Test counts

- Before (bbb1c82ca): unit pool 1,087 files / 16,016 tests; Workers pool 180 files (+3 sam-runtime).
- After step 1: unit pool 1,087 files / 16,016 tests, all passing.
- After step 2 (`9694413a5`, core at bb071a00c which also merged main #2664):
  - apps/api unit pool: 1,085 files / 16,041 tests before the test move (green); after moving
    43 files, the apps/api count drops by those 43 files / 496 tests.
  - packages/project-data: 44 files / 499 tests (43 moved + 1 new entry-point test).
  - No test deleted. The 7 kernel test files missing from apps/api moved to worker-core in W0.

## Progress notes

- 2026-11-12: research done, plan recorded, W0 asked for route-helpers + durable-object-retry.
- 2026-11-12: step 1 code done; `scheduled/project-data-archive-breaker-alerts.ts` stays in the
  worker (operator notifications); the sharding job reaches it through
  `operations.alertArchiveBreakerOpened`. W2 confirmed `parseProviderLimitWait` is exported by
  scheduler-core. Baseline unit pool: 1,087 files / 16,016 tests (one failure seen was caused by
  edits during the run; passes on a clean tree).
- 2026-11-12: worker port wiring split into `src/project-data-ports/<port>.ts` (one module per
  port) after a single wiring module broke 36 test files' partial `vi.mock`s; test setup installs
  ports one at a time. Port modules import statically wherever ProjectData did (an extra
  `await import()` hop changed async ordering a reconciliation test pins).
- Step 2 plan: layout `packages/project-data/src/{do,client,archive,scheduled}`; entries `.`
  (client + types + ports), `./durable-object`, `./scheduled`. Old worker paths of the 39
  externally imported modules keep named re-exports. ~66 unit tests that touch only ProjectData
  move into the package with fake ports; tests that mix worker modules stay in apps/api.

## Review outcomes (head after review fixes)

- cloudflare-specialist: PASS, no CRITICAL/HIGH. Addressed: wiring test, cached port view, stale doc.
- architecture-reviewer: 3 HIGH addressed: the package owns the prompt-delivery adapter contract and
  the source-task guard (worker files import and re-export them; `SessionRecoverySourceTaskGuard`
  extends the package guard); `parseRow`/`mapRows`/`parseRowOrNull` moved to worker-core
  (`row-parsing.ts`) instead of project-data; `tests/unit/project-data-wiring.test.ts` loads the
  worker entry with an empty registry and asserts all nine ports (red when the install is removed).
  Also addressed: `configureProjectDataPorts` takes the full port set, tests use
  `configureProjectDataPort`; the failed-work orchestration lives in
  `services/failed-task-work-outcome.ts`; formatting-only churn reverted (14 worker files and all
  moved package sources, so `knowledge.ts` is back to 747 lines); stale path comments fixed.
  Deferred, with reasons:
  - Removing the ~300 `Env` fields now inherited from `ProjectDataEnv`: seven workstreams edit
    `env.ts` in parallel; dedupe belongs to the coordinator's final integration step.
  - Pure functions behind ports (notices, provider-limit parsing): the brief names notices and
    provider-limit-policy as W1 ports.
  - The task-liveness port receives the DO's `SqlStorage` and the worker adapter reads ACP signals
    through the package: behaviour-preserving; replacing it with a callback is a follow-up.
  - `./internal/*`: decision requested from the coordinator on the channel.
- task-completion-validator: first run FAIL on the file-size gate (fixed), `ast-checks` scope
  (now includes `packages/project-data/src`; 725 report-only warnings vs 203 without it, i.e. the
  ProjectData warnings the scan saw before the move), and derived counts (measured below). Two more
  ProjectData-only tests moved into the package (agent-wake-policy, alarm order).

### Measured test counts after review fixes

| Suite | Before W1 (bbb1c82ca) | Before test move (537bcc5e7, core bb071a00c) | Now |
| ----- | --------------------- | -------------------------------------------- | --- |
| apps/api unit pool | 1,087 files / 16,016 tests | 1,085 / 16,041 | 1,037 / 15,517 |
| packages/project-data | n/a | n/a | 50 / 528 |
| packages/worker-core (W0) | n/a | 9 / 98 | 9 / 98 |

49 files / 525 tests moved from apps/api into the package (16,041 - 525 + 1 new wiring test =
15,517). The package adds 3 entry-point tests (525 + 3 = 528). The 1,087 -> 1,085 change is W0
moving kernel tests to worker-core plus tests main added via the core merge. No test deleted.
Workers pool: 181 files, the same set as the core branch (180 on bbb1c82ca; main's
signed-webhook-ingress test arrived with the core merge); covered by CI's three DO shards.

Why the remaining ProjectData tests stay in apps/api:
- Workers pool (`tests/workers/`): they need workerd and the real DO bindings.
- They reach worker ports through `tests/setup/project-data-ports.ts` (the package has no worker
  ports): `project-events-wake-prompt-steer`, `task-wait-supervisor`, `task-acp-liveness-signals`
  (verified: they fail in the package with "port is not configured").
- They read worker data: `project-data-archive/sweep-message-budget-shipped` and
  `write-budget-shipped-factor` read `apps/api/wrangler.toml`.
- They import or mock worker modules (services, routes, scheduled jobs, D1 schema helpers):
  the remaining ~90 files, which exercise ProjectData together with the worker.
