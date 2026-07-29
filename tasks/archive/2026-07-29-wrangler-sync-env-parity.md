# Wrangler sync env parity for first deploy

## Problem statement

`.github/workflows/deploy-reusable.yml` runs `scripts/deploy/sync-wrangler-config.ts` twice on first deploys: the initial config sync and a re-sync after the tail worker exists. The initial sync passes cf-container, sandbox, and setup tuning environment variables, but the first-deploy re-sync omits them. Because `sync-wrangler-config.ts` reads those values from `process.env` and defaults `CF_CONTAINER_ENABLED` to `true`, a first deploy can silently re-enable Cloudflare Containers or drop operator-provided timeout/capacity tunables.

This PR must be tightly scoped: make the mapping deterministic and test it.

## Research findings

- `scripts/deploy/sync-wrangler-config.ts` builds Worker vars in `getApiWorkerVars()`.
- Optional Worker vars consumed by the script are listed in the `getOptionalProcessEnvVars([...])` call.
- The workflow has two `pnpm tsx scripts/deploy/sync-wrangler-config.ts` invocations:
  - `Sync Wrangler Config (API + Tail Worker)`
  - `Re-sync Wrangler Config (add tail_consumers)`
- Existing quality tests in `scripts/quality/deploy-reusable-workflow.test.ts` already inspect workflow step blocks and are the right place for a deterministic regression test.
- `.claude/rules/07-env-and-urls.md` records that wrangler env sections are generated at deploy time and that Miniflare tests do not catch `wrangler.toml` generation mistakes.
- Prior incident lesson: `tasks/archive/2026-07-19-fix-instant-container-clone-timeout.md` notes env-validator findings where new cf-container env vars were not wired through deploy pipeline allowlists.

## Checklist

- [x] Centralize the sync env mapping for all `sync-wrangler-config.ts` workflow invocations.
- [x] Ensure first sync and first-deploy re-sync receive identical optional Worker env inputs.
- [x] Include all env vars consumed by `getOptionalProcessEnvVars()`, including currently missing `CF_CONTAINER_ACTIVE_WORK_MAX_MS`, `CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS`, and `CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`.
- [x] Preserve existing behavior when GitHub vars/secrets are absent.
- [x] Add a workflow quality test that derives consumed optional env vars from `sync-wrangler-config.ts` and fails if any sync invocation does not use the centralized mapping.
- [x] Add a process note to prevent future duplicated deploy sync env blocks.
- [x] Run relevant local tests and full quality gates.
- [x] Run local env-validator and test-engineer reviews before PR completion.
- [ ] Open a narrow PR and do not merge.

## Acceptance criteria

- Both deploy-reusable sync invocations use the same env mapping for `sync-wrangler-config.ts`.
- A test fails if a sync invocation omits any direct sync env or optional Worker var consumed by `sync-wrangler-config.ts`.
- Defaults and behavior remain unchanged when vars are absent.
- CI is green on the PR.
- PR is left open/unmerged.

## Post-mortem

- **What broke**: First deploys could re-run wrangler config generation without the same operator overrides used by the initial sync. That could produce a different API Worker env section during the tail-consumer re-sync.
- **Root cause**: The workflow duplicated the env mapping inline for each sync invocation, and the second block drifted behind the first.
- **Timeline**: The drift was found by strict CTO infra review task `01KYQHJJM4W83JKKDKTTPA9CNF` and remediated in this task.
- **Why it wasn't caught**: Existing workflow quality tests checked selected vars on the initial sync only and did not derive expected coverage from the env vars consumed by `sync-wrangler-config.ts`.
- **Class of bug**: Duplicated deployment env mappings across multi-phase deploy workflows.
- **Process fix**: Add a project rule note and a regression test that requires sync invocations to share a centralized mapping and keeps it aligned with `sync-wrangler-config.ts`.

## References

- `.github/workflows/deploy-reusable.yml`
- `scripts/deploy/sync-wrangler-config.ts`
- `scripts/quality/deploy-reusable-workflow.test.ts`
- `.claude/rules/07-env-and-urls.md`
- `tasks/archive/2026-07-19-fix-instant-container-clone-timeout.md`
