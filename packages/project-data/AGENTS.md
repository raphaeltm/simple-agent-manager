# ProjectData Package (packages/project-data)

## Purpose

The per-project data store: the `ProjectData` Durable Object (chat sessions, messages, activity,
attention, comments, project events, schedules, durable prompt delivery, storage safety), its
typed RPC client, the ProjectData archive, and the two ProjectData cron jobs. Extracted from
`apps/api` by the worker modularization (`tasks/active/2026-11-12-worker-modularization.md`, W1).

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
