# Manual self-host production deploy documentation

## Problem

Forked SAM installations no longer update by simply pushing or syncing `main`. The CI workflow skips full `main` push CI in forks, so the production deployment workflow is not automatically triggered through the `workflow_run` path for self-host updates. Operators must manually run **Actions → Deploy Production → Run workflow** in their fork when they want to deploy the current `main` branch to their SAM instance.

Current guidance still contains stale “push to main automatically deploys” wording in several current docs and setup surfaces, which can leave self-hosters thinking their instance updated when only the fork branch changed.

## Research findings

- `.github/workflows/ci.yml` intentionally skips full CI on `push` to `main` in forks: `jobs.changes.if` only allows pull requests or `raphaeltm/simple-agent-manager`. Because `deploy.yml` auto-deploys through a successful `CI` `workflow_run`, fork `main` pushes do not use that auto-deploy path.
- `.github/workflows/deploy.yml` still allows manual production deployment through `workflow_dispatch`, and this is the correct self-host update path.
- `apps/www/src/content/docs/docs/guides/self-hosting.mdx` already tells first-time deployers to run **Deploy Production** manually, but it does not explicitly document the ongoing update workflow after pulling upstream changes.
- `apps/www/src/pages/self-host/index.astro` has correct final deploy-step copy, but its fork rationale still says pushing to `main` triggers the pipeline.
- `apps/www/src/content/docs/docs/quickstart.md`, `README.md`, `apps/www/src/content/docs/docs/architecture/overview.md`, `apps/www/src/content/docs/docs/guides/local-development.md`, and `CLAUDE.md` contain current “push/merge to main triggers production deployment” wording that should be scoped to the canonical repo or replaced with manual self-host guidance.
- Historical blog posts mention older behavior. These are dated records and should not be rewritten for this current-docs task.

## Implementation checklist

- [x] Update public self-host guide with an explicit “Updating an existing self-hosted instance” section: sync/pull upstream into the fork’s `main`, then manually run **Deploy Production** on `main`.
- [x] Update public quickstart self-host steps to use manual **Deploy Production** instead of “push to main”.
- [x] Update public architecture/local-development wording so auto production deployment is scoped to the canonical repo, while fork/self-host updates use manual deploy.
- [x] Update the self-host wizard copy that currently says pushing to `main` triggers the pipeline.
- [x] Update README quick deploy copy to avoid stale “fork, configure, push” instructions.
- [x] Update internal agent guidance in `CLAUDE.md` so post-merge monitoring remains true for the canonical repo and does not imply all forks deploy automatically on push.
- [x] Search for remaining current stale references after edits.

## Acceptance criteria

- Current public docs and setup surfaces tell self-host operators to manually trigger **Deploy Production** when updating a forked SAM instance.
- The docs distinguish canonical repository auto-deploy behavior from self-host fork update behavior.
- No current docs still instruct self-hosters that pushing to `main` is sufficient to deploy an update.
- Documentation-only validation passes or is scoped to the changed docs site/package.
