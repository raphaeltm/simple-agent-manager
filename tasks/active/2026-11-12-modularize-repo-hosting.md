# W7: extract repo hosting into `@simple-agent-manager/repo-hosting`

Workstream W7 of `tasks/active/2026-11-12-worker-modularization.md` (the brief overrides the usual
`/do` defaults). Assigned by the coordinator (task `01M77BJHHNW5714E98DEEMBCZA`) to the W1 agent
after W1 merged into core. Branch `sam/w7-repo-hosting` from core `6b985656b`; draft PR into the
core branch.

## Scope (measured 2026-11-12 on 6b985656b)

Brief scope: `services/github*`, `services/gitlab.ts`, `services/repo-browse/**` (36 files,
7,190 lines). Moving 25 files / ~4,480 lines:

- GitHub App and user OAuth: `github-app*.ts`, `github-cli-policy.ts`,
  `github-installation-{accounts,ids,leak-sweep}.ts`, `github-oauth-refresh.ts`,
  `github-project-repositories.ts`, `github-repo-id-backfill.ts`, `github-route-helpers.ts`,
  `github-user-access-token.ts`
- `gitlab.ts`, `repo-browse/**`
- `services/user-access-token.ts` (used only by the GitHub/GitLab token code and the worker's
  token-lock DO)

Staying in the worker, with reasons:
- `github-trigger-*` (8 files): trigger domain; main changes trigger files often (signed webhooks
  #2664, secret requests #2688). Coordinator: avoid trigger and webhook files.
- `github-project-event-producer.ts`, `github-project-event-display.ts`,
  `github-pull-request-events.ts`: webhook-event processing; they depend on the trigger filter,
  ProjectData, operations and admin settings.
- `github-pull-request-branch.ts`: depends on the route authorization helper
  `routes/projects/_helpers.ts#requireRepositoryAccess`.

## Design

- Narrow `RepoHostingEnv`; the worker `Env` extends it.
- Ports (registry, as W1's `ProjectDataPorts`, installed by the worker entry): platform config
  (`getGitHubAppConfig`, `getGitHubOAuthConfig`, `getGitLabOAuthConfig`) and Better Auth access
  tokens (`getBetterAuthAccessTokenForProvider`, which needs `createAuth`).
- Kernel helpers from worker-core; D1 tables from `@simple-agent-manager/worker-core/schema`.
- `services/cache-config.ts` (11 lines, domain-free TTL parsing, used by repo-hosting and five
  worker files): proposed for worker-core (flagged to the coordinator).
- Old worker paths keep named re-exports.

## Checklist

- [ ] Package scaffold (W0 template), entries
- [ ] Move files; ports; narrow env; re-exports at old paths
- [ ] Tests that do not need the worker pool move with the code; counts before/after
- [ ] Wiring: ci.yml filters, runtime-boundary scan, ast-checks roots, dependency evidence,
      build order, source scanners, docs/rules paths
- [ ] Lint, typecheck, tests, quality scripts; reviews; CI green; report to coordinator

## Progress notes

- 2026-11-12: scope measured, plan recorded.
