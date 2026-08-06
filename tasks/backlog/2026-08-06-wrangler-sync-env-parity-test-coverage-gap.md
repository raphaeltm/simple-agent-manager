# Wrangler sync env-parity test misses DO_MIGRATION_STATE_PROBE_* vars

## Problem

`scripts/quality/deploy-reusable-workflow.test.ts` enforces that both Wrangler config sync
invocations in `.github/workflows/deploy-reusable.yml` forward an identical env mapping:

- `Sync Wrangler Config (API + Tail Worker)`
- `Re-sync Wrangler Config (add tail_consumers)` (runs on first deploy, after the tail worker exists)

The test builds its required list two ways:

1. `DIRECT_SYNC_ENV_MAPPINGS` — a hand-maintained constant.
2. `extractOptionalWorkerEnvVars()` — dynamically scraped from the `getOptionalProcessEnvVars([...])`
   array in `scripts/deploy/sync-wrangler-config.ts`.

Neither covers `DO_MIGRATION_STATE_PROBE_ATTEMPTS` or `DO_MIGRATION_STATE_PROBE_RETRY_DELAY_MS`,
because those reach the script through a separate `readBoundedIntEnv` call in
`scripts/deploy/durable-object-migrations.ts` rather than through `getOptionalProcessEnvVars`.

So if a future change drops either var from one of the two sync steps, **no test fails.**

## Why it matters

`generateApiWorkerEnv` regenerates `[env.*]` from scratch on every invocation — it does not merge with
prior state. Anything missing from the re-sync step's `process.env` is silently dropped from the
regenerated config on the second `wrangler deploy` of a first-time install.

Severity is bounded but real: omitting these two falls back to the documented defaults
(`DO_MIGRATION_STATE_PROBE_ATTEMPTS` = 3 attempts, `DO_MIGRATION_STATE_PROBE_RETRY_DELAY_MS` = 2000ms)
rather than bypassing the fail-closed migration-tag check. So it degrades retry tuning, it does not
disable the Durable Object migration safety guard. That is why this is a follow-up and not a blocker.

This is the same *class* of drift that PR #1697's merge already had to repair by hand: before that
merge, main's re-sync step was missing 26 vars relative to its own primary step, and the PR branch's
re-sync step had independently drifted 10 `PLATFORM_FEEDBACK_*` vars behind its own primary step.
Both drifts existed precisely because the automated parity check did not cover them. The recurring
lesson is that a partially-derived allowlist invites exactly this drift.

## Context

Discovered by the `cloudflare-specialist` review during PR #1697 (merge of `origin/main` into the
strict-CTO remediation bundle, 2026-08-06). At that time both vars **are** correctly present in both
steps — verified by direct grep — so there is no live bug today, only a missing guardrail.

## Acceptance Criteria

- [ ] The parity test covers `DO_MIGRATION_STATE_PROBE_ATTEMPTS` and
      `DO_MIGRATION_STATE_PROBE_RETRY_DELAY_MS`, either by extending `DIRECT_SYNC_ENV_MAPPINGS` or by
      also scraping `readBoundedIntEnv` call sites in `scripts/deploy/durable-object-migrations.ts`.
- [ ] Prefer a derivation that cannot silently miss a *future* var read through a third mechanism —
      e.g. scrape every `process.env.X` read reachable from `sync-wrangler-config.ts` and assert each
      appears in both steps, rather than maintaining another hand-written allowlist.
- [ ] The test is proven discriminating: temporarily delete one of the two vars from the re-sync step
      and confirm the test goes red before relying on it.
- [ ] No production behavior change — this is test-coverage hardening only.

## References

- `scripts/quality/deploy-reusable-workflow.test.ts` (`uses one complete env mapping for every
  Wrangler config sync invocation`)
- `scripts/deploy/durable-object-migrations.ts` (`readBoundedIntEnv`)
- `.claude/rules/07-env-and-urls.md` — Wrangler binding + DO migration safety rules
- PR #1697; main's DO-migration-compat work in #1649
