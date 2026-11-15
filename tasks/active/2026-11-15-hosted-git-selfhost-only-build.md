# H1: HostedGitRepo and vendored git only in the self-host build

SAM task 01M7FD35V96T27PFA4G97C5DKE. Coordinator task 01M7FB384QHQ1TQCK95D0SX0TX.
Branch `sam/task-h1-self-host-7c5dke`, base `sam/selfhost-pass-2` (head 4e88377be at start).
Draft PR against the integration branch; do NOT merge. No staging (this branch never deploys
to Cloudflare staging). No self-host test box (another agent holds it).

## Problem

The owner decided on November 14, 2026 that code only the VM install needs belongs in a second
build, not dormant in the Cloudflare production Worker. On the integration branch the shared
entry (`apps/api/src/index.ts`) exports `HostedGitRepo` and mounts the `/git/*` route, and
`apps/api/wrangler.toml` declares the `HOSTED_GIT` binding and migration `v23`
(`new_sqlite_classes = ["HostedGitRepo"]`). That puts the Durable Object, the vendored dgit core
and pako 2 in the Cloudflare bundle and an irreversible migration in the Cloudflare history. Until
this moves, nothing that touches hosted git can land on main (landing plan part 6, D7; C17; F27).

## Research findings

- `index.ts:20` exports HostedGitRepo; `index.ts:182-183` import `isLocalHostedGitActive`,
  `handleHostedGitRequest`, `HOSTED_GIT_PATH_PREFIX`; `index.ts:262` mounts `app.all('/git/*')`
  after preview, pages-proxy, ws-proxy, request logging, analytics and CORS middleware, inside
  `app.fetch(request, withRequestScopedD1Bindings(env))`.
- Nothing registered after `index.ts:262` matches `/git/*` (only `/health`, `/api/*`, `/oidc`,
  `/.well-known/*`, `/ai/*`, `/auth/google`, `/mcp/*`, `/connect/mcp`, and connector-oauth's
  `/oauth/*` + `/.well-known/*`). So appending the route after index.ts finishes registering gives
  the same handler chain for `/git/*` requests.
- Only `durable-objects/hosted-git-repo.ts`, `hosted-git-gc.ts`, `hosted-git-ls-refs.ts` import
  `vendor/dgit/**`; only `vendor/dgit/git/zlib.ts` imports pako 2. The seam
  (`services/hosted-git/backend.ts`, `http.ts`, `tokens.ts`, `limits.ts`, `import.ts`,
  `routes/projects/hosted-git-token.ts`, `crud.ts`, `project-create.ts`, `workspaces/runtime.ts`,
  `repo-hosting-ports/artifacts.ts`, `platform-capabilities.ts`) reaches the Durable Object only
  through the `HOSTED_GIT` namespace binding (`stub.fetch`), never by importing the class. The seam is
  landing-plan row L16 and stays in the shared code.
- pako 1.0.11 in the bundle comes from isomorphic-git (main ships it too); pako 2.2.0 is dgit's.
- Generated celld entry: `scripts/selfhost/celld-project.ts` (`renderRuntimeSecretsMain` wraps every
  configured DO class as `api.<Class>`; `renderPlainMain`). celld config:
  `scripts/selfhost/celld-config.ts` translates wrangler.toml's `durable_objects` and `migrations`.
- celld migrations (0.6.3): validated declaratively (duplicate tag, class introduced twice, SQLite
  class must be declared; rename/delete/transfer refused). Experiment with `celld dev` (state kept
  across restart): a HostedGitRepo object written under tag `v23` still returns its data after the
  same class is declared under tag `selfhost-hosted-git-v1`. `celld deploy` bucket mode not run
  locally (no Docker for MinIO here).
- Tests: `pnpm --filter @simple-agent-manager/api test:hosted-git` (vitest.hosted-git.config.ts,
  wrangler dry-run bundle + Miniflare + real git) runs in no CI job. Its test entry duplicates the
  index.ts mount by hand.
- `scripts/quality/do-migration-compatibility.test.ts` was changed on the branch for v23; main's
  version expects v22 as the last tag.
- Docs: `deploy/selfhost/README.md` "SAM-hosted repositories" says the route is "the existing
  catch-all route"; `tokens-and-limits.test.ts` comment says the binding exists on every deploy.
- Bundle before (top-level config, `wrangler deploy --dry-run --containers-rollout=none --outdir`):
  index.js 32,960,087 bytes, 6,149,156 gzip -9.

## Implementation checklist

- [ ] `apps/api/src/app.ts`: the Hono app instance; index.ts registers onto it
- [ ] `apps/api/src/selfhost/hosted-git.ts`: re-export HostedGitRepo, `mountHostedGitRoute(app)`
- [ ] index.ts: drop HostedGitRepo export, hosted-git imports and the `/git/*` mount
- [ ] wrangler.toml: drop HOSTED_GIT binding and v23 (DO bindings + migrations == origin/main)
- [ ] celld-config.ts: add the self-host Durable Object binding + `selfhost-hosted-git-v1`
      migration after wrangler.toml's, refusing duplicates
- [ ] celld-project.ts: generated entry (both modes) imports the self-host module, mounts the
      route and exports (wrapped) HostedGitRepo
- [ ] hosted-git test entry uses `mountHostedGitRoute` (the real mount)
- [ ] Quality check: import graph from index.ts must not reach the self-host-only files or pako 2;
      wrangler.toml must not name HostedGitRepo/HOSTED_GIT
- [ ] Test: `/git/*` handler chain on the self-host app == shared middleware chain + git route
- [ ] celld-config/project tests updated for the new binding, migration and entry
- [ ] do-migration-compatibility.test.ts back to main's version
- [ ] CI: run test:hosted-git in the self-host job
- [ ] Docs: deploy/selfhost/README.md, comments in env.ts/backend.ts/tests
- [ ] Bundle after: hosted-git DO, dgit, pako 2 absent; sizes before/after in PR

## Acceptance criteria

- [ ] wrangler.toml DO bindings and [[migrations]] byte-identical to origin/main
- [ ] index.ts has no hosted-git imports
- [ ] Cloudflare dry-run bundle has no HostedGitRepo, vendor/dgit or pako 2
- [ ] Generated celld config declares HOSTED_GIT/HostedGitRepo and its migration; generated entry
      exports the class and mounts the route
- [ ] `test:hosted-git` passes; selfhost tests pass; quality:wrangler-bindings and
      do-migration-compatibility pass
- [ ] Guard test fails when index.ts imports hosted git again (proved once)

## Notes

- Box round (later, coordinator schedules): see PR body.
