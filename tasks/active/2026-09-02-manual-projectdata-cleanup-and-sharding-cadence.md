# Manual ProjectData cleanup control and archive-sharding cadence gate

## Problem statement

Production ProjectData for project `01KHRJGANBBWGDY1NZ0KVF0D4J` measured
`9,789,542,400 / 10,000,000,000` bytes at `2026-09-02T22:42:21Z`, leaving roughly
210 MB of headroom and about 1.53 days to the storage wall. The automatic
tool-payload archival cleanup path exists, but production currently has
`PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED=false`. Operators need a scoped,
audited manual control that can run one safe cleanup slice for one ProjectData
object without turning on automatic cleanup globally.

Archive sharding is also deployed but production-disabled. The shared scheduled
Worker wakes every five minutes and calls `runProjectDataArchiveSharding()` on
every sweep; that function has a global enablement gate but no persisted daily
cadence gate once enabled. Before staging proof, the global archive-sharding
sweep must be unable to select or migrate candidates more than once per
configured interval, while scoped manual canaries and explicit recovery controls
remain independently callable.

This task must stop at a draft PR. It must not deploy to staging, mutate staging
or production, change runtime flags, run production cleanup, enable archive
routing/global sweep, migrate sessions, run copy-back, merge, or trigger
CodeRabbit for this rollout wave.

## Research findings

- SAM MCP task `01M1J6232BQF5C6FEE844B67XF` sets the output branch to
  `sam/execute-task-using-skill-4b67xf`.
- Current branch head matches `origin/main` at `786aa31686f6b457e42ff90b48324e60e6c3e336`.
- Existing archival cleanup entrypoint is
  `apps/api/src/durable-objects/project-data/tool-payload-cleanup.ts`.
  Manual cleanup must call `runProjectDataToolPayloadCleanup()` rather than
  duplicate candidate selection or archive/write/delete logic.
- Existing archive-then-strip semantics are concentrated in
  `tool-payload-archive.ts`: R2 write and SQL archive bookkeeping must succeed
  before `chat_messages.tool_metadata` is rewritten. Raw
  `chat_messages.content` is not touched by this path and must stay that way.
- Existing candidate discovery in
  `tool-payload-cleanup-candidates.ts` is now seekable on
  `(session_id, created_at, sequence, id)` and bounded by row/metadata byte
  limits. Manual cleanup must preserve those bounds and add only outer
  authorization/idempotency/cooldown handling.
- Existing cleanup state in `tool-payload-cleanup-state.ts` uses `do_meta` for a
  cursor and recheck timestamp. Manual cleanup can reuse the same recheck
  cooldown to avoid creating a second loop or a hot-loop bypass.
- `storage-safety.ts` owns ProjectData storage defaults and env parsing.
  Manual cleanup needs env-backed hard maxima for rows, bytes, and wall time,
  plus a default daily cooldown/recheck.
- Existing admin storage routes live under
  `/api/admin/project-data/storage` in
  `apps/api/src/routes/admin/project-data-storage.ts`; the parent router already
  applies auth, approval, and superadmin middleware.
- Request validation for this area uses Valibot schemas in
  `apps/api/src/schemas/admin.ts`.
- Existing bounded relief measurement is
  `POST /api/admin/project-data/storage/:projectId/relief-measure`. The safe
  operator sequence should document measuring with that path before a manual
  cleanup slice instead of adding another unbounded scanner.
- Archive-sharding coordinator state and rollout controls live in
  `apps/api/src/scheduled/project-data-archive-sharding.ts` and
  `apps/api/src/services/project-data-archive-rollout-controls.ts`.
  `runScopedProjectDataArchiveCanary()` already bypasses the global cron gate
  for scoped dry-runs/non-dry canaries, with non-dry canaries requiring exact
  archive routing.
- Global `runProjectDataArchiveSharding()` currently checks
  `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED`, exact routing, and R2 binding,
  then performs crash-gap recovery and candidate selection immediately. It needs
  persisted cadence state before those global recovery/selection mutations.
- D1 archive-sharding schema currently ends at
  `0135_project_data_archive_sharding_bridge.sql`. A cadence table is additive
  and must use the next free migration number at implementation time.
- Relevant retained incident lessons:
  - `.claude/rules/47-control-loop-io-budget.md`: selected sweep candidates need
    row/wall budgets plus an escape path, and failed candidates must not repeat
    every tick.
  - `tasks/archive/2026-07-02-institutionalize-projectdata-wall-time-prevention.md`:
    ProjectData control loops can starve live work when they inherit large
    per-candidate costs.
  - `tasks/active/2026-08-27-projectdata-retention-convergence.md`:
    tool payload cleanup must archive to R2 before removing inline payloads.
  - `tasks/active/2026-08-31-projectdata-pre-wall-storage-relief.md`:
    reclaim evidence must use `sql.databaseSize`, not PRAGMA estimates.

Every finding above is represented in the checklist below.

## Implementation checklist

- [x] Move this task file to `tasks/active/` on the implementation branch.
- [ ] Add manual tool-payload cleanup config defaults and Env fields:
  env-backed maximum batch rows, maximum batch bytes, maximum wall time, and
  manual cooldown/recheck interval with 24h defaults.
- [ ] Add a ProjectData DO manual cleanup RPC that requires a reason and
  idempotency key, persists an idempotency/cooldown marker before cleanup work,
  reuses `runProjectDataToolPayloadCleanup()`, bypasses automatic cleanup
  enablement only for this explicit call, and returns idempotent retry/cooldown
  state without starting a second cleanup pass.
- [ ] Expose
  `POST /api/admin/project-data/storage/:projectId/tool-payload-cleanup` as a
  superadmin-only route using Valibot request validation and bounded budget
  checks against the configured hard maxima.
- [ ] Ensure manual cleanup telemetry distinguishes skipped cooldown,
  no-op/not-needed, candidates-exhausted, row budget, byte budget, wall time,
  error, and `databaseSize` reclaim evidence; use
  `manual_tool_payload_archive_cleanup` as the audit purge reason when rows are
  stripped.
- [ ] Add an additive D1 migration and Drizzle schema for persisted
  archive-sharding global sweep cadence state.
- [ ] Add `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS` config with 24h
  default and wire it through Env types, wrangler defaults, `.env.example`,
  deployment config sync, GitHub workflow env passthrough, public configuration
  docs, and env reference skills.
- [ ] Gate scheduled `runProjectDataArchiveSharding()` with D1 cadence state so
  global crash-gap recovery/candidate selection/migration can start at most once
  per interval. The cadence claim must advance before work starts so crashes or
  partial runs do not hot-loop on five-minute Worker wakeups.
- [ ] Keep scoped manual archive-sharding canaries and copy-back/freeze/recovery
  routes independent of the global cadence gate.
- [ ] Add unit tests for manual cleanup route authorization, request validation,
  project scoping, service delegation, idempotent retry, cooldown skip, strict
  budget maximums, telemetry audit reason, and archive failure preserving source
  metadata.
- [ ] Add Workers-runtime tests for manual cleanup idempotency/cooldown,
  R2/missing verification fail-closed behavior, raw transcript preservation,
  `databaseSize` reclaim evidence, and old automatic cleanup disabled while
  manual cleanup still runs.
- [ ] Add unit and Workers-runtime archive-sharding tests proving five-minute
  scheduled invocations are daily-gated, failed/partial scheduled starts advance
  cadence state and do not hot-loop, and scoped manual canaries bypass the global
  cadence gate.
- [ ] Update public API/reference docs and task notes with the safe operator
  sequence: inspect telemetry, run bounded relief measurement, run one manual
  cleanup slice with reason/idempotency key, inspect returned termination and
  cooldown state, measure storage again, then proceed to scoped archive-sharding
  dry-run/canary only under the separate rollout controls.
- [ ] Run focused and relevant broad validation without staging or production
  mutation.
- [ ] Run requested specialist reviews:
  cloudflare-specialist, security-auditor, env-validator, doc-sync-validator,
  constitution-validator, test-engineer, and task-completion-validator.
- [ ] Push the branch, open a draft PR, record CI/review evidence, and stop
  without CodeRabbit, staging, production mutation, merge, or deploy.

## Acceptance criteria

- [ ] A superadmin can invoke exactly one project-scoped manual tool-payload
  archival cleanup slice while `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED=false`.
- [ ] Non-superadmins are rejected before ProjectData cleanup is invoked.
- [ ] Manual cleanup requires a non-empty audit reason and idempotency key.
- [ ] Retrying the same idempotency key returns the prior result/cooldown without
  re-running cleanup; a different key inside the persisted cooldown is skipped.
- [ ] Requested manual row, byte, and wall-time budgets default from configured
  cleanup values and are rejected above env-backed hard maxima.
- [ ] R2 archive failure, missing archive binding, missing verification, or SQL
  bookkeeping failure leaves `tool_metadata.content` and raw
  `chat_messages.content` intact.
- [ ] Manual cleanup response includes termination reason, before/after
  `databaseSize`, reclaimed bytes, rows scanned/updated/failed, cursor/recheck,
  and cooldown state.
- [ ] Existing bounded relief measurement remains the measurement/dry-run path;
  no new unbounded scanner is added.
- [ ] Global archive-sharding scheduled work remains disabled by default; when
  enabled with exact routing, persisted cadence allows candidate selection and
  migration no more than once per configured interval despite five-minute Worker
  wakes.
- [ ] Failed or partial scheduled archive-sharding starts persist a next
  eligible time before doing work so they do not hot-loop. Manual scoped canary
  and explicit recovery controls remain callable regardless of that global
  cadence state.
- [ ] D1 and DO schema changes are additive and support clean installs and
  upgrades.
- [ ] Env types, wrangler/default/example config, deployment sync, public docs,
  API reference, and env reference skills are synchronized.
- [ ] Local validation and required specialist reviews have no unresolved
  critical/high findings. The PR is draft and unmerged.

## References

- `tasks/active/2026-08-31-projectdata-terminal-archive-sharding.md`
- `tasks/active/2026-09-01-archive-sharding-rollout-controls.md`
- `tasks/active/2026-08-27-projectdata-retention-convergence.md`
- `tasks/active/2026-08-31-projectdata-pre-wall-storage-relief.md`
- `tasks/active/2026-08-26-projectdata-tool-payload-r2-archival.md`
- `tasks/archive/2026-07-02-institutionalize-projectdata-wall-time-prevention.md`
- `apps/api/src/durable-objects/project-data/tool-payload-cleanup.ts`
- `apps/api/src/durable-objects/project-data/tool-payload-cleanup-candidates.ts`
- `apps/api/src/durable-objects/project-data/storage-alarm.ts`
- `apps/api/src/scheduled/project-data-archive-sharding.ts`
- `apps/api/src/routes/admin/project-data-storage.ts`
- `.claude/rules/09-task-tracking.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/60-request-io-and-bundle-budgets.md`
- `.claude/rules/67-shared-predicates-that-trigger-actions.md`
