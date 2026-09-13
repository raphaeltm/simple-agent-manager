# Archive drain: enable the production global sweep, unwind pre-copy refusals, bounded throughput

**Status:** archived (PR open 2026-09-06; production override removal and post-merge verification recorded in the PR)
**Branch:** `sam/get-sams-production-projectdata-ztxn42`
**SAM task:** `01M1V0NPQB3E5TNB8D0QZTXN42`
**Parent work:** `tasks/archive/2026-09-05-archive-sharding-streaming-hash-abandon-and-size-budget.md` (PR #2024),
`tasks/backlog/2026-09-05-archive-precopy-refusal-should-not-fence-session.md` (folded into this task)

## Problem

The SAM root ProjectData object (`01KHRJGANBBWGDY1NZ0KVF0D4J`) measured 10,211,606,528 bytes at
2026-09-06T09:14Z against the 10 GB configured ceiling. PR #2024 is live and the operator's manual
canary is publishing sessions, but the automated drain is not running and cannot safely run:

1. **The daily global sweep has never run in production.** `project_data_archive_global_sweep_cadence`
   is empty; every `cron.completed` log carries `projectDataArchiveShardingSkipReason: "disabled"`.
2. **A pre-copy refusal fences the session.** `createCandidateJournal` writes the `migrating`
   location fence before `archiveSourcePrepareIntent` runs. When the root object refuses the session
   at prepare (`ProjectDataArchiveInvariantError`, e.g. `active_session_state` for
   `ea87d375-ada4-4bd3-81b3-5c3aa8fc0582`), nothing was written to either object, yet `markFailed`
   leaves the journal `failed` and the location `migrating`. The session is unreadable until an
   operator abandons it, the `failed` journal is reclaimed first by every later sweep, and three
   refusals poison it and open the project circuit breaker, stopping the whole drain.
3. **Throughput is structurally too low.** The sweep is cadence-gated to once per 24 h, and the
   5 s wall-time break between candidates means one tick processes exactly one non-trivial session.
   The SAM backlog is 3,349 eligible sessions / 6.28 M messages; steady-state inflow is 4–233
   terminal sessions per day. One session per day cannot drain the backlog or keep up.

## Research findings (verified 2026-09-06 09:30–10:00Z)

### Problem 1 root cause: a GitHub Environment override pins the sweep off

| Evidence                                                                                                                                                                                                                                     | Source                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `cron.completed` at 2026-09-06T09:30:20.607Z: `projectDataArchiveShardingEnabled: false`, `projectDataArchiveShardingSkipped: true`, `projectDataArchiveShardingSkipReason: "disabled"`                                                      | Workers Observability query, `$metadata.service = sam-api-prod`, needle `projectDataArchiveShardingSkipReason` |
| Deployed `sam-api-prod` Worker var `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED=false` (every other `PROJECT_DATA_ARCHIVE_*` var matches wrangler.toml)                                                                                        | `GET /accounts/{prod}/workers/scripts/sam-api-prod/settings` (plain_text bindings)                             |
| GitHub `production` Environment variable `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED=false`, created 2026-09-04T03:47:47Z, never updated                                                                                                      | `gh api repos/raphaeltm/simple-agent-manager/environments/production/variables`                                |
| PR #2023 (`3cf385865`, merged 2026-09-05T13:39Z) flipped only `apps/api/wrangler.toml` to `"true"`                                                                                                                                           | `git show 3cf385865 --stat`                                                                                    |
| `deploy-reusable.yml` `wrangler_sync_env` passes `${{ vars.PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED }}`; `getOptionalProcessEnvVars` in `scripts/deploy/sync-wrangler-config.ts` spreads any non-empty value over `topLevel.vars`, silently | `.github/workflows/deploy-reusable.yml:517,1064`; `scripts/deploy/sync-wrangler-config.ts:425-433,459`         |
| `runProjectDataArchiveSharding` returns `emptyStats(config, true, 'disabled')` before touching the cadence row when `env.PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED !== 'true'`                                                               | `apps/api/src/scheduled/project-data-archive-sharding.ts:365,2784`                                             |
| Staging ran the cron path once when it was enabled (cadence row `run_count=1`, `last_status=succeeded`, 2026-09-02T10:01Z), so the code path itself works                                                                                    | staging D1 `project_data_archive_global_sweep_cadence`                                                         |

Class of bug: **a checked-in default flipped in a PR while a deploy-time override pinned the old
value, and the PR's evidence was the diff rather than the deployed value.** The override mechanism is
correct and wanted (emergency brake); the gap is that nothing made the override visible at deploy
time or at PR time.

### Problem 2 code facts

- `prepareArchiveSourceIntent` (DO) runs `validateRootSourceOwner` then `assertEligibleTerminalSource`
  BEFORE the first write (the intent-row insert). Every eligibility invariant (`session_missing`,
  `session_not_terminal`, `terminal_grace_not_elapsed`, `active_acp_session`, `active_session_state`,
  `active_task_wait`, `active_idle_cleanup`, `unresolved_attention`, `message_comments_present`,
  `tool_payload_cleanup_incomplete`) therefore refuses with nothing written.
- The same helper runs again at `finalizeSourceDelete`; a refusal there is mid-migration (shard copy
  exists) and must keep today's `failed` + fenced behaviour.
- Over the DO RPC hop only `name` and `message` of a thrown error survive (rule 63), and the Workers
  vitest pool reports any exception escaping a DO method as an unhandled error. A **returned** typed
  refusal crosses the RPC faithfully and is testable at production fidelity.
- `migrateCandidate` calls `inspectSourceIntent` + `alignJournalToLocalSourceProof` before prepare,
  so at `ensureSourcePrepared` a journal still in `leased` has no intent row on the root object; the
  abandon path (`abandonProjectDataArchiveMigration`) already reserves the lease epoch before any
  concurrent mutation.
- Location restore to `root` exists in abandon (`owner_kind='root'`, generation 0, `migration_id`
  NULL, guarded by `migration_id = ?` and `location_state IN ('migrating','frozen')`). Journal
  transition `leased -> frozen` is allowed; `frozen` is excluded from `ACTIVE_RECLAIMABLE_STATES`,
  never poisons, never opens the breaker, and already carries operator error codes
  (`operator_abandoned`, `operator_project_frozen`, `copy_back_restored`).
- Candidate selection (`selectCandidates` / `selectScopedCandidates`) cannot see DO-local eligibility;
  without an exclusion, a refused session would be re-selected largest-first every tick (immortal
  candidate, rule 47). `idx_project_data_archive_migrations_session (project_id, session_id, state)`
  makes a per-row `NOT EXISTS` probe an index seek.
- `session_state.activity = 'error'` is written by `markSessionError` and never cleared for a session
  that ends in error; `'prompting'`/`'recovering'` clear on turn end/stop. Production eligible backlog
  includes 270 `failed` sessions (241 K messages); some fraction will be refused for this reason.
  Narrowing the DO invariant is a separate design decision (rule 57), tracked as a follow-up idea.

### Problem 3 numbers

- Eligible SAM backlog (terminal, ended > 7 d, location root/none): 4 sessions > 20 K (95 K msgs),
  333 sessions 5 K–20 K (2.95 M), 1,143 sessions 1 K–5 K (2.58 M), 1,122 sessions 200–1 K (614 K),
  747 sessions ≤ 200 (43 K). Other projects add ~1.35 M messages (largest: 616 sessions / 664 K).
- Operator canary timings today (journal `published_at` deltas, one session per call, back to back):
  ~30 K-message sessions every 66–84 s; ~9.9 K-message sessions every 42–43 s. Model
  `t(N) ≈ 25 s + 1.65 ms × N` (upper bound; includes the operator loop overhead).
- The root object handled nine ~25–31 K-message migrations back to back between 09:26Z and 09:40Z
  with no reset in `platform_errors`, so a bounded automated cadence is well inside what the object
  already tolerates.
- Daily inflow of newly terminal SAM sessions (last 14 d): 4–233/day, median ~12/day; a daily,
  one-session tick can never keep up even after the backlog drains.
- The sweep currently sits BEFORE `session_sleep` in the cron chain (`handler.ts:166`); a longer
  wall budget there would push lifecycle sweeps back on every tick (rule 47, the same reason the
  relief preflight runs last).

### Read-only checks requested by the task

- `7ed11dc5-21a9-4e15-80f4-2366b0b213b1` (100,000 messages) is **published**: journal
  `3c5e36d6` `published` at 2026-09-06T09:26:31Z, location `archive_shard`
  (`01KHRJGANBBWGDY1NZ0KVF0D4J:archive:g2:s118`, generation 2); its earlier journal `c63fd9f1` is
  `frozen/operator_abandoned`.
- No journal for the SAM project is `failed` or `poisoned`. States at 09:33Z: 30 `published`,
  4 `published` retaining `error_code='Error'` / `too many SQL variables at offset 421` from the
  pre-#2022 attempt (attempt_count 2–3), 4 `frozen/operator_abandoned`, 1 `copying` (operator canary
  in flight). Breaker `closed` (reason: retry after PR #2022 bind-ceiling fix).
- `ea87d375` journal `eeebff46` is `frozen/operator_abandoned`
  ("pre-copy migration failed under the one-shot hash; returning ea87d375 to root (PR #2024)"),
  location `root`. Its summary: `stopped`, 7,833 messages, ended 2026-08-26T11:27Z.

## Implementation checklist

### 1. Problem 1 — make the sweep run through the normal deploy path (+ process fix)

- [ ] (merge-time) Remove the GitHub `production` Environment override `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED`
      so the checked-in `wrangler.toml` value (`"true"`, PR #2023) governs. Do this only at merge time,
      after the staging feature pass, so no earlier deploy enables the sweep without the Problem 2 fix.
- [x] `scripts/deploy/sync-wrangler-config.ts`: when a process-env value overrides a top-level
      `wrangler.toml` var with a DIFFERENT value, print one deploy-log line naming the var and both
      values (values are non-secret `[vars]`). Test in `scripts/quality/sync-wrangler-config.test.ts`.
- [x] New rule `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`: a PR that changes a
      `wrangler.toml` var must list GitHub Environment overrides for staging and production and verify
      the deployed value (CF script settings or the feature's own skip-reason log) after deploy.

### 2. Problem 2 — a pre-copy refusal must not fence the session

- [x] DO `prepareArchiveSourceIntent`: catch `ProjectDataArchiveInvariantError` thrown by
      `assertEligibleTerminalSource` (before any write) and return a typed
      `ArchiveSourcePrepareRefusal = { refused: true, reason, message, databaseSizeBytes }`;
      every other invariant keeps throwing. `finalizeSourceDelete` unchanged.
- [x] Coordinator `ensureSourcePrepared`: on refusal while the journal is `leased`, run
      `refusePreCopyMigration`: one D1 batch, journal `leased -> frozen` with
      `error_code = 'precopy_refused'`, `error_message = '<reason>: <message>'`, lease cleared,
      guarded by `lease_owner`/`lease_epoch`; location `migrating -> root` guarded by
      `migration_id`. On refusal past `leased` (intent exists), throw so `markFailed` keeps the
      fenced retry path. `stats.refused` counts refusals (not `failed`; cadence stays `succeeded`).
- [x] `selectCandidates` / `selectScopedCandidates`: `NOT EXISTS` a `frozen`/`precopy_refused`
      journal for the session newer than `now - precopyRefusalRetryMs`. An explicit `sessionId`
      scope (operator canary) bypasses the marker.
- [x] New env `PROJECT_DATA_ARCHIVE_PRECOPY_REFUSAL_RETRY_MS`
      (`PROJECT_DATA_ARCHIVE_DEFAULT_PRECOPY_REFUSAL_RETRY_MS = 7 d`, clamp 1 ms..365 d): `env.ts`,
      `wrangler.toml`, `sync-wrangler-config.ts` optional list, `deploy-reusable.yml` (both
      `wrangler_sync_env` blocks), `.env.example`, env-reference skill, `configuration.md`.
- [x] `handler.ts` logs `projectDataArchiveShardingRefused`.
- [x] Coordinator unit tests (real SQLite): refused-at-prepare candidate ends the tick `root` +
      `frozen/precopy_refused`, breaker closed, `stats.refused=1`, `failed=0`; discriminating
      controls: mid-copy failure stays `migrating`/`failed`; refusal after an intent exists (journal
      `intent_prepared`) stays fenced `failed`; a plain prepare error stays fenced `failed`.
- [x] Selection tests (real SQLite): refused session excluded inside the window, selected after it,
      selected immediately when the scope names the session; determinism preserved.
- [x] Workers-pool test at RPC fidelity: real DO session with an active `session_state` row
      (`reportActivity(..., 'prompting')`), scoped non-dry canary → readable `root`,
      `frozen/precopy_refused`; then `reportActivity(..., 'idle')` and the explicit-session canary
      migrates it (owner control).
- [x] DO unit test: new `returns a typed pre-copy refusal before any write, and throws once an intent
exists` asserts the typed refusal (`resolves`) with no intent row written, the throwing wrapper's
      unchanged contract, the owner control, and the throw once an intent exists; the pre-existing
      `refuses active sessions ...` test is untouched.
- [x] Verify the unit test goes red against the pre-fix coordinator (record in PR).

### 3. Problem 3 — bounded higher throughput

- [x] `apps/api/wrangler.toml`: `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS = "900000"` (15 min)
      and `PROJECT_DATA_ARCHIVE_WALL_TIME_MS = "30000"` with a comment pointing at the load review.
      Code fallbacks stay daily / 5 s (unset-var behaviour unchanged). Budget 20,000 and ceiling 10
      unchanged; grace 7 d unchanged; wall-time break kept.
- [x] `handler.ts`: run `project_data_archive_sharding` after `trial_expire` (before the relief
      preflight, which stays last) so its wall budget cannot delay `session_sleep`; update
      `handler-kill-switch.test.ts` ordering pins.
- [x] Rule 47 load review in the PR: expected candidate volume, worst-case per-candidate cost,
      tiered timeouts, escape paths, and the policy justification for a sub-daily cadence.
- [x] Docs: `configuration.md`, env-reference skill, `.env.example` describe the shipped cadence.

### 3b. Review follow-ups (Phase 5, 2026-09-06)

- [x] `PROJECT_DATA_ARCHIVE_FAILED_RETRY_DELAY_MS` (default 1 h, `0` disables; session-scoped canary
      bypasses): `failed` journals are reclaimable only once older than the delay, so the 3-attempt
      poison budget spans hours at the 15-minute cadence instead of 45 minutes (performance review).
- [x] Problem-migrations list ranks `frozen`/`precopy_refused` after rows that need a human; the
      frozen-intent DO inspection excludes them (architecture review).
- [x] One `restoreSessionLocationToRootStatement` shared by abandon, copy-back and the refusal unwind;
      the test-only throwing `prepareArchiveSourceIntent` wrapper removed (architecture review).
- [x] `refusePreCopyMigration` fails loudly when the journal froze but the location did not restore
      (security review); lost-lease-fence, cross-tenant, owner-mismatch, comment-thread refusal,
      `cron.completed` `refused` field, and window-liveness tests added (security + test reviews).
- [x] Per-phase migration timing logged (`project_data_archive_candidate_migrated`) so production
      ticks quantify the root-object cost of finalize (performance review).
- [x] Follow-up ideas: `01M1V4F453MEYWTMSJ2S02SW95` (crash-gap escape path), markFailed
      lease-blind overwrite (see idea filed in Phase 5).

### 4. Docs, post-mortem, memory

- [x] `.claude/skills/api-reference/SKILL.md`: `precopy_refused` appears in problem-migrations /
      frozen-intents; abandon note unchanged.
- [x] `CLAUDE.md` Recent Changes entry.
- [x] Post-mortem (rule 02) in the PR: root cause, class of bug, why not caught, process fix.
- [x] Follow-up SAM idea `01M1V3WYT6D88Z41WQWP0ASVC3`: `session_state.activity='error'` on terminal
      sessions blocks archiving (rule 57 stale-activity class); decide whether terminal sessions past
      grace should clear it.

## Acceptance criteria

- [ ] With the override removed and the PR deployed, a production `cron.completed` log shows
      `projectDataArchiveShardingEnabled: true` and the cadence row is claimed
      (`run_count >= 1`).
- [x] A refused-at-prepare candidate ends the same tick readable (`location_state='root'`), its
      journal `frozen`/`precopy_refused`, the breaker `closed`; a mid-copy failure control still
      ends `migrating`/`failed` (test-pinned, verified red on pre-fix code).
- [x] A refused session is not re-selected inside the retry window and does not consume a slot;
      an operator-scoped canary can still target it (unit + Workers pool + live on staging).
- [x] Staging (2026-09-06, run 34028819491): the real cron path claimed the cadence row at
      11:05:39Z (`run_count` 2, `succeeded`) and migrated four sessions largest-first across three
      projects in 34 s; the second cron invocation in the same minute skipped with
      `cadence_not_due`; a superadmin canary on `4305e7e3` (unresolved attention marker) returned
      `refused: 1`, the session stayed readable at `root` with a `frozen`/`precopy_refused` journal,
      and the next project-scoped selection skipped it. (`session_state` on staging could not be
      seeded from outside; the attention-marker invariant exercises the same refusal path.)
- [x] Deploy log names any GitHub Environment override that differs from `wrangler.toml`
      (tested; the staging deploy printed none once the four staging overrides were removed).

## Non-goals

- Removing the wall-time break, the 7-day grace, or the message budget semantics.
- Narrowing the DO eligibility invariant for `activity='error'` (follow-up idea).
- Per-phase journal timestamps (all phases currently record the tick start).

## References

- `apps/api/src/scheduled/project-data-archive-sharding.ts`
- `apps/api/src/durable-objects/project-data/archive-sharding.ts`
- `apps/api/src/scheduled/handler.ts`
- `scripts/deploy/sync-wrangler-config.ts`, `.github/workflows/deploy-reusable.yml`
- `.claude/rules/47-control-loop-io-budget.md`, `.claude/rules/62-tests-must-observe-the-real-trigger.md`,
  `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md`, `.claude/rules/67-shared-predicates-that-trigger-actions.md`

## Staging evidence (2026-09-06)

- Deployed `sam-api-staging` vars (CF script settings): `PROJECT_DATA_ARCHIVE_SHARDING_ENABLED=true`,
  `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED=true`, `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS=900000`,
  `PROJECT_DATA_ARCHIVE_WALL_TIME_MS=30000`, `PROJECT_DATA_ARCHIVE_PRECOPY_REFUSAL_RETRY_MS=604800000`,
  `PROJECT_DATA_ARCHIVE_FAILED_RETRY_DELAY_MS=3600000` (the four staging GitHub Environment
  overrides created 2026-09-03/04 were deleted first; the deploy log printed no differing override).
- Cron: cadence row `last_started_at` 11:05:39.904Z, `last_completed_at` 11:06:14.039Z, `succeeded`,
  `run_count` 2, `next_eligible_at` 11:20:39Z; published `3a1a7624` (1,650), `5f90bfc4` (1,124),
  `ed7d2631` (1,085), `e955988f` (968) — largest-first across three projects — then the 30 s wall
  budget ended the tick. Per-phase timings (`project_data_archive_candidate_migrated`): 1,650
  messages in 7.6 s (prepare 0.56 s, copy 4.9 s, seal 0.42 s, manifest 0.91 s, finalize 0.82 s).
- Refusal: `POST …/01KJVGMWX26SGQ5DX94GMTJRQN/archive-sharding/canary` for `4305e7e3` →
  `stats.refused: 1, migrated: 0, failed: 0`; journal `5537a3a5` `frozen`/`precopy_refused`
  (`unresolved_attention: ProjectData archive refuses sessions with unresolved attention markers`),
  location `root` with `migration_id` null; `GET …/sessions/4305e7e3/messages` 200 afterwards;
  project-scoped dry-run listed five other sessions and not `4305e7e3`.
- Playwright (Chromium 1280×800, token-login against `api.sammy.party`): dashboard, project page and
  settings rendered; `console errors []`; `/health` 200.
