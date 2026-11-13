# App Deployment Package (packages/app-deployment)

## Purpose

The worker side of SAM app deployments: Compose rendering and compose-publish apply, release
routing, provider-backed volumes, custom domains, environment config and state, publish jobs,
release events and failure recording, image tag resolution, and their two scheduled sweeps.
Part of the worker modularization (`tasks/archive/2026-11-12-worker-modularization.md`, W4).

The package imports nothing from `apps/*`. It reads only `AppDeploymentEnv` (`src/env.ts`); the
worker's `Env` extends it. Anything another area owns comes in through a port (`src/ports.ts`).

Not here: node admission, provisioning, legacy binding and node teardown for deployments
(`apps/api/src/services/deployment-{node-admission,provisioning,legacy-node-admission,legacy-binding,node-cleanup}.ts`).
They build the node-reservation and teardown SQL with compute code, so they stay in the worker and
import this package's entry point. HTTP routes also stay in the worker. The VM agent's Go `deploy`
and `publish` packages are separate.

## Entry points

| Import                                           | Contents                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `@simple-agent-manager/app-deployment`           | Services, `AppDeploymentEnv`, port types (`src/index.ts`)                                      |
| `@simple-agent-manager/app-deployment/scheduled` | Cron sweeps (`src/scheduled/index.ts`), kept separate so importing services does not load them |

## Ports

| Port                        | Worker implementation (`apps/api/src/app-deployment-ports/`)    | Used by                             |
| --------------------------- | --------------------------------------------------------------- | ----------------------------------- |
| `DeploymentProviderPort`    | `providers.ts` (provider credential resolution)                 | volume create/attach/detach/delete  |
| `DeploymentSecretCipher`    | `secret-cipher.ts` (AES-GCM bound to a caller-chosen key)       | environment config read/write       |
| `DeploymentPublishJobPorts` | `publish-jobs.ts` (admin settings, VM cancel, lifecycle events) | publish-job settings, cancel, sweep |

Each worker implementation lives in its own file so a route that needs one port does not load the
others' dependencies.

## Key Files

| File                                   | Purpose                                                         |
| -------------------------------------- | --------------------------------------------------------------- |
| `src/compose-renderer.ts`              | Renders a release's Compose YAML with volumes and secrets       |
| `src/compose-publish-apply.ts`         | Validates and rewrites agent-published Compose documents        |
| `src/compose-image-artifacts.ts`       | R2 presigned uploads and descriptors for docker-save artifacts  |
| `src/deployment-routing.ts`            | Public route discovery, host-port assignment, route targets     |
| `src/deployment-volumes.ts`            | Provider-backed volume lifecycle                                |
| `src/deployment-control.ts`            | Agent deployment policy and observed state                      |
| `src/deployment-environment-config.ts` | Environment variables and encrypted secrets                     |
| `src/deployment-publish-jobs.ts`       | Durable publish-job records and events                          |
| `src/image-resolver.ts`                | Registry tag-to-digest resolution with bounded outbound fetches |
| `src/scheduled/*.ts`                   | Compose artifact cleanup and publish-job sweep                  |

The worker keeps a re-export file at each old path (`apps/api/src/services/<module>.ts`,
`apps/api/src/scheduled/<module>.ts`), so its importers and their `vi.mock` paths are unchanged.

## Commands

```bash
pnpm --filter @simple-agent-manager/app-deployment build      # the worker resolves dist/
pnpm --filter @simple-agent-manager/app-deployment test
pnpm --filter @simple-agent-manager/app-deployment typecheck
pnpm --filter @simple-agent-manager/app-deployment lint
```

## Conventions

- Rebuild after editing `src/` before typechecking or testing `apps/api`.
- `tests/unit/` runs in Node. Tests that need the worker's SQLite helpers, routes or the Workers
  pool stay in `apps/api/tests/`.
- A `vi.mock` of an old worker path does not reach imports made inside this package. Inject a fake
  port, or mock the package specifier (`@simple-agent-manager/worker-core`,
  `@simple-agent-manager/worker-core/schema`) with `importOriginal`.
