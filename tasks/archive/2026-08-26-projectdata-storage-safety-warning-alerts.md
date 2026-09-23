# ProjectData storage safety warning alerts and cleanup reach

## Problem statement

The 2026-08-25 production stability audit found the largest SAM `ProjectData`
Durable Object at 8,435,236,864 bytes of its configured 10,000,000,000 byte
limit: 84.35%, status `warning`, with roughly 9–18 days of directional
headroom. The automated tool-payload cleanup from PR #1901 ran but reclaimed
only about 111 KB and then reported `exhaustedCandidates=true` while still
roughly 935 MB above the configured 75% cleanup target.

The current warning state is not operator-visible. `storage-safety.ts` computes
`warning` at 80%, but the alert path returns early unless status is `critical`
or `degraded`. The D1 telemetry table stores only the latest row per project, so
growth and time-to-limit cannot be reconstructed after the fact.

This task must ship an automated, tested, bounded mechanism only. It must not
perform any one-off production purge.

## Research findings

- `apps/api/src/durable-objects/project-data/storage-safety.ts` currently
  classifies `ok | notice | warning | critical | degraded`, but
  `maybePersistStorageAlert()` returns early for `warning`; the operator-visible
  platform-error path only receives `critical` and `degraded`.
- Existing storage alert delivery uses `persistError()` into
  `OBSERVABILITY_DATABASE.platform_errors`, which is an existing operator
  channel and avoids introducing a new alerting mechanism.
- `apps/api/src/db/migrations/0119_project_data_storage_telemetry.sql` creates
  one latest row per project keyed by `project_id`. Existing admin readers and
  services depend on this latest-row upsert shape, so it must be preserved.
- The D1 schema in `apps/api/src/db/schema.ts` models the latest telemetry row
  and must be extended alongside any additive migration.
- PR #1901 split bounded legacy tool-payload cleanup into
  `tool-payload-cleanup.ts` and `tool-payload-cleanup-candidates.ts`. It uses
  `sql.databaseSize`, raw/keyset access, row and byte budgets, a persisted
  recheck cursor, age floors, and terminal-session predicates. New cleanup
  should reuse those safety properties.
- Existing automated cleanup only strips `chat_messages.tool_metadata.content`
  for old terminal `stopped`/`failed` sessions. It intentionally preserves
  active/sleeping sessions and message text, but production showed that this
  category was too small to reach the target.
- Existing explicit emergency purge deletes oldest `activity_events` and
  `acp_session_events` rows in bounded batches. Automated cleanup can safely
  extend reach to old low-value event history only when rows are linked to old
  terminal sessions; it must not delete active/sleeping session content or
  resumable chat transcripts.
- The Durable Object schema is maintained by
  `apps/api/src/durable-objects/migrations.ts`. DO migration safety is stricter
  than D1: append only, no table recreation, no destructive migrations. This
  task should avoid a DO schema migration unless strictly required.
- D1 migration safety rule 31 applies: use additive D1 migrations only, run
  migration safety checks, and do not drop/recreate FK parents.
- Rule 47 applies because this changes an alarm/control loop: cleanup work must
  be bounded, cheap local SQLite work only, with candidate escape paths and
  two-tick/zombie-prevention coverage.
- Rule 59 applies: extend existing storage-safety, telemetry, admin, and
  observability patterns rather than creating a parallel alerting or cleanup
  mechanism.
- The existing Worker-runtime test file
  `apps/api/tests/workers/project-data-storage-safety.test.ts` already exercises
  real Cloudflare Durable Object SQLite storage and is the right place for the
  audit-required category/target-unreachable regression.
- Existing env/documentation references for ProjectData storage live in
  `apps/api/src/env.ts`, `apps/api/.env.example`,
  `apps/www/src/content/docs/docs/reference/configuration.md`, and
  `.claude/skills/env-reference/SKILL.md`.
- Because this is a bug fix, rule 02 requires a process fix in the same PR. The
  relevant class is silent warning/cleanup-exhausted health states that are
  logged or computed but not routed to an operator-visible alert.

## Implementation checklist

- [x] Add an additive D1 migration for append-only ProjectData storage history
  and latest-row fields needed for growth rate, estimated days to limit,
  cleanup health, reclaimable bytes, and category breakdown.
- [x] Extend Drizzle schema/types for the latest telemetry row and new history
  table without changing the existing latest-row primary-key contract.
- [x] Compute growth bytes/day and estimated days to limit from prior telemetry
  history or the existing latest row before writing the next measurement.
- [x] Append a history row on every persisted measurement or cleanup health
  transition while preserving the existing latest-row upsert.
- [x] Extend warning-threshold alerting so `warning`, `critical`, and
  `degraded` states persist operator-visible platform-error rows with
  database bytes, limit bytes, usage ratio, bytes/day growth, and estimated
  time-to-limit.
- [x] Treat cleanup exhaustion while still above the target as an
  error-severity operator alert and persist an explicit `target_unreachable`
  cleanup health state.
- [x] Add ProjectData category measurement for messages, activity/event logs,
  active/sleeping sessions, normalized tool payloads, terminal legacy payloads,
  eligible terminal event logs, and unattributed SQL/index overhead.
- [x] Add bounded automated event-log cleanup for old terminal-session
  `activity_events` and `acp_session_events`, with env-configurable batch,
  age, and recheck limits, and with no active/sleeping or transcript deletion.
- [x] Update storage alarm scheduling to consider any event-log cleanup recheck
  without starving other ProjectData alarm responsibilities.
- [x] Update admin storage telemetry output to expose growth, forecast, cleanup
  health, and category breakdown while keeping existing fields stable.
- [x] Add or update env examples and public/internal configuration references
  for the new cleanup, history/forecast, and admin telemetry list settings.
- [x] Add the audit-required Worker-runtime regression: seed bytes across
  messages, activity/event logs, active/sleeping sessions, normalized tool
  payloads, and terminal legacy payloads; exhaust reclaimable candidates above
  target; assert `target_unreachable` health and an operator-visible error
  alert.
- [x] Add focused tests for warning-level operator alerts with growth/time-to-limit
  fields, append-only history rows, bounded terminal event-log cleanup, and
  active/sleeping preservation.
- [x] Add the process fix to the relevant rule/checklist so future computed
  warning or cleanup-exhausted states must be routed to an operator-visible
  channel, not just logged.
- [x] Run local validation and specialist reviews required by `/do`.
- [ ] Create the fresh PR CI run from the staging-evidence commit, wait for CI,
  merge when green, and monitor production deploy to completion.

## Implementation notes

- Added D1 migration `0121_project_data_storage_growth_history.sql` with
  additive latest-row fields and append-only
  `project_data_storage_telemetry_history`.
- Split ProjectData storage safety into focused modules for telemetry/history,
  category measurement, alarm orchestration, automated event-log cleanup, and
  explicit emergency purge.
- Warning/critical/degraded storage states now persist platform-error alerts
  through the existing observability error path. Cleanup target exhaustion above
  the configured target persists an error-level `cleanup_target_unreachable`
  alert.
- Alert throttling metadata is updated only after the operator-visible alert and
  latest-row alert fields are persisted, so transient alert-write failures do
  not suppress the next retry.
- Category telemetry measures message content/tool metadata, active/sleeping
  session payload, terminal legacy tool payloads, normalized tool metadata,
  activity events, ACP session events, task status events, and unattributed DB
  overhead.
- Automated cleanup reach now includes old terminal-session `activity_events`
  and `acp_session_events` only, with bounded rows, age floor, recheck state,
  and active/sleeping content excluded.
- ProjectData storage admin endpoints were extracted to an admin sub-router and
  expose the new latest-row fields plus bounded append-only history reads.
- Admin storage telemetry/history list limits are configurable through
  `PROJECT_DATA_STORAGE_TELEMETRY_LIST_LIMIT_DEFAULT` and
  `PROJECT_DATA_STORAGE_TELEMETRY_LIST_LIMIT_MAX`.

## Specialist review evidence

- Cloudflare/DO review — PASS: D1 migration is additive, DO cleanup uses bounded
  local SQLite work with persisted recheck state, and no production data purge
  was performed.
- Constitution review — PASS: storage thresholds, cleanup budgets, growth
  lookback, recheck delays, and admin list bounds are env-configurable with safe
  defaults.
- Env/config review — PASS: typed env, `wrangler.toml`, `.env.example`, public
  configuration docs, and internal env reference are synchronized.
- Security review — PASS: admin history/latest reads stay behind the existing
  superadmin middleware, D1 queries are parameterized, alert context carries
  numeric/category metadata rather than payload content, and cleanup excludes
  active/sleeping or resumable session content.
- Test-engineer review — PASS: Worker-runtime tests cover warning alerts,
  growth/time-to-limit, append-only history, bounded event cleanup, active and
  sleeping preservation, and the audit-required target-unreachable alert.
- Doc-sync review — PASS: operator/admin/API references and environment
  documentation match the implemented behavior.
- Task-completion review — PASS: research findings map to checked-off
  implementation items, acceptance criteria have automated or documented
  validation, and the vertical ProjectData Worker test covers the cross-boundary
  alert/history/cleanup behavior.

## Validation evidence

- `pnpm --filter @simple-agent-manager/api lint` — passed
- `pnpm --filter @simple-agent-manager/api typecheck` — passed
- `pnpm vitest run --config vitest.workers.config.ts tests/workers/project-data-storage-safety.test.ts --reporter=verbose` — passed, 14 tests
- `pnpm --filter @simple-agent-manager/api test:workers -- --reporter=dot` —
  passed, 55 files, 724 tests
- `pnpm vitest run tests/unit/routes/admin-security.test.ts --reporter=verbose` — passed, 8 tests
- `pnpm quality:migration-safety` — passed, 152 FK relationships scanned, 0 new violations
- `pnpm quality:file-sizes` — passed
- `pnpm quality:wrangler-bindings` — passed
- `pnpm quality:do-migration-safety` — passed
- `pnpm quality:do-wall-time` — not locally runnable without the Cloudflare
  script-name env target; the CI workflow derives `DO_WALL_TIME_SCRIPT_NAMES`
  from `RESOURCE_PREFIX` and `TARGET_STACK`.
- `pnpm lint` — passed with existing unrelated ACP/web warnings only
- `pnpm typecheck` — passed with existing Astro template baseline report
- `pnpm build` — passed
- `pnpm test` — passed, 21 tasks; API package 605 files / 8250 tests
- Staging deploy workflow 32924143424 for commit
  `228c052b54ee2ac435d1b969251df0617377f401` — passed; D1 migrations with
  safety gates passed; API health check returned `status: healthy` at
  `https://api.sammy.party/health`; Playwright smoke tests against
  `https://app.sammy.party`/`https://api.sammy.party` passed, 12 tests; direct
  unauthenticated checks for `/api/admin/project-data/storage` and
  `/api/admin/project-data/storage/history` both returned 401, confirming the
  staging admin routes are mounted behind the existing admin auth path.
- After merging current `origin/main`, the branch intentionally keeps
  `0121_project_data_storage_growth_history.sql` under its staging-applied
  prefix and adds it to the exact duplicate-prefix allowlist with
  `0121_diagnostic_dedup_and_budget_retry.sql`; renumbering would replay the
  already-applied staging `ALTER TABLE` statements and abort future staging
  migrations.
- Post-merge migration/order validation — passed:
  `pnpm quality:migration-ordering`, `pnpm quality:scripts:test` (39 files, 529
  tests), `pnpm quality:migration-safety` (153 FK relationships, 0 violations),
  `pnpm quality:do-migration-safety`, `pnpm quality:file-sizes`,
  `pnpm quality:wrangler-bindings`, `pnpm quality:stale-artifacts`, and
  `pnpm quality:source-contract-tests`.
- Touched non-test source files are at or below 500 lines, except documented
  existing exceptions (`apps/api/src/env.ts`, `apps/api/src/db/schema.ts`).

## Acceptance criteria

- At 80% ProjectData storage usage, operators receive a persisted
  operator-visible alert through an existing channel, not just a log line.
- Storage alerts include bytes/day growth and estimated time to limit when a
  prior measurement exists; missing-growth cases are explicit rather than
  fabricated.
- `cleanup exhausted while still above target` produces an error-severity
  operator alert even below 90%.
- D1 retains append-only per-project storage history while the existing
  latest-row telemetry upsert remains compatible with existing readers.
- Storage telemetry records category byte estimates so operators can see whether
  bytes are concentrated in messages, event logs, active/sleeping sessions,
  normalized tool payloads, terminal legacy payloads, or unattributed overhead.
- Automated cleanup can reclaim old terminal-session activity/ACP event history
  in bounded batches with env-configurable limits and persisted recheck state.
- Cleanup never deletes active or sleeping session rows, message text, user or
  assistant transcript content, mailbox prompts, knowledge, policies, or other
  high-value resumable state.
- If configured target bytes cannot be reached with eligible candidates, storage
  health explicitly reports `target_unreachable`.
- Tests prove warning alerts, history append, category measurement, terminal
  event cleanup, active/sleeping preservation, and target-unreachable alerting.
- D1/DO migration safety, env consistency, constitution/no-hardcoded-values,
  Cloudflare/DO, test-quality, doc-sync, and task-completion reviews pass.

## Post-mortem / process fix requirement

What broke: a ProjectData object remained in warning storage pressure for days,
and automated cleanup exhausted its eligible candidates above target, without an
operator-visible alert.

Root cause: the alert path explicitly filtered out `warning`, and cleanup
exhaustion was returned/logged as result data but not escalated as a health
state or platform alert. The latest-only telemetry table also erased trend data.

Why it was not caught: tests proved bounded cleanup mechanics but did not assert
that computed warning or target-unreachable health states reached an operator
channel.

Process fix: update the control-loop/quality rules so a computed warning-or-worse
safety state and a cleanup target that cannot be reached must be surfaced through
an existing operator-visible channel, with a test that observes that channel.

## References

- `.library/reliability/audits/production-stability-audit-2026-08-25.md/production-stability-audit-2026-08-25.md`
- `apps/api/src/durable-objects/project-data/storage-safety.ts`
- `apps/api/src/durable-objects/project-data/tool-payload-cleanup.ts`
- `apps/api/src/durable-objects/project-data/tool-payload-cleanup-candidates.ts`
- `apps/api/tests/workers/project-data-storage-safety.test.ts`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/59-understand-before-adding.md`
