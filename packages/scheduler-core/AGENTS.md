# Scheduler Core Package (packages/scheduler-core)

## Purpose

The pure decisions of the SAM scheduler: which capacity pool governs a run, how candidate
offerings and existing nodes are ranked, whether a node can hold a declared reservation, how
placement fields and resource requirements resolve, and the provider-limit wait policy. Every
function takes values and returns values. Part of the worker modularization
(`tasks/active/2026-11-12-worker-modularization.md`, workstream W2).

The package holds **no SQL text, no D1 or drizzle access, no Durable Object and no worker `Env`**.
The worker reads D1, calls these functions, and keeps everything that writes: the final
compare-and-swap reservation (`apps/api/src/services/workspace-placement.ts`), the SQL fragments
that compose it (`placement-authority.ts`, `capacity-pool-precedence.ts`,
`workspace-admission-sql.ts`, `capacity-placement-snapshot.ts`) and the D1 loaders
(`workspace-reservation-usage.ts`, `capacity-pool-placement-settings.ts`, `placement-resolver.ts`).
Advisory ranking here can be wrong without harm; the atomic reservation in the worker is the
correctness boundary. See `.claude/rules/69-aggregate-capacity-at-final-reservation.md`.

## Entry point

`@simple-agent-manager/scheduler-core` (`src/index.ts`) only. Named re-exports, curated to what the
worker and its tests use. Add a name there when the worker needs it; do not add subpath imports.

## Key Files

| File                                       | Purpose                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `src/placement-resolver-types.ts`          | Placement input/output types shared by every placement step              |
| `src/placement-field-resolution.ts`        | Per-field resolution of provider, location, size and credential source   |
| `src/resource-requirements-input.ts`       | Resource requirement layering, provenance and the resolved plan          |
| `src/placement-resolver-capacity*.ts`      | Capacity pool selection, candidate normalization and reuse snapshots     |
| `src/placement-capacity-ranking.ts`        | Candidate comparison (priority, price, fit) and price comparability      |
| `src/placement-strategy.ts`                | Host ordering per pool strategy (`pack`, `spread`, ...) and host signals |
| `src/placement-rollout.ts`                 | Rollout cohort for a placement strategy                                  |
| `src/placement-diagnostics.ts`             | Placement explanation records                                            |
| `src/capacity-pool-precedence.ts`          | Project → user → installation default pool precedence (no SQL)           |
| `src/capacity-pool-authority.ts`           | Authority generations and `timestampVersion`                             |
| `src/workspace-resource-capacity.ts`       | Reservation capacity evaluation against a node and its metrics           |
| `src/workspace-admission-policy.ts`        | Admission tunables, resolved from `WorkspaceAdmissionEnv`                |
| `src/workspace-reservation-usage.ts`       | Declared reservation usage shape and its parsers                         |
| `src/provider-limit-policy.ts`             | Provider usage-limit wait state and policy                               |
| `src/provisioning-attempt-limits.ts`       | Default attempt and retry caps for provisioning and placement            |
| `src/env.ts`                               | `WorkspaceAdmissionEnv`, which the worker `Env` extends                  |

## Commands

```bash
pnpm --filter @simple-agent-manager/scheduler-core build                   # Compile TypeScript
pnpm --filter @simple-agent-manager/scheduler-core test                    # Unit + simulation tests
pnpm --filter @simple-agent-manager/scheduler-core test:scheduler          # Scheduler simulations only
pnpm --filter @simple-agent-manager/scheduler-core test:scheduler:nightly  # Deeper simulation profile
pnpm --filter @simple-agent-manager/scheduler-core typecheck
pnpm --filter @simple-agent-manager/scheduler-core lint
```

The worker resolves this package from `dist/`: build it before typechecking or testing `apps/api`.

## Conventions

- Depends only on `@simple-agent-manager/shared` and `valibot` (from the pnpm catalog).
- No function accepts the worker `Env`. Read environment through `WorkspaceAdmissionEnv` or take
  explicit values.
- A function that needs SQL or storage belongs in the worker. Split the pure part out instead.
- `scripts/quality/node-pool-boundary` scans `packages/scheduler-core/src`; keep its path lists in
  step when files move.
- Tests that need a database, a Durable Object or worker modules stay in `apps/api/tests` and
  import this package through its entry point.
