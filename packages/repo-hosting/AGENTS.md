# Repo Hosting Package (packages/repo-hosting)

## Purpose

Repository hosting for the API worker: GitHub App installation tokens and JWTs, GitHub user OAuth
tokens and refresh, installation account bookkeeping, the repo-id backfill and installation leak
sweep, the workspace GitHub CLI policy, GitLab OAuth and API calls, and read-only repository
browsing (`src/repo-browse/`: GitHub, GitLab and Artifacts). Extracted from `apps/api` by the
worker modularization (`tasks/archive/2026-11-12-worker-modularization.md`, W7).

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

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

- `.claude/rules/28-credential-resolution-fallback-tests.md`: Credential Resolution, Fallback, and Rotation Safety Tests
- `.claude/rules/41-credential-snapshot-resilience.md`: Credential Snapshot/Resolution Must Tolerate a Single Bad Row
- `.claude/rules/51-runtime-boundary-validation.md`: Runtime boundary validation
- `.claude/rules/60-request-io-and-bundle-budgets.md`: Request I/O and Client Bundle Budgets
- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State
- `.claude/rules/75-external-api-check-then-act.md`: A Conflict From a Remote Uniqueness Constraint Is a Signal, Not a Failure

<!-- END GENERATED RULE INDEX -->
