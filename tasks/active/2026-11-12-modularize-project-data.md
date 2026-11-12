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
  The worker entry configures it once at module load with an implementation in
  `apps/api/src/project-data-ports.ts`. Port methods take the caller's narrow env; the worker
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
- [ ] `ProjectDataEnv` + ports interface + registry inside the DO directory
- [ ] Worker port implementation + configure at worker entry + test setup
- [ ] Replace every outside import in scope with ports / moved modules
- [ ] Move ProjectData-owned helpers into scope (re-export at old paths)
- [ ] Remove `WorkerEnv` casts from scope
- [ ] Typecheck, lint, tests green; push

### Step 2 — lift into `packages/project-data` (after "W0 ready")
- [ ] Package scaffold from W0 template
- [ ] `git mv` scope into the package; worker re-exports
- [ ] Tests that do not need the worker pool move with the code
- [ ] Docs/rules path references updated
- [ ] Test file and case counts before/after recorded below

## Test counts

- Before (b4ef3fba9 / bbb1c82ca): TBD
- After: TBD

## Progress notes

- 2026-11-12: research done, plan recorded, W0 asked for route-helpers + durable-object-retry.
