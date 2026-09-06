# A Config Flip Ships Only When the Deployed Value Says So

## When This Applies

Any PR that changes a value in the top-level `[vars]` section of a `wrangler.toml`, adds a
new var there, or relies on a var being a particular value for a feature to run — feature
switches, cadences, budgets, kill switches. It applies with full force to values that gate
whether a scheduled sweep, alarm, or cleanup does any work at all, because those fail as an
**absence** (`.claude/rules/53`): nothing errors, nothing alerts, the work simply never happens.

## Why This Rule Exists

PR #2023 (2026-09-05) enabled the ProjectData archive drain by flipping
`PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED` from `"false"` to `"true"` in `apps/api/wrangler.toml`.
It merged, deployed cleanly, and the sweep never ran. `project_data_archive_global_sweep_cadence`
stayed empty for a day while the root object sat at 102% of its storage ceiling.

The deployed Worker carried `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED=false`. The GitHub
`production` Environment held a variable of the same name, created 2026-09-04T03:47Z as an
emergency brake, and `deploy-reusable.yml` passes every such variable through
`wrangler_sync_env` into `sync-wrangler-config.ts`, whose `getOptionalProcessEnvVars` spreads any
non-empty value **over** the checked-in `[vars]`. That is the designed override path and it worked
exactly as designed. What did not exist was any signal: the deploy log did not mention the
override, the PR's evidence was its own diff, and the one place the truth was visible — every
five-minute `cron.completed` log said `projectDataArchiveShardingSkipReason: "disabled"` — was
never read.

The fix was one deleted Environment variable. Finding it took three independent reads: the
`cron.completed` skip reason in Workers Observability, the deployed Worker's `plain_text` bindings
from the Cloudflare script-settings API, and the Environment variable list from the GitHub API.

## Class of Bug

**A checked-in default flipped while a deploy-time override pinned the old value, with the PR's
evidence being the diff rather than the deployed value.** The override layer is correct; the
bug is that a change to the lower layer looks complete and is not, and nothing in the pipeline
says so.

Tells:

- A PR whose entire diff is a `wrangler.toml` value change, described as "enable X".
- A var that a GitHub Environment has ever carried (emergency brakes are the usual reason).
- A sweep whose only failure mode is "did nothing", with no `cadence`/`last_run` row to prove it
  ran.
- Verification that stops at "deploy green".

## Hard Requirements

1. **Before merging a `wrangler.toml` var change, list the overrides.** Read the GitHub
   Environment variables for every environment the deploy targets and state, in the PR, whether
   the changed var is overridden there:

   ```bash
   gh api repos/<owner>/<repo>/environments/production/variables --paginate \
     | jq -r '.variables[] | "\(.name)=\(.value) (updated \(.updated_at))"' | grep <VAR>
   gh api repos/<owner>/<repo>/environments/staging/variables --paginate | ...
   ```

   If an override exists, the PR must either remove/update it (with the change recorded in the
   PR body, since it is not in git) or explain why the override must stay.

2. **After the deploy, verify the deployed value, not the diff.** Read the value the Worker
   actually runs with — the Cloudflare script-settings API
   (`GET /accounts/{id}/workers/scripts/<name>/settings`, `plain_text` bindings) — or the
   feature's own evidence (`cron.completed` skip reason, a cadence row's `run_count`, the
   `/admin/...` state endpoint). "Deploy green" proves the artifact uploaded, not what it contains.

3. **A gate that decides whether work happens must log its decision every time it declines.**
   `runProjectDataArchiveSharding` returns `skipReason` and the cron handler logs it; that is
   what made this diagnosable in one query. A new switch-gated sweep must do the same, and the
   skip reason must distinguish "disabled" from "not due" from "missing binding".

4. **The deploy log names every override that differs from the checked-in value.**
   `listEnvironmentVarOverrides` in `scripts/deploy/sync-wrangler-config.ts` prints
   `Environment override: NAME="x" replaces wrangler.toml "y"` for each one. Do not bypass it by
   adding a new spread of `process.env` values elsewhere; route new optional vars through the
   existing list.

## Required Evidence in the PR

- The override listing for staging and production (requirement 1), or "no overrides".
- The post-deploy deployed value (requirement 2), quoted from the API or the log line.
- For a new switch-gated loop: the log line that carries its skip reason.

## Quick Compliance Check

- [ ] GitHub Environment overrides listed for every target environment
- [ ] Any conflicting override removed or justified, and the change recorded in the PR
- [ ] Deployed value verified after deploy, from the script settings or the feature's own log
- [ ] The gate logs a distinguishable skip reason whenever it declines to work
- [ ] New optional vars go through the logged override path in `sync-wrangler-config.ts`

## References

- Task: `tasks/active/2026-09-06-archive-drain-enable-unfence-and-throughput.md` (moves to
  `tasks/archive/` on completion); PR #2023 (the flip), this fix's PR
- `scripts/deploy/sync-wrangler-config.ts` (`getOptionalProcessEnvVars`,
  `listEnvironmentVarOverrides`), `.github/workflows/deploy-reusable.yml` (`wrangler_sync_env`)
- `.claude/rules/07-env-and-urls.md` — how environment sections are generated
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md` — the symptom is an
  absence
- `.claude/rules/32-cf-api-debugging.md` — query the deployed state before guessing
