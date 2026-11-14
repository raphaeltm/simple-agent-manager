# Operations Package (packages/operations)

## Purpose

Surface-agnostic SAM platform operations. Each operation owns validation, membership and
capability checks, limits and side effects; every surface (workspace `sam-mcp`, the Connector at
`/connect/mcp`, the /sam agent and REST routes) is a thin adapter that translates transport,
actor and output format (project policy 5cb362e8, idea 01M4GJ0W0DS5BTKBM1YW0X5YC8). Part of the
worker modularization (`tasks/archive/2026-11-12-worker-modularization.md`, workstream W3).

The package holds **no worker `Env` and no import from `apps/*`**. It reads only its narrow
`OperationsEnv` (`src/env.ts`, which the worker `Env` extends) and reaches everything another area
owns (ProjectData, chat control, task lifecycle, triggers, admin settings, GitHub, AI budgets)
through injected ports (`src/ports.ts`, `src/project-data-port.ts`, value shapes in
`src/port-types.ts`). The worker implements the ports once, in
`apps/api/src/operation-ports.ts` (`createOperationPorts(env)`, `operationDeps(env)`,
`webOperationContext`).

## Entry points

- `@simple-agent-manager/operations` (`src/index.ts`): named re-exports of what the worker uses.
  Add a name there when the worker needs it.
- `@simple-agent-manager/operations/internal/*`: one module by name, for `apps/api` tests only (a
  `vi.mock` of a public re-export does not reach imports made inside the package). The boundary
  lint rejects it from worker source and other packages.

## Key Files

| File                                                                 | Purpose                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/types.ts`                                                       | `Operation`, `OperationContext`, `OperationDeps`, `defineOperation`            |
| `src/ports.ts`, `src/project-data-port.ts`, `src/port-types.ts`      | Ports the worker implements, and the values that cross them                    |
| `src/env.ts`                                                         | `OperationsEnv`                                                                |
| `src/registry.ts`                                                    | The operation catalog shared by adapters, with JSON Schema export              |
| `src/authorization.ts`                                               | Scope, workspace-project and membership/capability checks                      |
| `src/*-operations.ts`                                                | Operation definitions by area (platform, connector, channels, schedules, team) |
| `src/*-core.ts`                                                      | Shared reads/writes the operations and worker routes call                      |
| `src/workspace-history.ts`, `src/session-list.ts`, `src/missions.ts` | Tool cores shared by workspace `sam-mcp` and /sam tools                        |

## Commands

```bash
pnpm --filter @simple-agent-manager/operations build      # Compile TypeScript
pnpm --filter @simple-agent-manager/operations test       # Package unit tests (Node)
pnpm --filter @simple-agent-manager/operations typecheck
pnpm --filter @simple-agent-manager/operations lint
```

The worker resolves this package from `dist/`: build it before typechecking or testing `apps/api`.

## Conventions

- A new dependency on another area is a new port method, implemented in
  `apps/api/src/operation-ports.ts`; never an import from the worker.
- Port value types mirror the worker type they name (comment on each); declare only what the
  operations read when a worker type is large.
- Tests that need the worker (real ports, worker service mocks, the D1 SQLite test helpers) stay in
  `apps/api/tests/unit/operations/`; pure tests live in `tests/unit/` here.
