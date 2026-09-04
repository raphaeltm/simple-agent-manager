# ProjectData production capacity emergency

## Problem statement

The production `ProjectData` Durable Object for project
`01KHRJGANBBWGDY1NZ0KVF0D4J` is at imminent `SQLITE_FULL` risk. The latest
available measurement at task start was `9,884,188,672 / 10,000,000,000`
bytes (`98.84188672%`) at `2026-09-03T21:13:42Z`. Subsequent direct measurements
reached `9,908,338,688` bytes at `23:13:44Z`, `9,926,107,136` bytes at
`00:13:45Z`, and `9,950,601,216` bytes (`99.50601216%`) at
`2026-09-04T01:13:48.572Z`. The configured emergency target is 90%, so at least
`950,601,216` bytes of measured database relief is now required before allowing
for ongoing writes and measurement lag.

This task owns the emergency through implementation, review, staging, merge,
production deployment, an exact human-approved production mutation, and
post-mutation storage/cost/read evaluation. It replaces SAM task
`01M1MJK2KV817XF71M0W2C0QHP`, which failed before startup because its full
devcontainer image could not be pulled (`startedAt=null`, no output PR or
implementation). The successor is SAM task `01M1MJYM0R1BYZ5MDMDVVTCHVS` on
branch `sam/replace-failed-startup-task-vtchvs` in a lightweight isolated VM
workspace.

No destructive production operation is authorized until Raphaël approves an
exact mutation plan. The plan must name project/session/row targets, hard
row/byte/wall-time limits, R2 keys/manifests and verification, failure and
rollback behavior, configuration switches, expected reclaimed bytes,
observation window, and stop conditions. Message text must never be deleted.
Every archive must be verified before source stripping or deletion, and all
uncertain states must fail closed.

## Production baseline

- Latest D1 telemetry re-read points to the `2026-09-04T01:13:48.572Z` direct
  `sql.databaseSize` measurement: `9,950,601,216` bytes, ratio
  `0.9950601216`, growth `161,113,667.77` bytes/day, estimated `0.306608`
  days (about 7.36 hours) remaining, status `degraded`, cleanup health
  `running`. This is 24,494,080 bytes above the prior hourly sample and leaves
  only 49,398,784 bytes before the configured limit.
- Last purge was `auto_terminal_event_log_cleanup`; it removed 7 rows and did
  not converge toward the emergency target.
- Production has zero archive-migration, archive-location, and project archive
  circuit-breaker rows for the hot project.
- Production Worker flags have exact archive routing and the global archive
  sweep disabled. Automatic tool-payload cleanup is enabled, but automatic and
  manual budgets are only 500 rows / 2 MiB / 20 seconds on a daily cadence.
- The D1 candidate plane contains 3,357 eligible terminal root sessions and
  6,555,879 indexed messages; the largest eligible session has 100,000 messages.
  Candidate discovery does not expose authoritative per-table source bytes.
- For the hot object, the 25-hour Cloudflare window from
  `2026-09-02T21:00Z` through `2026-09-03T21:00Z` recorded 467,894,694 rows
  read (18,715,788/hour average; 45,358,977/hour maximum), 422,976 rows
  written, 718,481,181 microseconds of CPU, one fatal internal error, and no
  periodic exceeded-CPU or exceeded-memory errors. Invocation groups recorded
  78,065 requests and 382 error-status requests.
- Production observability since `2026-09-02T21:00Z` shows no
  `Exceeded the maximum database size` error yet, but does show seven
  Durable Object overload errors and two CPU-reset errors between 15:25 and
  15:42 UTC plus a storage-operation timeout reset on the prior day.

## Research findings

- PR #1978 added pre-wall relief measurement, bounded grouped-FTS cleanup, and
  chunked legacy payload archival, but kept expensive cleanup disabled by
  default and relies on `sql.databaseSize` for reclaim evidence.
- PR #1984 introduced terminal-session archive sharding with source intent,
  target chunk verification, an aggregate seal, immutable R2 recovery chunks,
  a recovery manifest, source-finalize proofs, and exact-routing publication.
- PR #2000 added project circuit breakers, rollout inspection/recovery controls,
  scoped canaries, and fail-closed exact routing.
- PR #2002 fixed the terminal event-log alarm cadence, but the current seven-row
  cleanup is far below observed growth.
- PR #2004 provided the tool-cleanup emergency brake after an expensive scan;
  PR #2005 made candidate selection seekable and restored bounded daily
  cleanup; PR #2008 added a scoped, audited manual cleanup slice and a persisted
  daily gate for global archive sweep work.
- Existing tool-payload cleanup is project-scoped, row/byte/wall bounded,
  seekable, idempotent, and writes R2 before replacing
  `chat_messages.tool_metadata.content`. It never modifies
  `chat_messages.content`. However, a new R2 object is not read back or hashed
  before the SQL transaction strips the source payload. The current 2 MiB/day
  cap also cannot deliver the required emergency relief.
- Existing terminal sharding copies raw `chat_messages` including message text
  and inline metadata into both a target archive shard and immutable R2
  recovery chunks, verifies target chunk hashes, seals an aggregate, writes a
  recovery manifest, and only then deletes session-owned rows from the root.
  Exact reads fail closed during transition. However, newly written R2 chunks
  and manifests are not read back before source deletion.
- The archive coordinator's configured wall-time budget is checked only between
  whole session migrations. `computeTerminalVersion()` materializes all
  session-owned rows and `copySourceChunks()` processes every table/chunk for a
  session in one coordinator pass. A 100,000-message candidate therefore has
  no enforceable per-request wall-time ceiling. Retrying a paused copy would
  currently restart from the first chunk, so merely adding a deadline check
  would not guarantee convergence.
- Existing dry-run candidate selection is D1-only and cannot provide the exact
  authoritative source row/byte inventory needed for the production approval
  gate. A bounded read-only preflight, or an equivalently conservative enforced
  candidate bound with authoritative evidence, is required before a mutation
  can be proposed.
- Prior category evidence suggested tool metadata alone may be smaller than the
  roughly 884 MiB minimum relief requirement. The safe implementation cannot
  assume tool-payload cleanup alone is sufficient; it must measure eligible
  stock and retain terminal sharding as an escalation path.
- All findings above have an implementation or validation item below. No
  production mutation has occurred during research.

## Implementation checklist

- [x] Inspect the failed predecessor and active duplicates; record this task as
      the explicit successor.
- [x] Refresh direct storage, growth, cleanup, candidate, archive-journal,
      circuit-breaker, error, CPU, and rows-read evidence from production.
- [x] Inspect PRs #1978, #1984, #2000, #2002, #2004, #2005, and #2008 plus the
      active ProjectData storage, retention, cleanup, and sharding task records.
- [ ] Choose and document the minimum safe composition after measuring
      authoritative eligible tool-payload and terminal-session relief stock.
- [x] Add bounded, resumable, read-only preflight evidence that can produce
      exact project/session/table/row/byte targets without an unbounded object scan.
- [x] Add an explicit per-cron slice cap and aggregate run wall-time ceiling so an
      emergency preflight can accelerate without changing the separately leased,
      one-slice default or bypassing the overall row/byte/batch bounds.
- [x] Require explicit post-write R2 read-back and SHA-256/byte verification
      before any selected path strips tool metadata or deletes source session rows.
- [ ] If terminal sharding is required, make each pass resumable and enforce
      overall row, byte, R2-operation, and wall-time budgets inside a session; the
      next pass must resume after verified committed progress rather than restart.
- [x] Keep all limits, timeouts, target thresholds, and operator scoping
      environment-configurable, disabled or narrowly scoped by default, and covered
      by a project-level kill switch/circuit breaker.
- [x] Preserve `chat_messages.content` byte-for-byte and prove archived message
      and tool-payload reads work after source cleanup.
- [x] Add discriminating unit and Workers-runtime tests for success, R2
      corruption/missing-readback, timeout/pause/resume, idempotency, candidate
      exhaustion, source-change races, and target/circuit-breaker stop conditions.
- [x] Update Env surfaces, deployment configuration, API/operator docs, and
      task records for every new control or contract.
- [x] Run focused tests, API tests, typecheck, lint, formatting, migration safety,
      config sync, and the relevant full suites.
- [ ] Complete all required specialist reviews and address every critical/high
      finding before PR creation/merge.
- [ ] Coordinate a successful staging deployment, exercise the real preflight
      and archival path end to end, prove fail-closed behavior, and return staging
      to zero VMs at rest.
- [ ] Open the PR, converge CI and CodeRabbit, merge, deploy production, and
      verify the exact deployed version before asking for mutation approval.
- [ ] Present the exact production mutation plan and obtain Raphaël's explicit
      approval before any destructive production operation.
- [ ] Execute only the approved bounded plan, verify every archive before source
      deletion, stop at or below 90%, and abort on any uncertainty or stop trigger.
- [ ] Observe storage/growth, archive integrity, errors/overload/CPU, and rows
      read for the approved window; report exact before/after evidence and remaining
      risk rather than stopping at code deployment.

## Acceptance criteria

- [ ] Production `sql.databaseSize` for `01KHRJGANBBWGDY1NZ0KVF0D4J` is at or
      below 9,000,000,000 bytes after the approved operation.
- [ ] No message text is deleted; sampled and boundary session reads remain
      byte-equivalent across any ownership transition.
- [ ] Every removed inline tool payload and every deleted root session row has a
      verified R2 recovery object or manifest and hash evidence recorded before the
      source mutation.
- [ ] Destructive work cannot exceed the approved project/session set or the
      configured rows, bytes, R2 operations, and wall time, and can be stopped by a
      scoped circuit breaker/kill switch.
- [ ] Partial work and failures retain a readable authoritative source, persist
      resumable progress, and never publish an unverified archive owner.
- [ ] Staging validates the production-like path and has zero VMs at rest after
      verification.
- [ ] CI, specialist reviews, CodeRabbit, merge, deployment, and exact deployed
      commit are all recorded.
- [ ] The post-operation observation window shows storage relief plus stable or
      improved read cost and no new capacity, overload, CPU, or archive-integrity
      incident attributable to the operation.

## References

- `tasks/active/2026-08-31-projectdata-terminal-archive-sharding.md`
- `tasks/active/2026-09-01-archive-sharding-rollout-controls.md`
- `tasks/active/2026-09-02-manual-projectdata-cleanup-and-sharding-cadence.md`
- `tasks/active/2026-08-26-projectdata-tool-payload-r2-archival.md`
- `tasks/active/2026-08-27-projectdata-retention-convergence.md`
- `tasks/active/2026-08-31-projectdata-pre-wall-storage-relief.md`
- `tasks/archive/2026-07-02-institutionalize-projectdata-wall-time-prevention.md`
- `apps/api/src/scheduled/project-data-archive-sharding.ts`
- `apps/api/src/services/project-data-archive-rollout-controls.ts`
- `apps/api/src/durable-objects/project-data/tool-payload-manual-cleanup.ts`
- `apps/api/wrangler.toml`
- `.claude/rules/09-task-tracking.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/60-request-io-and-bundle-budgets.md`
