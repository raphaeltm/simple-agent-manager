# Fix stuck-task sweep D1 LIKE crash + make Instant launch durable (TaskRunner DO)

## Problem Statement

Two production bugs, diagnosed live on 2026-08-07 (session `adc0d788`, EffProp incident session `28dbbe02-5663-47b4-a652-9a6eddd82149`, task `01KZECB26257JD03VFSNW0J5G6`):

1. **The `stuck_tasks` scheduled sweep crashes on every run** — 311 consecutive failures
   since 2026-08-06T13:35:47Z, every 5 minutes, with
   `D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR`. The DO/D1 mismatch dedup
   query at `apps/api/src/scheduled/stuck-tasks.ts:999-1005` binds the pattern
   `%do_task_status_mismatch%<26-char-taskId>%` (52 bytes). **Production D1 caps LIKE
   patterns at exactly 50 bytes** (verified empirically against prod: 50 OK, 51 fails).
   The query sits OUTSIDE the per-candidate try/catch (recovery try starts at line 1031),
   so one candidate entering the mismatch branch aborts the entire sweep — no stuck task
   anywhere on the platform has been recovered since 2026-08-06. The scan cursor also
   never advances past the crash, so every run re-dies on the same candidate
   (rule 53 violation: unisolated step; rule 47: immortal candidate).
   Current trigger candidate: task `01KZD5S2N5JGD6XBPWXYR3HQWG` (in_progress,
   `awaiting_followup`, 12+h, live heartbeat, TaskRunner DO reports completed).

2. **Instant (cf-container) session launch strands tasks in `queued`/`instant_persistence`
   forever when the background continuation dies.** `continueInstantSessionLaunch` runs
   under request-scoped `ctx.waitUntil` (browser path `chat-start.ts:256` via
   `scheduleBackground`; MCP dispatch path `mcp/dispatch-instant.ts:110`). Cloudflare
   cancels unsettled `waitUntil` work ~30s after the response completes (and on client
   disconnect), and cancellation runs NO catch block — so the failure-marking/cleanup
   catch in `continueInstantSessionLaunch` never executes. In the incident: 202 returned
   at 15:09:21, the EffProp clone took 33s, the continuation was killed mid
   `create_workspace`, the vm-agent's independent `/ready` callback still marked the
   workspace `running` at 15:09:54, and no agent was ever started — zero telemetry,
   zero `agent_sessions` row, container idle at 0 CPU until it slept at 16:03. The
   `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` (120s) budget from the 2026-07-19 clone
   fix is illusory beyond ~30s because the waitUntil envelope dies first. The TaskRunner
   DO header literally documents this class: "Replaces the unreliable
   `waitUntil(executeTaskRun())` approach" — the instant path reintroduced it.

Compounding: bug 1 killed the safety net (sweep `instant_persistence` recovery,
`stuck-tasks.ts:873-878`) that was supposed to catch bug 2's strandings.

## Research Findings

- **D1 LIKE limit is length-based (50 bytes), not wildcard-count-based** — verified
  against production and local workerd (51-byte pattern fails identically in
  vitest-pool-workers). Boundary: 50 OK / 51 fails.
- **Why tests never caught it**: SQLite's pattern-length check lives inside the `like()`
  function, which only evaluates per-row. Against an EMPTY `platform_errors` table the
  query succeeds (verified locally: 52-byte prod pattern OK on empty table, fails with
  ≥1 row). Discriminating regression tests MUST seed at least one row.
- Sweep candidate selection (`selectStuckTaskCandidates`, stuck-tasks.ts:234) is
  KV-cursor-paged over all `queued/delegated/in_progress` tasks with no age bound —
  once fixed, the sweep will also fail the stranded July tasks
  (`01KXVX7W6BVFHQDQSR0S93TE89`, `01KXVWWDRJ6M8GW6X9HFX3YPPH`) and today's
  `01KZECB26257JD03VFSNW0J5G6`.
- The per-candidate loop body: compaction detection (isolated, :816-844) → status
  switch + DO-health/mismatch block (:846-1029, **NOT isolated** — the fatal query is
  here) → recovery (:1031+, isolated). The crash also skips `persistStuckTaskScanCursor`.
- Sweep recovery already destroys cf-containers via `cleanupTaskRun` →
  `stopNodeResources` (task-runner.ts:116-124), but **fails the chat session only for
  compaction-loop recoveries** — a recovered instant conversation still looks alive in
  the UI forever.
- Both instant launch paths (browser + MCP dispatch) use request-scoped waitUntil; no
  path runs the launch in a DO (Explore trace, 2026-08-07). `markQueuedTaskFailed`
  (`services/task-failure.ts`) is the queued-guarded failure transition used by dispatch.
- TaskRunner DO (`durable-objects/task-runner/index.ts`) is per-task
  (`idFromName(taskId)`), alarm-driven, with `storage.transaction(put + setAlarm)`
  start pattern. Instant tasks currently have NO TaskRunner state (`getStatus` → null,
  sweep probe outcome 'missing'). `startSamAwareAgentSession` already runs inside this
  DO for VM tasks (`agent-session-step.ts`) — precedent for calling the shared
  bootstrap from DO context.
- `continueInstantSessionLaunch` phases: launch container → wait ready →
  create_workspace (clone; up to 120s) → `startSamAwareAgentSession` (agent bootstrap)
  → finalize D1 (workspace.dispatchedAt, task → in_progress/agent_running). Its catch
  does: task failed/launch_failed → session failed → workspace error → node error →
  destroy container.
- Related backlog: `tasks/backlog/2026-07-19-instant-launch-stuck-queued-on-disconnect.md`
  (this task completes it); `2026-08-07-fix-stuck-task-sweep-pattern-complexity.md` +
  `2026-08-07-durable-background-vm-provisioning.md` exist on unmerged branch
  `fix/provisioning-node-cleanup-race` (separate incompatible-agent cleanup-race hotfix);
  idea `01KXZNPR69JGK7S99KMPFCRZWJ` (instant watchdog gap).
- Rules: 53 (isolate every step of scheduled handlers), 47 (candidate escape paths),
  43 (job contexts independent of request context), 02 (post-mortem + process fix).

## Implementation Checklist

### Fix 1 — stuck_tasks sweep

- [x] Replace the 52-byte dedup pattern with two ≤50-byte conditions
      (`context LIKE '%do_task_status_mismatch%' AND context LIKE ?` bound to
      `%<taskId>%`), with a comment citing the D1 50-byte LIKE pattern limit
- [x] Wrap the per-candidate evaluation section (status switch + DO-health/mismatch
      block) in a per-candidate try/catch: structured log + guarded persistError +
      `result.errors++` + continue to next candidate (rule 53)
- [x] Ensure the failure-recording path in that catch cannot itself throw
      (`.catch()` on persistError)
- [x] Sweep recovery fails the chat session for recovered conversation-mode tasks
      (add `task_mode`, `chat_session_id` to `STUCK_TASK_CANDIDATE_COLUMNS`; guarded
      `projectDataService.failSession`)
- [x] Workers-pool regression test (real D1): seeded `platform_errors` row + candidate
      in the mismatch branch → pre-fix query shape throws, fixed sweep completes and
      dedup still works (verify test goes red against the 52-byte pattern once)
- [x] Per-candidate isolation regression test: candidate A's evaluation throws →
      candidate B is still recovered, `result.errors` counts A, cursor advances
- [x] Regression test: recovered queued/`instant_persistence` conversation task gets
      its chat session failed + container cleanup invoked

### Fix 2 — durable Instant launch via TaskRunner DO

- [x] Extract `continueInstantSessionLaunch`'s catch-block cleanup into an exported
      `markInstantLaunchFailed(db, env, ref, message)` (also marks lingering `running`
      agent_sessions rows for the workspace as error); reuse in the existing catch
- [x] Extract the success tail (workspace.dispatchedAt + task → in_progress) into
      `finalizeInstantLaunch(...)`; add optional hooks
      (`beforeAgentBootstrap` / `afterAgentBootstrap(agentSessionId)`) to
      `continueInstantSessionLaunch`
- [x] New `task-runner/instant-launch.ts`: `InstantLaunchJob` record
      (milestones `pending → bootstrap_started → bootstrap_complete → done|failed`,
      `attempted` flag) + alarm handler: first attempt runs
      `continueInstantSessionLaunch` with milestone hooks; retry-after-interruption
      fails closed via `markInstantLaunchFailed` when milestone < bootstrap_complete,
      finalizes idempotently when ≥ bootstrap_complete; terminal milestones no-op
- [x] TaskRunner DO: `startInstantLaunch(input, accepted)` RPC
      (transaction put + setAlarm(now), idempotent re-ensure like `start()`); alarm()
      multiplex checks the instant job key before the VM state machine; VM state and
      instant job must never coexist (guard + log)
- [x] `chat-start.ts`: replace `scheduleBackground(continueInstantSessionLaunch(...))`
      with awaited `startInstantLaunch` RPC (accept-phase inline catch unchanged)
- [x] `mcp/dispatch-instant.ts`: accept inline (existing `markQueuedTaskFailed` guard
      for accept-phase failures) + `startInstantLaunch` RPC; remove the waitUntil
      continuation; update/remove `launchInstantSession` wrapper per no-dead-code
- [x] Cancellation regression test (backlog criterion): job stored + `attempted=true` +
      milestone `pending` (simulated mid-flight death) → alarm run marks task failed,
      session failed, container destroyed — never stuck queued
- [x] Happy-path DO test: `startInstantLaunch` → alarm → launch completes (mocked
      container/vm-agent boundary), task in_progress
- [x] `bootstrap_complete` interruption test: retry finalizes only (no second agent
      bootstrap call), task in_progress
- [x] Update chat-start + dispatch-instant unit tests for the DO wiring

### Docs, process fix, hygiene

- [x] Post-mortem + process fix (rule 02): new rule for the D1-statement-limit class
      (LIKE 50-byte cap; discriminating tests must seed rows so `like()` evaluates);
      extend rule 43 to name request-scoped `waitUntil` as a non-durable context that
      must not own launch/provisioning work
- [x] Archive `tasks/backlog/2026-07-19-instant-launch-stuck-queued-on-disconnect.md`
      with completion notes (criteria mapping; production stranded-row cleanup verified
      post-deploy)
- [x] CLAUDE.md Recent Changes entry
- [x] Verify `INSTANT_START_STALE_TIMEOUT_MS` is documented in `apps/api/.env.example`
      (add if missing)

## Acceptance Criteria

- [ ] Production-shaped mismatch dedup no longer errors; `stuck_tasks` sweep completes
      on staging (observability shows a successful sweep, zero
      `cron_sweep_failure/stuck_tasks` records post-deploy)
- [x] One throwing candidate cannot prevent other candidates from being evaluated or
      recovered, and cannot stop the scan cursor from advancing (unit regression proven
      discriminating: red on pre-fix code, green post-fix)
- [x] An Instant session whose Worker-side continuation dies mid-launch is NEVER left
      `queued` indefinitely: either the DO completes the launch, or the task is failed
      with a diagnosable error, the chat session is failed (UI-visible), and the
      container is destroyed (DO interruption-classification tests + workers vertical
      slice)
- [x] Instant launches that exceed the ~30s post-response window now complete (DO alarm
      context, not request-scoped waitUntil; source-contract pin: no
      `executionCtx.waitUntil` in chat-start.ts)
- [ ] Live staging verification: real Instant session launch works end-to-end
      (agent responds) after the change
- [ ] Post-production-deploy: stranded tasks `01KZECB26257JD03VFSNW0J5G6` (+ July
      strandings if still queued) are failed by the revived sweep

## Post-Mortem

**What broke (user-visible):** (1) No stuck task anywhere on the platform was
recovered for 26.5+ hours — including the reporter's EffProp Instant session,
which sat "working" forever after its launch silently died. (2) Any Instant
launch whose container-side work exceeded ~30s post-response was silently
killed: no agent, no error, task queued forever, container billing idle.

**Root causes:** (1) The sweep's mismatch-dedup bound a 52-byte LIKE pattern;
D1 caps LIKE patterns at exactly 50 bytes, and the check lives inside `like()`
so it only fires when a row is evaluated — empty-table tests passed while every
production run crashed. The query sat outside the per-candidate try/catch, so
one candidate aborted the whole sweep and froze the scan cursor. (2) The
instant-launch continuation ran under request-scoped `ctx.waitUntil`, which
Cloudflare cancels ~30s after the response completes without running catch
blocks — reintroducing the exact pattern the TaskRunner DO was built to
eliminate (its header says so verbatim).

**Timeline:** LIKE dedup shipped 2026-07-16 (PR #1567), latent until a
completed-DO/active-task candidate first appeared 2026-08-06T13:35Z → 311
consecutive sweep failures. The waitUntil gap was documented 2026-07-19
(`tasks/archive/2026-07-19-instant-launch-stuck-queued-on-disconnect.md`) after
the clone-timeout incident; the 120s create budget added then was illusory
beyond ~30s. Both detonated together 2026-08-07 15:09Z (task
`01KZECB26257JD03VFSNW0J5G6`), diagnosed live the same day.

**Why tests missed it:** the LIKE limit is row-evaluated (empty observability
tables in every test), and no test simulated launch-context cancellation.

**Class of bug:** (1) engine limits enforced only on evaluated rows — a query
can be structurally broken yet green against empty fixtures; (2) state-bearing
background work owned by a cancellable request context (rule 43 class).

**Process fix:** new rule
`.claude/rules/55-d1-statement-limits-and-request-scoped-waituntil.md`
(≤50-byte patterns, seeded-row test requirement, waitUntil-is-not-durable);
rule 43 amended to name `ctx.waitUntil` explicitly. Discriminating regression
tests verified red against pre-fix code for both bugs.

## References

- Diagnosis session: `adc0d788-0708-4c7f-95c9-6bcce2f56119` (2026-08-07)
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/43-long-running-mcp-tools.md`
- `tasks/archive/2026-07-19-fix-instant-container-clone-timeout.md`
- specs/032-tdf-2-orchestration-engine/ (TaskRunner DO design)
