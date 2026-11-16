# ProjectData Package (packages/project-data)

## Purpose

The per-project data store: the `ProjectData` Durable Object (chat sessions, messages, activity,
attention, comments, project events, schedules, durable prompt delivery, storage safety), its
typed RPC client, the ProjectData archive, and the two ProjectData cron jobs. Extracted from
`apps/api` by the worker modularization (`tasks/archive/2026-11-12-worker-modularization.md`, W1).

The package imports nothing from `apps/*`. It depends on `@simple-agent-manager/shared` and
`@simple-agent-manager/worker-core`. Everything it needs from other areas of the worker (task
lifecycle, task runtime liveness, session recovery and sleep, node agents, prompt transport,
notices, notifications, telemetry, operational brakes, credentials) goes through
`ProjectDataPorts` (`src/do/ports.ts`). The worker implements one module per port in
`apps/api/src/project-data-ports/` and installs them in `apps/api/src/project-data-wiring.ts`,
which is also where the worker entry exports the `ProjectData` class from.

## Entry points

| Import                                              | Contents                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@simple-agent-manager/project-data`                | The client (`src/client/project-data.ts`), `ProjectDataEnv`, ports, types and helpers the worker uses (`src/index.ts`) |
| `@simple-agent-manager/project-data/durable-object` | The `ProjectData` Durable Object class                                                                                 |
| `@simple-agent-manager/project-data/scheduled`      | Archive sharding and storage-relief cron jobs, archive admin controls                                                  |
| `@simple-agent-manager/project-data/internal/*`     | Any module under `src/`, for `apps/api` **tests only** (lint rejects it in worker source)                              |

`./internal/*` exists because ~100 worker tests drive Durable Object internals together with
worker modules (reconciliation, prompt delivery, session sleep vertical slices) and so cannot move
into this package.

## Layout

| Directory        | Contents                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| `src/do/`        | Durable Object class (`index.ts`) and its modules; SQLite migrations in `migrations.ts` |
| `src/client/`    | Worker-side RPC client and archive routing/rollout controls                             |
| `src/archive/`   | Archive contract, R2 compaction, hashing, write budget                                  |
| `src/scheduled/` | Cron jobs the worker's `scheduled()` handler runs                                       |

## Invariants

- The class name `ProjectData`, its storage and its SQLite migrations must not change: the
  Cloudflare binding and every existing object depend on them. Migrations are append-only.
- `ProjectDataEnv` (`src/do/types.ts`) lists every binding and variable the package reads; the
  worker `Env` extends it. Never accept the worker's full `Env`.
- A port method takes the narrow env; the worker widens it in one place
  (`apps/api/src/project-data-ports/worker-env.ts`).

## Commands

```bash
pnpm --filter @simple-agent-manager/project-data build      # the worker resolves dist/: build before api typecheck/tests
pnpm --filter @simple-agent-manager/project-data typecheck
pnpm --filter @simple-agent-manager/project-data test
pnpm --filter @simple-agent-manager/project-data lint
```

Durable Object behaviour is tested against real workerd in `apps/api/tests/workers/`.

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

- `.claude/rules/31-migration-safety.md`: Migration Safety (ABSOLUTE RULE — DATA LOSS PREVENTION)
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`: Storage Migrations Must Enumerate Every Writer of the Migrated Data
- `.claude/rules/45-durable-object-concurrency-mutex.md`: Durable Objects Do Not Serialize Across `await` — Use a Real Mutex for Critical Sections
- `.claude/rules/47-control-loop-io-budget.md`: Control Loops Need Explicit I/O Budgets
- `.claude/rules/49-capture-prerequisites-before-async-completion.md`: Capture Handler Prerequisites Before a Long Async Operation
- `.claude/rules/50-list-read-row-fault-isolation.md`: List/Snapshot Reads Must Tolerate a Single Malformed Row
- `.claude/rules/51-runtime-boundary-validation.md`: Runtime boundary validation
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`: Scheduled Handlers: Isolate Every Step, and Never Use a Liveness Timestamp as an Idleness Signal
- `.claude/rules/57-write-only-cross-boundary-state.md`: Cross-Boundary State With Multiple Consumers Must Be Reconciled, Not Just Reported
- `.claude/rules/60-request-io-and-bundle-budgets.md`: Request I/O and Client Bundle Budgets
- `.claude/rules/61-per-cycle-budget-counters.md`: Per-Cycle Budget Counters Must Reset on Success
- `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md`: Making a Scoping Column Nullable Silently Deletes Every Check That Used It
- `.claude/rules/65-capped-selection-must-rank-and-disclose.md`: A Capped Selection Must Rank By Its Purpose, And Must Disclose What It Dropped
- `.claude/rules/68-event-scoped-filter-predicates.md`: Event-Scoped Filters Must Encode Their Scope
- `.claude/rules/69-emergency-config-paths-need-their-own-coverage.md`: A Code Path That Only Activates Under an Emergency Configuration Needs Tests In That Configuration
- `.claude/rules/71-tightening-a-column-can-delete-a-capability.md`: A New Required Column Can Silently Delete a Capability for Every Existing Row
- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State

<!-- END GENERATED RULE INDEX -->
