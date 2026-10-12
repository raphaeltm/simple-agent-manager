# Worker Text-Binding Headroom: Stop Shipping Default-Valued Vars

- **SAM task**: `01M4MZTMG7RHYYFZXXNNQSDSAR` (Wave E, channel `reliability-wave-1011`)
- **Branch**: `sam/wave-e-reliability-wave-qsdsar`
- **Created**: 2026-10-11

## Problem

The production API Worker is close to Cloudflare's per-Worker text-binding limit, and the
deploy-time guard will soon refuse production deploys.

Verified 2026-10-11 through the Cloudflare script-settings API and the repo:

- `sam-api-prod` has 296 `plain_text` + 25 `secret_text` = **321** text bindings
  (`sam-api-staging`: 301 + 26 = 327 from a branch deploy).
- `assertWorkerTextBindingLimit` (`scripts/deploy/sync-wrangler-config.ts`) fails the deploy
  above **340** (350 Cloudflare max − 10 headroom). Its count is emitted vars **plus all 38**
  `set_worker_secret` names in `configure-secrets.sh`, so production already sits at
  ~296 + 38 = **334 / 340**.
- `apps/api/wrangler.toml` `[vars]` has **283** entries and grew net +9 since 2026-09-26
  (~0.6/day). Staging branches hit 341 and 344 on 2026-10-10.
- The planned operator kill switches (idea `01M47V0101CAM43ZNZN4JHB4AK`) would use most of the
  remaining room.

Most `[vars]` entries restate the value the code already uses when the var is absent
(`DEFAULT_*` constants and parse fallbacks). Each costs a binding and buys nothing.

## Research Findings

- `getApiWorkerVars` (`scripts/deploy/sync-wrangler-config.ts`) spreads every top-level `[vars]`
  entry into the generated `[env.*].vars`, then overwrites `BASE_DOMAIN`, `VERSION`,
  `R2_BUCKET_NAME`, `VM_INCIDENT_R2_PREFIX`, `VM_INCIDENT_RETENTION_DAYS` and `AI_GATEWAY_ID`
  with derived values (so those 6 checked-in values never ship and are out of scope), then spreads
  `getOptionalProcessEnvVars(...)`: any listed name with a non-empty GitHub Environment value is
  emitted verbatim. Removing a name from `wrangler.toml` therefore does NOT stop an override for it.
- `listEnvironmentVarOverrides(checkedIn, overrides)` only reports overrides of names present in
  `wrangler.toml`. Removing a var would silently drop its override from the deploy log / job
  summary (rule 70 signal) unless the comparison base includes the recorded code default.
- Precedent: commit `0e8dbc0f7` (2026-09-13, "fix: reduce eventing worker text bindings") removed
  76 default-valued vars from `wrangler.toml`; `wrangler.toml` already says "Keeping default values
  out of [vars] preserves Worker text-binding headroom."
- GitHub Environment overrides (2026-10-11): production 46 variables, staging 16, repo 1
  (`SONAR_CI_ENABLED`, unrelated). Several are not forwarded to the Worker at all
  (e.g. `CODEX_SETUP_TERMINAL_ENABLED`, `SANDBOX_PROBE_OUTPUT_MAX_CHARS`,
  `SANDBOX_SETUP_PROBE_TIMEOUT_MS`) — pre-existing, out of scope.
- `deploy-reusable.yml` passes optional vars to BOTH "Sync Wrangler Config" steps (initial sync
  and first-deploy tail re-sync); `scripts/quality/deploy-reusable-workflow.test.ts` enforces both.
  This change does not add or remove optional names, so the mapping is untouched.
- CI gap: the `deploy-scripts` job (which runs `scripts/quality/sync-wrangler-config.test.ts`,
  including the text-binding guard test) is path-filtered on `scripts/deploy/**` etc. but NOT on
  `apps/api/wrangler.toml`, so a `wrangler.toml`-only PR that crosses the guard is not caught
  before deploy.
- Tests that read shipped `[vars]` from `wrangler.toml`: `apps/api/tests/helpers/shipped-archive-budget.ts`,
  `archive-sweep-ceiling.ts`, `sweep-message-budget-shipped.test.ts`, `write-budget-*.test.ts`,
  `task-runner-do-infra.test.ts` (`DEFAULT_TASK_AGENT_TYPE`).
- Measurement (per-var read sites, code default, classification): see "Measurement" below.

## Measurement

Ten parallel read-only audits covered every `[vars]` entry: each found every production read site
(including forwarding to cloud-init / the VM agent), compared the behaviour with the var absent
against the `wrangler.toml` value, and most also executed the real resolvers both ways. Raw results
were kept locally under `.tmp/wave-e/` (gitignored).

| Class                               | Count | Notes                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overwritten by the deploy generator | 6     | `BASE_DOMAIN`, `VERSION`, `R2_BUCKET_NAME`, `VM_INCIDENT_R2_PREFIX`, `VM_INCIDENT_RETENTION_DAYS`, `AI_GATEWAY_ID`: the checked-in value never ships (local dev only)                                                                                                                                                                                                                               |
| Equal to the code default           | 258   | includes 2 dead vars nothing reads (`ACTIVITY_RETENTION_DAYS`; `TRIAL_DATA_RETENTION_HOURS`, whose only reader `resolveRetentionHours` had no caller)                                                                                                                                                                                                                                               |
| Differs from the code default       | 13    | `PROJECT_DATA_GROUPED_FTS_CLEANUP_RECHECK_MS`, `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET`, `_WRITE_ESTIMATE_FACTOR`, `_GLOBAL_SWEEP_INTERVAL_MS`, `_SWEEP_SESSIONS`, `_SWEEP_MESSAGE_BUDGET`, `_WALL_TIME_MS`, `SESSION_IDLE_TIMEOUT_MINUTES`, `DEVCONTAINER_CACHE_REPOSITORY_PREFIX`, `AI_PROXY_DEFAULT_MODEL`, `SAM_MODEL`, `MAX_TRIGGERS_PER_PROJECT`, `PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED` |
| Required (feature off when absent)  | 6     | `PROJECT_DATA_ARCHIVE_SHARDING_ENABLED`, `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED`, `PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED`, `AGENT_MESSAGE_CHANNELS_ENABLED`, `PROJECT_EVENT_WAKE_ENABLED`, `DEVCONTAINER_CACHE_ENABLED`                                                                                                                                                                        |

No var is "required with no default": every one has a code fallback.

Of the 258 equal-to-default vars:

- **178 removed** — every read site is reachable through callable production code (exported
  resolvers, or a pure function exported for the proof test), proven by
  `apps/api/tests/unit/config/omitted-worker-var-defaults.test.ts`.
- **2 deleted outright** as dead config (above), with their type declarations, test-pool bindings,
  docs rows and the dead resolver.
- **78 kept** because a read site is inline in a large handler/DO, on the VM provisioning path, or in
  a file another wave workstream is editing: WEB_PUSH_* (11), ERROR_REPORT_* (24, cloud-init path),
  WORKSPACE_BUILD_QUEUE_DEPTH, VM_AGENT_PROTOCOL/PORT, HETZNER_BASE_IMAGE, DEFAULT_TASK_AGENT_TYPE,
  NODE_HEARTBEAT_STALE_SECONDS, NODE_WORKSPACE_IDLE_TIMEOUT_MS, MAX_NODES_PER_USER,
  MAX_SESSIONS_PER_PROJECT, TRIAL_ANONYMOUS_USER_ID, TRIAL_EXPIRE/CLEANUP/NODE_DELETION (4),
  TRIAL_DEFAULT_WORKSPACE_PROFILE, AI_PROXY_ENABLED, AI_PROXY_REQUEST_BODY_MAX_BYTES,
  PROJECT_DATA_ARCHIVE_COMPACT_ENABLED, PROJECT_DATA_ARCHIVE_SEARCH_* (7), BUDGET_RECEIPT_* (2),
  PROJECT_DATA_STORAGE_TELEMETRY_LIST_LIMIT_* (2), PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES,
  IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP, DO_SUMMARY_SYNC_DEBOUNCE_MS, TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS,
  NODE_LIFECYCLE_MAX_DESTROYING_AGE_MS, MAX_VM_AGENT_ERROR_* (3), OBSERVABILITY_ERROR_* (3),
  CRON_MIN_INTERVAL_MINUTES, CRON_TEMPLATE_MAX_LENGTH, TRIGGER_NAME_MAX_LENGTH. Follow-up candidates.

GitHub Environment overrides (`getOptionalProcessEnvVars` + both Sync Wrangler Config steps):
production sets 46 variables, staging 16 (snapshot in
`scripts/quality/fixtures/github-environment-variables-2026-10-11.json`). 34 of the omitted names
are set in production (mostly the completed P0 storage-relief / tool-payload cleanup plan; 9 of them
to the code default itself) and keep shipping as overrides; staging sets 2, both to the default.
Deleting those Environment variables is an operator action, recommended in the PR, not done here.

Generated Worker plain-text vars (generator run with the real Environment inputs):
production 296 → 150 (guard count 334 → 188 of 340), staging 301 → 123 (guard 339 → 161).

Doc bugs found on the way and fixed: `PROJECT_DATA_GROUPED_FTS_CLEANUP_RECHECK_MS` code default is
24 h (docs said 5 min), `SESSION_IDLE_TIMEOUT_MINUTES` code default is 15 (docs said 60),
`ACTIVITY_RETENTION_DAYS` was documented as retaining activity events but nothing implements it.

## Design

1. Delete from `apps/api/wrangler.toml` `[vars]` every entry whose production behavior with the
   var absent is provably identical (every read site, including forwarding to cloud-init / the VM
   agent). Keep anything DIFFERS / REQUIRED / UNCERTAIN.
2. Record each removed name and its value in `scripts/deploy/worker-var-defaults.ts`
   (`OMITTED_WORKER_VAR_DEFAULTS`). The generator uses it only as the comparison base for the
   override report, so overrides of omitted vars stay visible in the deploy log and job summary.
3. CI proof:
   - apps/api unit test: for every omitted var, the real production resolver/parse path returns the
     same effective value with the var absent and with the recorded value (discriminating).
   - scripts/quality test: for staging and production inputs, every var's resolved value (emitted,
     else recorded default) is identical to shipping every recorded default; every GitHub
     Environment override still ships; the binding count drops; `wrangler.toml` may not re-add an
     omitted var with its default value.
4. Keep the 340 guard unchanged.

## Implementation Checklist

- [x] Aggregate the per-var audit into a classification table (equal / differs / required / uncertain)
- [x] Independently spot-check every EQUAL var with a flag, empty-string value, or multiple read sites (the proof test's discrimination + AST coverage check enforces this; sabotage runs: changed code default, removed read path, new uncovered read site, wrong recorded value — all caught)
- [x] Remove the EQUAL vars from `apps/api/wrangler.toml`; move any load-bearing comment next to the code default
- [x] Add `scripts/deploy/worker-var-defaults.ts` with the recorded values
- [x] Use it as the override-report comparison base in `getApiWorkerVars`
- [x] apps/api behavioral proof test (absent == recorded value through the real resolver)
- [x] scripts/quality staging/production effective-config test + ratchet
- [x] Add `apps/api/wrangler.toml` (and the new module) to the `deploy-scripts` CI path filter
- [x] Update tests that read removed vars from `wrangler.toml`
- [x] Update `wrangler.toml` header comment, rule 07, env-reference skill, configuration docs
- [x] Record the vars `0e8dbc0f7` left out of `[vars]`, so their overrides are reported against the code default (architecture review; 70 recorded, 6 documented exclusions)
- [x] Move the override report into `scripts/deploy/environment-var-overrides.ts`, because `sync-wrangler-config.ts` is past the rule-18 ceiling (architecture review)
- [x] Report new binding count (guard count and Cloudflare count) in the PR

## Acceptance Criteria

- [x] Every removed var is proven equal to the code default by a CI test that calls production code
- [x] For staging and production inputs, resolved values are identical before/after (CI test)
- [x] Every GitHub Environment override still ships and is still reported when it differs from the default
- [x] The 340 guard is unchanged; the generated staging/production count drops substantially
- [x] Staging deploy: Worker settings binding count drops and sampled vars keep the same effective values
- [x] Production deploy: `sam-api-prod` settings read back through the Cloudflare API, count reported
      (2026-10-12 reconciliation: recovery task `01M4NAW8MFHJK953103ACFY4NH` read back 321 → 175
      (150 plain + 25 secret) after Deploy Production 38159699324, with zero mismatches across the
      178 effective-value comparisons. Re-read on 2026-10-12 through the script-settings API: 150
      `plain_text` + 25 `secret_text` on deployment `741061e7` / version `4c1cd7ae`.)
- [x] env-reference skill and docs describe how vars are set (defaults in code; `[vars]` = non-defaults)

## References

- `scripts/deploy/sync-wrangler-config.ts`, `apps/api/wrangler.toml`, `.github/workflows/deploy-reusable.yml`
- `.claude/rules/07-env-and-urls.md`, `apps/api/.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`
- Commit `0e8dbc0f7` (prior reduction), idea `01M47V0101CAM43ZNZN4JHB4AK` (kill switches)
- Follow-up idea `01M4N37HMMV3WB8RP91ZD5GXPF` (78 kept default-equal vars, stale production overrides, real Cloudflare limit)

## Recovery validation (2026-10-11)

Recovery remains on the original branch and PR #2303. The Sol coordinator released source
work after verifying the former coordinator's relinquishment; staging, merge and production
mutation still require separate sequencing grants. Phase1 settings work is excluded.

- Independent local Sol review found no behavior regression: 178 removed entries match
  recorded defaults, two removed entries are unread, and no retained value changed.
- Generator/workflow proof suites: 105 tests passed. Runtime omitted-default suite: 5 passed.
- Current-tree secret scan: 50 exact reviewed findings, zero new. Three initial failures
  were existing synthetic fixture markers shifted by removal of a dead binding line.
  Comments preserve those reviewed locations; scanner, baseline and policy are unchanged.
- Autosave had tracked `.do-state.md`; untrack it while preserving the local file and adding
  local exclusions. Restore substantive PR evidence/preflight instead of commit bullets.
- Read-only Cloudflare settings at 14:11 UTC: staging 301 plain + 26 secret = 327;
  production 296 plain + 25 secret = 321. All 178 newly omitted defaults match deployed
  bindings after accounting for explicit Environment overrides, with zero mismatches.
- Live GitHub Environment inputs still match the committed fixture exactly: staging 16,
  production 46; no added, removed or changed values.
- At this pre-deploy recovery checkpoint, post-deploy counts/samples were pending.
  Subsequent authorized staging results are recorded below; production remains pending.
- Supported snapshot/WIP content retrieval is unavailable through exposed SAM tools.
  Original detailed local per-var audit files are absent from the replacement workspace;
  retained metadata and pushed head alone are not proof of recovery completeness.

## Regenerated complete audit

Historical snapshot/artifact access is unavailable: the coordinator reports production R2
listing denied (403 / code 10000), and SAM's artifact reader requires the original workspace/chat
callback authentication. Old runtimes were not recreated and access controls were not bypassed.

Newly regenerated evidence for **every one of the original 283 variables** is in
[the supporting inventory](2026-10-11-worker-text-binding-inventory.md). It lists checked-in
values, absent/default behavior, read-path citations, retained/omitted decisions, generator
forwarding, workflow mapping and exact staging/production inputs. It also covers minimal
self-host inputs. This is new evidence from preserved source, not retrieved historical output.

Corrected aggregate: **257 equal** (including two unread), **20 differ** (including six
explicit enable-only flags), **six generator-overwritten**. The earlier 258/13/6/6 split was
optimistic for VM_AGENT_PORT: certificate-free cloud-init defaults to 8080 versus checked-in 8443. That binding remains retained. NODE_WORKSPACE_IDLE_TIMEOUT_MS also remains retained
because its absent behavior honors a legacy alias; direct VM database-path context is documented.
No omitted binding needed reinstatement.

CI now pins all 283 original values from the historical source fixture to either an unchanged
retained binding or the existing real-resolver-proven default record. Before/after generator
comparisons use that original baseline (plus defaults from the earlier reduction), rather than
reconstructing solely from the current record. The fixture triggers both API and deploy-script CI.
No fixture or documentation value is consumed by runtime/deployment configuration.

Regenerated counts: staging 301/339 → 123/161; production 296/334 → 150/188; minimal self-host
294/332 → 114/152 (plain/guard). Every effective value except two deliberately unread removals
matches, and explicit overrides remain unchanged. Generator/workflow suites: 106 tests passed.

## Authorized staging verification — 2026-10-11

Coordinator granted one deployment through 16:15 UTC. GitHub rejected raw-SHA dispatch
without creating a run; the coordinator approved the original branch ref after checking its
head. [Deployment 38151723286](https://github.com/raphaeltm/simple-agent-manager/actions/runs/38151723286)
ran exact `f4f4ed4ce753f221d10254b57d726d848f2d6f15` and completed successfully.
All **12 standard read-only smoke tests passed** (1.8 minutes).

Cloudflare settings readback: **301 plain + 26 secret = 327** before, **123 plain + 26
secret = 149** after, a reduction of **178 bindings**. Active Worker version
`0bf6ff53-c7c7-4761-a6e0-ec8ae1ac230c` served 100% of traffic, deployment
`20bd10e9-9495-4225-8613-84db4e224475`. All 178 newly omitted names resolve to their
previous effective values using the independently proven absent defaults: **zero mismatches**.

Safe effective samples, unchanged before/after:

| Variable                         | Effective value            |
| -------------------------------- | -------------------------- |
| HUMAN_INPUT_TIMEOUT_MS           | 7200000                    |
| MAX_PROJECTS_PER_USER            | 100                        |
| D1_SESSION_MODE                  | first-primary              |
| CRON_SWEEPS_ENABLED_KV_KEY       | control-loops:cron-enabled |
| PROJECT_DATA_STORAGE_LIMIT_BYTES | 10000000000                |

Fresh 16 staging Environment inputs match the CI fixture exactly. Generator equality and
explicit default/non-default override proofs passed again (58 configuration tests). Existing
migration safety steps ran with no migration-file delta from prior deployed Wave D.
Prior Wave D run `38146141473`, head `96510f86b86bab64fa0a8952d12923892e5affab`, and
Worker version `327ae83d-845e-4341-8f75-8b92265d35d2` were preserved in private evidence.
No VM/session/test resources were created. Fresh D1 checks found zero nondeleted staging
nodes and zero creating/running workspaces; staging was explicitly released.

Current runtime head CI `38150350041` and late SonarCloud passed. CodeRabbit was requested
once at 15:49 UTC; request workflow `38152855867` succeeded, but the bot returned
[Review rate limited](https://github.com/raphaeltm/simple-agent-manager/pull/2303#issuecomment-6110785478)
and no findings. The bounded window ends at 16:04 UTC; no repeated request or waiver.

Merge and production remain pending explicit coordinator sequencing. Production count
150 plain is a generator result; the latest production read-only baseline is 296 plain + 25
secret = 321. A post-production readback is still required. Historical snapshot content was
not inspected; its supported access limitation remains recorded above. No Phase1 integration.

## Reconciliation 2026-10-12 (weekly queue audit): archived

Shipped and live. The "post-production readback is still required" note above is superseded.

- Landing PR: #2303, merge commit `73feb757d` (2026-10-11 17:12Z). The original task
  `01M4MZTMG7RHYYFZXXNNQSDSAR` failed (`agent_prompt_failed`). Recovery task
  `01M4NAW8MFHJK953103ACFY4NH` finished the PR on the original branch.
- First successful production deploy: Deploy Production run 38159699324 (head `73feb757d`).
- `sam-api-prod` now has 175 text bindings (150 plain + 25 secret), down from 321. The deploy
  guard is still 340.
- The supporting inventory `2026-10-11-worker-text-binding-inventory.md` is archived with this
  file, so the relative link above still resolves.
