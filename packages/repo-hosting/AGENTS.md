# Repo Hosting Package (packages/repo-hosting)

## Purpose

Repository hosting for the API worker: GitHub App installation tokens and JWTs, GitHub user OAuth
tokens and refresh, installation account bookkeeping, the repo-id backfill and installation leak
sweep, the workspace GitHub CLI policy, GitLab OAuth and API calls, and read-only repository
browsing (`src/repo-browse/`: GitHub, GitLab and Artifacts). Extracted from `apps/api` by the
worker modularization (`tasks/active/2026-11-12-worker-modularization.md`, W7).

The package imports nothing from `apps/*`. It depends on `@simple-agent-manager/shared` and
`@simple-agent-manager/worker-core` (kernel helpers, D1 tables from `./schema`). HTTP routes stay
in the worker as thin adapters. What the package needs from other areas of the worker goes
through `RepoHostingPorts` (`src/ports.ts`):

| Port             | Worker implementation                                | Why it is a port                                                |
| ---------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `platformConfig` | `apps/api/src/repo-hosting-ports/platform-config.ts` | GitHub App and OAuth settings resolve D1 overrides over env     |
| `auth`           | `apps/api/src/repo-hosting-ports/auth.ts`            | Better Auth owns OAuth token storage; only the worker builds it |

`apps/api/src/repo-hosting-wiring.ts` installs both; the worker entry imports it first.
`@simple-agent-manager/repo-hosting/ports` is the registry alone (no runtime imports), for test
setup that must not load the package's D1 schema.

Webhook and trigger processing (`github-trigger-*`, `github-project-event-*`,
`github-pull-request-*`) stays in the worker: it depends on triggers, ProjectData and route
authorization helpers.

## Invariants

- `RepoHostingEnv` (`src/env.ts`) lists every binding and variable the package reads; the worker
  `Env` extends it. Never accept the worker's full `Env`.
- A port method takes the narrow env; the worker widens it in its port module.
- `RepoHostingRequestContext` is structural (`{ env, req: { raw } }`) so the package does not
  depend on Hono; a Hono context satisfies it.

## Commands

```bash
pnpm --filter @simple-agent-manager/repo-hosting build      # the worker resolves dist/: build before api typecheck/tests
pnpm --filter @simple-agent-manager/repo-hosting typecheck
pnpm --filter @simple-agent-manager/repo-hosting test
pnpm --filter @simple-agent-manager/repo-hosting lint
```

Tests that need the worker (real platform config, Better Auth, token-lock Durable Objects, routes)
stay in `apps/api/tests/`.
