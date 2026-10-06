# Bounded sleep failure with transcript-and-Git recovery fallback

- SAM task: `01M42YPN0VJT93T8S9MMYV429Q` (parent `01M42WJSH7238RWH5ZH7TSSFZG`)
- Branch: `sam/implement-bounded-sleep-failure-yv429q`
- Related idea: `01M3BW047BN1SPA3YBQ68SV4T8` (completed-task sleep exhaustion has no bounded escape)
- Sibling boundaries: recovery-liveness audit `01M42YQSYPGFSX8ADC3ZYMXJVY` owns
  `task-runtime-liveness*` / `stuck-tasks*`; callback renewal `01M42YQA8QPJQBW48KTDQFAHDE`
  owns callback auth (`routes/workspaces/session-snapshots.ts` auth, `jwt.ts`, VM token code).

## Problem

Sleep is a convenience. Since #2208 a VM session may only sleep with a complete
(`available`/`none`) final snapshot, but a capture that is persistently degraded (or
whose generation is in flight) is exempt from `SESSION_SLEEP_MAX_ATTEMPTS`, so the sweep
retries every ~5 minutes forever. On Oct 4 07:27 UTC three idle sessions on pre-fix agent
`7a9782c90` had 93/101/100 attempts and pinned two nodes (since deleted by the user; do not
touch them). Non-degraded exhaustion has the opposite defect: the row goes `failed` with no
retry and the completed task's runtime stays up with no escape (idea `01M3BW04…`).

User direction (2026-10-04): filesystem preservation must not pin compute indefinitely.
After a bounded number of snapshot failures, sacrificing filesystem state is acceptable if
the transcript and the exact Git starting point survive and the recovery is honestly
labelled. "Three attempts within 15 minutes" is a proposed starting point.

## Research findings

1. `failSessionSnapshotSleepBeforeTeardown` (`services/session-snapshot-sleep-failure.ts`)
   keeps a retry deadline past `SESSION_SLEEP_MAX_ATTEMPTS` when `status='degraded'` or
   `capture_generation IS NOT NULL`. The same exemption is copied into the sweep selector
   (third clause, `scheduled/session-sleep.ts`), the selection-time exhaustion check, the
   claim (`repairableStrandedFailure`, `session-snapshot-sleep-lifecycle.ts`),
   `isSessionSleepExhausted` / `exhaustedSessionSleepSql` (`sleep-preserved-task-status.ts`),
   the in-flight predicate (`session-snapshot-sleep-predicate.ts`) and failed-task release
   (`budgetSpent`, `failed-task-preservation-release.ts`).
2. `sleepAttempts` is reset by `scheduleSessionSnapshotSleep(resetAttempts)` whenever a
   complete capture lands (`completeSessionSnapshot`), so it cannot serve as a budget that
   "cannot be reset by new capture generations". There is no persisted elapsed-time anchor.
3. The final-capture watchdog (`waitForFinalSessionSnapshot` →
   `completeActiveSessionSnapshotAsDegraded`) completes a stalled capture as
   `transcript-only` with `baseCommit: null`, and `completeSessionSnapshot` then deletes the
   previous generation's objects. A transcript-only marker can therefore destroy an earlier
   generation that carried the Git commit and a WIP bundle ("preserve existing good
   artifacts").
4. The VM agent restore (`session_snapshot_restore.go`) already restores a degraded
   snapshot as: provision repo → `restoreSnapshotGitState(baseCommit, manifest.git)` →
   apply WIP bundle → no HOME → `snapshotHarnessResumeIdentity` fails → reports `degraded`
   → `prepareFreshSessionAfterDegradedRestore` → API bootstrap starts a fresh agent with the
   recovery task's prompt. No agent change is needed for a Git-baseline wake, so pre-fix
   agents get the same exit.
5. A git bundle recorded as the WIP artifact retains the commit objects the restore needs
   (pre-fix agents: full history; current agents: unpushed commits + snapshot commits, with
   remote refs as prerequisites). A `baseCommit` with no retained bundle is a local-only
   hash and is NOT restorable by itself; verifying remote reachability would need a
   provider API call (GitHub/GitLab) — deferred (see Deferrals).
6. Old agents (`7a9782c90`) never report `baseCommit` for SAM-repo captures: `/complete`
   400s (body too large) or the watchdog fires, so the row only holds `transcript-only`
   with no Git state. For those the minimum (exact restorable commit) cannot be
   established → bounded, actionable failure instead of endless retries.
7. cf-container sleeps in place and `cleanupTaskRun` destroys the container unless the
   snapshot is `available`/`none`, so a degraded fallback teardown would make an Instant
   session unwakeable. The container DO's own idle sleep also aborts on degraded snapshots
   and is bounded only by the 24 h node lifetime. Fallback teardown is therefore VM-only;
   cf-container gets the bounded budget with the blocked outcome (rule 61 for the guard,
   documented limitation for the teardown).
8. Production D1 (read-only, 2026-10-04 ~08:10Z): 11 `scheduled` + 5 `failed` + 2
   `stopping` sleep intents whose workspace is `deleted` are re-selected every sweep
   forever (deferred as "agent is not idle (unknown)", or the stopping roll-forward refuses
   "Stopping claim lacks a complete verified workspace snapshot"). Some date from August.
9. `runSessionSnapshotPurge` (`scheduled/d1-retention.ts`) only purges `status='available'`
   sleeping rows; degraded sleeping rows never expire (231 transcript-only, 148
   entries-skipped in prod). A fallback-sleeping row must keep exact 7-day semantics, so the
   purge must cover fallback rows; legacy degraded rows are deferred (see Deferrals).
10. Explicit human follow-up enters through `routes/chat-prompt-route.ts`
    (`cancelScheduledSessionSleep(db, sessionId)` without options). VM activity re-reports
    use `preserveCompletedTaskIntent` and can repeat, so they must not reset the budget.
11. Wake: `createRecoveryTask` binds `SESSION_RECOVERY_INITIAL_PROMPT`; a fresh-start
    degraded restore sends it as the agent's first prompt. That is the hook for honest
    fallback guidance (missing files, no replay of external side effects).
12. Normal teardown already releases only the session's workspace (`stopWorkspaceOnNode`),
    schedules its deletion through the NodeLifecycle DO, stops compute tracking, runs
    `cleanupTaskRun`, and marks the node warm only if no other workspace is active
    (`finishSleepCleanup` / `markWorkspaceNodeWarmIfEmpty`). The fallback must reuse it.
13. `session-snapshot-sleep-lifecycle.ts` (524 lines) and `session-sleep-execution.ts`
    (518) exceed the 500-line limit and must be split before adding to them (rule 18).
14. A wake that restores the agent's saved session never sends the wake prompt:
    `startSamAwareAgentSession` sends `visibleInitialPrompt` only on a fresh start, i.e.
    when the vm-agent reports the restore `degraded`. A fallback that uses an older complete
    snapshot (HOME and agent context present) would resume a stale agent session with no
    guidance, behind a conversation that moved on. The vm-agent reads the resume identity
    only from the restore response's manifest (`snapshotHarnessResumeIdentity`, Go test
    `TestSnapshotHarnessResumeIdentity/rejects legacy snapshot without harness identity`),
    so withholding `acpSessionId` for a fallback-slept generation forces the fresh start
    on every deployed agent.
15. Archive is offered only for an already sleeping session (`SessionFooter`:
    `canArchiveSession` needs `sessionState === 'sleeping'`), so a blocked notice must not
    tell the user to archive. Stopping the workspace from the Workspaces page works for
    every session. `session-recovery.ts` (539 lines on `main`) also needs a split before
    more is added to it (rule 18).

## Design

- **Episode budget** (new columns on `session_snapshots`, ADD COLUMN only):
  `sleep_episode_started_at` (first claim of the episode, COALESCE), `sleep_episode_failures`
  (failed attempts this episode; a stale-lease re-claim counts as one), `sleep_fallback_json`
  (the fallback decision/record). Not reset by capture prepare/complete/degraded completion,
  deferrals, sweeps or VM re-reports. Reset only by: sleep finalize, wake commit, explicit
  human follow-up, and a failed task's new preservation episode.
- **Phases** (pure decision, `services/session-sleep-episode.ts`):
  - `full`: failures < `SESSION_SLEEP_FAILURE_MAX_ATTEMPTS` (default 3) and elapsed since
    episode start < `SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS` (default 15 min).
  - `fallback`: otherwise; each idle sweep tick tries the fallback once.
  - `blocked`: a deterministic minimum failure, or failures reach the absolute ceiling
    `SESSION_SLEEP_MAX_ATTEMPTS` (default 9, clamped above the full-phase budget).
- **Fallback minimum** (VM only): transcript store accepts the fallback notice (ProjectData
  write succeeds); the current completed generation has a full `baseCommit`, Git metadata,
  and a WIP bundle recorded and verified in R2 (size + SHA-256). A complete
  (`available`/`none`) generation is verified with the full artifact check.
- **Fallback execution**: claim (CAS), safety idleness before/after the minimum checks,
  abandon any in-flight capture generation (late uploads/completions then 409), record
  `sleep_fallback_json`, CAS `preparing → stopping` with the selected generation and no
  in-flight capture (a late complete capture makes the CAS fail → normal path wins), then
  the shared teardown + cleanup. A crashed fallback rolls forward from `stopping`.
- **Blocked**: `sleep_status='terminal_failed'`, no retry, `sleep_fallback_json.outcome =
  'blocked'`, actionable system notice. No teardown (failed tasks keep their existing
  release). A human follow-up clears a blocked episode.
- **Zombie intents**: a non-stopping intent whose workspace is no longer live, or a stopping
  roll-forward whose workspace is `deleted`, retires with a terminal reason (no resource
  mutation).
- **Wake**: recovery prompt built from `sleep_fallback_json` (branch/commit, what was lost,
  check git state, never replay external side effects); restore uses the existing pipeline.
- **Retention**: purge also takes fallback-sleeping rows (`sleep_fallback_json` present) at
  `expires_at`; expiry is `sleeping_at + SESSION_SNAPSHOT_TTL_DAYS` as for every sleep.
- **Watchdog**: never replaces a generation that carries Git state or artifacts with a
  transcript-only marker; it abandons the stalled capture instead.

## Implementation checklist

- [x] Split `session-snapshot-sleep-lifecycle.ts` and `session-sleep-execution.ts` below 500
      lines (separate commit, no behavior change)
- [x] Migration `0179_session_snapshot_sleep_episode.sql` + schema columns
- [x] Episode config + pure phase decision (`services/session-sleep-episode.ts`) with env vars
      `SESSION_SLEEP_FAILURE_MAX_ATTEMPTS`, `SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS`
- [x] Claim sets episode start; stale re-claim counts a failure; remove repairable exemption
- [x] Failure writer counts failures, always schedules a retry (no degraded exemption)
- [x] Sweep: remove exemption clause; phase dispatch (full / fallback / blocked); zombie retire
- [x] Fallback service: minimum checks, notice, CAS, shared teardown, roll-forward
- [x] Blocked outcome + notice; failed-task release consistent
- [x] `isSessionSleepExhausted` / `exhaustedSessionSleepSql` / in-flight predicate updated
- [x] Finalize/wake/human-follow-up reset the episode; follow-up clears a blocked episode
- [x] Watchdog no longer clobbers a Git-bearing generation
- [x] Purge covers fallback-sleeping rows
- [x] Recovery prompt for fallback wakes
- [x] Restore response withholds the stale agent session after a fallback sleep, keyed on
      the same predicate as the wake prompt (`sleptFallbackRecord`) — finding 14
- [x] Blocked notice points to an action that exists (Workspaces page stop) — finding 15
- [x] Split `session-recovery.ts` below 500 lines (refusal reporter, separate commit)
- [x] Env plumbing: `env.ts`, `.env.example`, `sync-wrangler-config.ts` optional list,
      `deploy-reusable.yml` `wrangler_sync_env`
- [x] Tests through `runSessionSleepSweep` (SQLite D1, fake clock): permanently degraded,
      non-degraded exhaustion, stale/late uploads, restart roll-forward, duplicate sweeps,
      new activity during teardown, human follow-up race, shared-node safety, transcript
      persistence failure, unavailable commit, good snapshot wins, exact boundaries,
      episode not reset by capture generations, zombie retire, purge at 7 days, wake prompt
- [x] Docs: `reference/configuration.md`, `architecture/overview.md`,
      `guides/session-troubleshooting.md`, `guides/chat-features.md`, `concepts.mdx`,
      `guides/instant-sessions.md`, `reference/api.md`
      (and any other statement that sleep always preserves files)
- [x] Steering rules: `apps/api/.claude/rules/47` requirement 11 + test bullet (vm-agent
      rule 78 is incident history about capture cost and does not conflict)
- [x] Steering: updated policies `a3780107`, `d08d64dc` and `2adacc8f` (2026-10-04, citing PR #2223 as pending merge)

## Acceptance criteria

- [x] A session whose captures are permanently degraded sleeps via fallback after the
      configured attempts/elapsed budget, with a visible notice, and wakes at the saved
      commit with the WIP restored and an honest agent prompt.
- [x] The budget survives restarts (persisted), duplicate sweeps, and is not reset by new
      capture generations.
- [x] Without an exact restorable commit (no baseCommit, or no retained objects) the episode
      ends blocked: no further captures, actionable notice, runtime not torn down.
- [x] A follow-up or new activity before the point of no return aborts the fallback.
- [x] Only the session's own workspace is released; other workspaces on the node stay up and
      the node is not marked warm while they run.
- [x] A complete snapshot that lands before the point of no return wins.
- [x] Fallback-sleeping rows keep the 7-day wake window and are purged after it.
- [x] Zombie intents for deleted workspaces stop looping.
- [x] Old-agent cases exit (fallback or blocked) without any agent upgrade.

Evidence: `apps/api/tests/integration/session-sleep-bounded-fallback.test.ts` covers each
criterion through `runSessionSleepSweep` with production defaults and an injected clock
(groups: permanently degraded captures, pre-fix agents, non-degraded exhaustion, the wake
after a fallback sleep, preserving good artifacts, races at the point of no return, shared
nodes, transcript and recovery-point failures, budget boundaries, Instant runtimes,
explicit sleep after a blocked episode, workspaces already gone, seven-day retention).

## Deferrals (tracked)

- cf-container fallback teardown (in-place wake from a Git baseline) → idea
  `01M434RYFTNQ0NY704JGJYHRT7` (referenced at the guard in `session-sleep-fallback.ts`).
- Remote reachability check (GitHub/GitLab API) for a `baseCommit` without a retained bundle
  → idea `01M434S53HGTY09BS09NMWEP9E` (referenced in `session-sleep-recovery-point.ts`).
- Purging legacy degraded sleeping rows past expiry (pre-existing leak) → existing idea
  `01M05HTJHCWXCG5YZJ6TB3Y2AG` (updated 2026-10-04: fallback rows are purged, legacy rows
  still excluded).
- Staging: user permitted skipping for this wave; substitute deterministic + integration
  tests (reason recorded in PR).

## Notes

- Task file committed on the feature branch (recent repo practice lands task files through
  PRs) rather than directly on `main`.
- Review (2026-10-04): 8 local reviewers. Fixed during review:
  - **Cloudflare + architecture, high:** the Instant container's automatic `force: true` claim reopened blocked episodes. Fixed with `reopenBlockedEpisode`, set only by the explicit Sleep route (e79503d40).
  - **Architecture, high:** the teardown safety gate was duplicated; now one `sleepTeardownSafetyGate` (47cfaca19).
  - **Security, medium:** the fallback notice's quoted error was not redacted; now `sanitizeSessionLifecycleMessage` (a30ad49bd).
  - **Tests:** the elapsed boundary is pinned at its exact instant, and the fallback wake round trip is covered (59f65bda1).
- Found after the first cut, before review:
  - A wake that loads the saved agent session never sends the wake prompt. The restore response now withholds `acpSessionId` after a fallback sleep.
  - Archive is not offered for awake sessions. The blocked notice now points to the Workspaces page.
- Staging skipped by explicit user permission for this wave. Evidence is in the PR: vertical-slice tests through `runSessionSleepSweep` and `VmAgentContainer.onActivityExpired`, plus full API unit (11,234) and Workers (1,288) suites.
