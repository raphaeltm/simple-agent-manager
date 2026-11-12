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
- `services/cache-config.ts` (11 lines, domain-free TTL parsing, used by repo-hosting and three
  worker files): proposed for worker-core (flagged to the coordinator).
- Old worker paths keep named re-exports (`services/github-*.ts`, `services/gitlab.ts`,
  `services/repo-browse/index.ts`), limited to the names the worker imports.
- Tests that stay in the worker, because they need worker code: `github-user-access-token` and
  `gitlab-user-access-token` (token-lock DO helpers, Better Auth mocks), `ensure-branch-exists`
  (admin-settings SQLite helper and real platform config), `github-installations` and
  `repo-browse-routes` (routes), `auth-github-refresh` (Better Auth), `github-installation-upserts`
  (worker SQLite helper).

## Checklist

- [x] Package scaffold (W0 template), entries
- [x] Move files; ports; narrow env; re-exports at old paths
- [x] Tests that do not need the worker pool move with the code; counts before/after
- [x] Wiring: ci.yml filters, runtime-boundary scan, ast-checks roots, dependency evidence,
      build order, source scanners, docs/rules paths
- [ ] Lint, typecheck, tests, quality scripts; reviews; CI green; report to coordinator

## Progress notes

- 2026-11-12: scope measured, plan recorded.
- 2026-11-12: move and rewiring pushed (2ed9f2977 pure `git mv`, 519f91b8a rewiring).
  - Ports: `platformConfig` and `auth`, one worker module each in `apps/api/src/repo-hosting-ports/`,
    installed by `apps/api/src/repo-hosting-wiring.ts` (first import of the entry). Unit tests
    install them per port in `tests/setup/repo-hosting-ports.ts`; the workerd pool in
    `tests/workers/setup-repo-hosting-ports.ts`. `tests/unit/repo-hosting-wiring.test.ts` fails
    when the entry import is removed (checked).
  - Tests: 13 files / 139 tests moved into `packages/repo-hosting/tests/unit/`. Three worker tests
    that assert log calls (github-installations, gitlab-user-access-token, ensure-branch-exists)
    now mock worker-core's logger, which the moved code imports.
  - `cache-config` TTL parsing moved to worker-core (old path re-exports) — flagged to the
    coordinator, since worker-core additions need two package users (repo-hosting + worker).
  - Gitleaks: three reviewed PEM delimiter literals in `github-app-tokens.ts` re-recorded at the
    new path.
- 2026-11-12: task-completion validator PASS (no CRITICAL/HIGH; LOW notes recorded above).
- 2026-11-12: review fixes. Security review: PASS (3 LOW, left as is to keep the move behavior-free:
  unconfigured auth port reads as "token unavailable" like the code it replaced; registry is not
  write-once, same as W1). Architecture review addressed: public index trimmed to the names the worker
  imports (old-path re-exports likewise); dead `services/user-access-token.ts` removed; the port API
  lives only in `./ports`; workerd pool installs the wiring lazily in `setup-d1-migrations.ts`;
  registry builds its view once and replaces on install; one `ArtifactsBinding` type; var-default
  scanner and `no-console` cover `packages/repo-hosting/src`. Full API unit suite: 0 failed
  assertions; the only file that fails to load is `secret-request-delivery-guard.test.ts`, which
  also fails on core (imports a module W1 moved; reported to the coordinator).
