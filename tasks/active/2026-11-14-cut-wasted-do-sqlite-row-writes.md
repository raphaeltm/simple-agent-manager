# Cut wasted Durable Object SQLite row writes (archive pressure gate, system-owned webhook targets)

SAM task `01M7CVZNSP0EHV9BJ72HCFQJSC`. Idea `01M7CX61WVX72T7CFQNRTX0DVM` holds the full measurement.

## Problem

Raphaël, 2026-11-14: "My top priority right now is fixing this. It should not cost us this much on
DO SQLite." Cloudflare bills Durable Object SQLite at $1 per million rows written above 50M a month.
Production wrote 2.32M rows on 2026-11-13 and 1.5M by 11:15Z on 11-14, against 0.7-1.4M a day a
week earlier. Month to date is 19.9M, so the included amount is exhausted around 11-24 at this rate.

Two parts of that are writes that buy nothing:

A. The unscoped archive sweep picks candidates largest-first across every project
(`projectDataArchiveCandidateSql()` in
`packages/project-data/src/scheduled/project-data-archive-sharding.ts`) and never looks at
storage. On 11-13 it archived 177,407 messages from project TTV, whose root object is at 11.4%
of its limit, plus ~17k from other small projects: about 320k row writes (14% of the day).
Only the SAM root (92%) needs the drain.
B. `admitGitHubWebhookProjectEvents()` (`apps/api/src/services/github-project-event-producer.ts`)
admits every GitHub webhook into every project bound to the repository. Project
`01KQFZA5N37Y32SREBGRYHNXFB` is owned by the retired trial sentinel user
(`SYSTEM_USER_ID`), has no tasks, sessions or triggers, and is bound to
`raphaeltm/simple-agent-manager`. It receives 10,373 events a day: ~125k row writes and 26M rows
read a day, and its object has grown to 1.04 GB.

## Research findings

- Billed metrics (rule 76): `pnpm quality:cloudflare-cost` and `durableObjectsPeriodicGroups` by
  `objectId`; per-operation sums from the logged `project_data_archive_sql_usage` and
  `project_data.alarm.completed` events. Numbers are in the idea.
- `project_data_storage_telemetry` (D1, one row per project, `usage_ratio`, `measured_at`) is
  written hourly by the ProjectData storage alarm. It is the only per-project storage signal D1 has.
- Condition vs signal (rule 74): the condition is "this project's root object is under storage
  pressure"; the signal is the last telemetry row. They diverge when telemetry is missing or stops
  being written. A gate that trusted a stale low reading could hold the drain off an object that is
  filling up, so a missing or stale row must leave the project eligible.
- Only new-candidate selection changes. In-flight migrations, pending reclaim, crash-gap recovery
  and the operator-scoped canary (`selectScopedCandidates`) must keep working for every project:
  an operator who names a project is asking for that project, and a migration that started must
  finish.
- Tunables go in the admin settings registry, not new Worker vars
  (`.claude/rules/07-env-and-urls.md`, `pnpm quality:runtime-tunables`). The sweep lives in
  `packages/project-data`, which cannot import `apps/api`; the cron handler
  (`apps/api/src/scheduled/handler.ts`) resolves the settings and passes them in.
- `findProjectsForGitHubRepository()` (`packages/repo-hosting/src/github-project-repositories.ts`)
  has two callers: the event producer and `ingestPullRequestWebhook()`
  (`apps/api/src/services/github-pull-request-events.ts`). Only the producer's cost is measured, so
  only the producer changes (rule 67). Rule 40: sentinel-owned rows are excluded from business
  logic, through the shared `SYSTEM_USER_ID` constant.
- The gate does not lower the SAM root's drain: the slots, wall time and write budget it frees go to
  the pressured project. The daily total falls only by what other projects were costing.

## Implementation checklist

- [x] A1. `packages/project-data`: unscoped candidate SQL joins `project_data_storage_telemetry` and
      keeps a session only when the gate is off, the project has no telemetry row, the row is older
      than the max age, or `usage_ratio` is at or above the minimum. Defaults as `DEFAULT_*`
      constants.
- [x] A2. `runProjectDataArchiveSharding(env, now, options)` takes the two values; the scoped canary
      and reclaim paths are untouched.
- [x] A3. The tick reports what the gate held back (sessions, projects, threshold) in its stats so
      the refusal is recorded and aggregatable.
- [x] A4. Two admin settings (`operations.*`), resolved in the cron handler; a settings read failure
      falls back to the defaults and never skips the sweep.
- [x] A5. Tests on real SQL: low-pressure project skipped with a pressured control; missing row
      eligible; stale row eligible; gate 0 restores old behaviour; scoped run still selects a
      low-pressure project; threshold boundary; stats disclose the skipped count.
- [x] B1. `GitHubProjectCandidate` carries `userId`; the producer drops projects owned by
      `SYSTEM_USER_ID` before admitting.
- [x] B2. Tests: a system-owned project on the repository gets no admission while a user-owned
      project on the same repository still does; a repository with only a system-owned project
      reports `no_project`.
- [x] Docs: public docs that describe the archive sweep or admin settings mention the gate.
- [ ] Update idea `01M7CX61WVX72T7CFQNRTX0DVM` with the shipped state.

## Acceptance criteria

- [ ] With default settings the unscoped sweep selects no session from a project whose latest fresh
      telemetry is below the threshold, and still selects from a pressured project in the same tick.
- [ ] A project with no telemetry row, or a stale one, is still archived.
- [ ] Operator-scoped runs, in-flight migrations and pending reclaim are unchanged.
- [ ] A GitHub webhook for a repository with a system-owned project and a user-owned project admits
      one event, into the user-owned project.
- [ ] Staging: a sweep tick on the deployed branch reports the gate in `cron.completed`, and a
      low-pressure project's eligible session stays in root while the tick runs.
- [ ] After production deploy: daily rows written for project TTV's root and for
      `01KQFZA5N37Y32SREBGRYHNXFB` fall to their non-archive, non-event baseline (billed metric,
      next full UTC day).

## Implementation notes

- A lives in `STORAGE_PRESSURE_GATE_SQL` / `unscopedCandidateFromWhereSql()`; the held count is
  `countStoragePressureHeld()`. Settings: `operations.projectDataArchiveMinStorageUsagePercent`
  (default 50) and `operations.projectDataArchiveStorageTelemetryMaxAgeHours` (default 24),
  resolved by `resolveProjectDataArchiveSweepOptions()` in
  `apps/api/src/scheduled/project-data-archive-sharding.ts`.
- The registry already answers a failed settings read with its outage value (the default), so the
  wrapper's own catch is a second line, not the main path.
- Proven discriminating: with the gate predicate made always-true, both cases in
  `tests/workers/project-data-archive-storage-pressure-gate.test.ts` fail ("expected true to be
  false" on the quiet project staying in root). With the producer filter made always-true, both new
  cases in `tests/workers/github-project-events.test.ts` fail.
- `findProjectsForGitHubRepository()` now returns `userId`. Its other caller,
  `ingestPullRequestWebhook()`, is unchanged; three hand-written test schemas needed the
  `project_data_storage_telemetry` table or the `user_id` column.
- The task file went onto the feature branch rather than straight to `main`, and no git worktree
  was used: this is a SAM workspace, where snapshots capture only the primary checkout.

## Not in this task

Per-RPC row accounting (task `01M7CX7ANP9HNSP7PGSBT886WS`), event admission cost on real projects,
ingest per-batch overhead, the retention scan. All are listed in the idea.
