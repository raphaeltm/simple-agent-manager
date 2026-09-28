# Instant sessions cannot wake after idle sleep

- **SAM task:** 01M3KE6R6XM1G35W0QJBHFF15M
- **Idea:** 01M3JFFC8R6J1YE0HX0J3PS4TN
- **Branch:** `sam/fix-instant-cf-container-hff15m`
- **Constraint:** open the PR as a DRAFT and leave it in draft. Do not merge, do not mark ready.

## Problem

An Instant (cf-container) session that idle-sleeps cannot be woken by a follow-up prompt.
The follow-up fails with:

> Wake failed: The sleeping container runtime is gone and cannot wake in place.
> (container_runtime_unavailable)

Reproduced on staging (2026-09-27, session `d06c92cd-4212-4ee8-b2b5-c2cc68db80ae`): prompt
completed 22:18:41, container slept 22:20:00, follow-up enqueued 22:20:07, refused 22:20:46.

## Research Findings

Reproduced locally by driving the real sleep writer (`markRuntimeSleeping` →
`persistRuntimeSleeping`) against real SQLite, then the real resolver and the real container
DO wake. The wake is blocked at three points, in series:

1. **Resolver reads node health.** Both sleep writers — the container's idle sleep
   (`persistRuntimeSleeping`, `durable-objects/vm-agent-container-runtime.ts`) and the scheduled
   sleep (`completeSleepTeardown`, `services/session-sleep-execution.ts`) — write the node as
   `status='sleeping', health_status='unhealthy'`. `resolveVmPromptDeliveryTarget`
   (`services/vm-prompt-delivery-target.ts`) refuses a sleeping container whose node is
   `unhealthy` before it reaches the branch that treats `sleeping` as wakeable. The wake-in-flight
   writer (`persistRuntimeRecovering`) also writes `unhealthy`, so a retry that lands mid-wake is
   refused the same way.
2. **Resolver retries forever on the agent session's own sleep marker.** The sleep writers set
   `agent_sessions.status='sleeping'` (the wake writer sets `recovery`). The resolver returns
   `retry` for any non-`running`, non-terminal agent session. The in-place wake is a side effect
   of the capability probe that only runs after `ready`, so the delivery backs off to its 1 h TTL.
   (Already suspected in knowledge `SleepWakePerformance`, 2026-08-25, never verified.)
3. **The container DO refuses to wake the rows its own sleep writer left.**
   `loadRuntimeRecoveryContext` and `persistRuntimeRecovering`
   (`durable-objects/vm-agent-container-recovery.ts`) only accept workspace/node status in
   `running | creating | recovery | error`. From `sleeping` rows the context is null and
   `ensureAwake` returns `RUNTIME_RECOVERY_DEGRADED`. This also breaks the non-durable prompt
   path (`routes/chat-prompt-forward.ts`), the attention-answer route and `/resume`.

This is `.claude/rules/58`: the delivery verdict reads `nodes.health_status` — a liveness mirror
the sleep writer sets itself — instead of the record the resumer reads (row existence and
lifecycle status, then the container DO's own lifecycle).

### Regression history (answering "did #2145 or #2155 combine the two?")

Neither. The combination is older:

- **#1660 (2026-07-29)** made the idle-sleep writer set `health_status='unhealthy'` and
  `agent_sessions.status='sleeping'`.
- **#1785 (2026-08-12)** introduced the durable delivery resolver with the
  `node_health_status === 'unhealthy'` → `dead_target` check and the `running`-only agent-session
  gate, and made durable delivery the default (`DEFAULT_DURABLE_PROMPT_DELIVERY_ENABLED = true`).
  From then on every follow-up to a slept Instant session failed silently (`dead_target`, no
  visible message) or retried to TTL.
- **#2019 (2026-09-05)** added the status filter to `loadRuntimeRecoveryContext` /
  `persistRuntimeRecovering`, excluding `sleeping` — contradicting its own acceptance criterion
  "Legitimate sleep/restore ... behavior remain green". Hidden because
  `vm-agent-container-recovery.test.ts` mocks both functions.
- **#2145 (2026-09-26)** moved the resolver into `vm-prompt-delivery-target.ts` verbatim.
- **#2155 (2026-09-27)** turned the invisible `dead_target` into the visible
  `container_runtime_unavailable` report — which is how the long-standing bug was noticed.

### Why no test caught it (rule 62)

- `vm-prompt-delivery-adapter.test.ts` hand-feeds sleeping containers with
  `node_health_status: 'healthy'` and `agent_session_status: 'running'` — a state no sleep writer
  produces.
- `vm-agent-container-recovery.test.ts` mocks `loadRuntimeRecoveryContext` and the recovery
  writers.
- `failed-task-preservation.test.ts` (`wakeOldInstantFailure`) raw-`UPDATE`s the rows to `running`
  instead of driving the wake.
- No test ran the real sleep writer and then a follow-up.

### Production evidence (read-only, `CF_PRODUCTION_DEBUGGING_TOKEN`)

- #2145 live 2026-09-26T00:43Z; #2155 live 2026-09-27T02:03Z.
- Workers Logs 2026-09-21 → 2026-09-28: 0 `session_recovery.refused`, 0 `wake_failure.visible`,
  0 `prompt_delivery_failed`, 0 `vm_agent_container_runtime_sleeping` (the query path was verified
  against `cron.completed` and `prompt_delivery_retry`, which return events).
- D1 `sam-prod`: newest cf-container node created 2026-09-19T07:06Z; all 216 cf-container nodes
  `deleted`; 0 cf-container snapshots `sleeping`; 0 with `recovery_error`.
- So: **0 refusals since #2145/#2155**, because production has run no Instant session since
  2026-09-19. The latent exposure dates to #1785 and was invisible before #2155.

### Enumerated writers of the rows the verdict reads (rule 44 / 58)

| Writer                                               | node                                      | workspace                    | agent session | Verdict after fix |
| ---------------------------------------------------- | ----------------------------------------- | ---------------------------- | ------------- | ----------------- |
| `persistRuntimeSleeping` (container idle sleep)      | sleeping / unhealthy                      | sleeping                     | sleeping      | wake              |
| `completeSleepTeardown` (scheduled sleep)            | sleeping / unhealthy                      | sleeping                     | sleeping      | wake              |
| `persistRuntimeSleepingAfterRevokedWake`             | sleeping / unhealthy                      | sleeping                     | sleeping      | wake              |
| `persistRuntimeRecovering` (wake in flight)          | recovery / unhealthy                      | recovery                     | recovery      | wake (joins)      |
| `persistRuntimeRecovered` (woken, not yet committed) | running / healthy                         | running                      | running       | wake (commits)    |
| `persistRuntimeRecoveryFailed` (wake exhausted)      | error                                     | error                        | error         | refuse            |
| `persistRuntimeEnded` / finalizer (explicit stop)    | stopped                                   | stopped                      | stopped       | refuse            |
| deletion / cleanup                                   | destroying / deleted / stopping / missing | deleted / stopping / evicted | —             | refuse            |

### Known limitations (pre-existing, not changed here)

- A capability probe that times out mid-wake calls `markVmAgentContainerRequestInterrupted`
  (`tasks/backlog/2026-07-21-instant-container-request-timeout-cancellation.md`).
- Nothing nudges the queued delivery when an in-place wake finishes; the prompt lands on the next
  backoff tick (knowledge `SleepWakePerformance`, 2026-08-25).

## Implementation Checklist

- [x] Shared authority in `vm-agent-container-recovery.ts`: the runtime statuses the container DO
      can wake in place include `sleeping`; `loadRuntimeRecoveryContext` and
      `persistRuntimeRecovering` both use it. Deletion states stay excluded.
- [x] Resolver: a sleeping container gets its own verdict that refuses only missing or terminal
      rows, mirrors the resumer (comment names `loadRuntimeRecoveryContext`), never reads
      `health_status`, and admits the agent session's `sleeping`/`recovery` markers. Justify the
      one deliberate strictness (`error` = exhausted wake) in the comment.
- [x] Extract the shared terminal-status lists and the `ready` target construction so the live
      and sleeping paths do not duplicate them.
- [x] Vertical slice (real sleep trigger → real ProjectData runner → real adapter/resolver → real
      container DO wake → real recovery writers, all on real SQLite), for both sleep writers.
      Verify it fails on main and record which assertion goes red.
- [x] Discriminating control: a container that is really gone still reports
      `container_runtime_unavailable` (visible wake failure) and is never started.
- [x] Controlled-ordering test: a retry landing while the in-place wake is restoring is not
      refused, and the delivery completes once the wake finishes.
- [x] Real Miniflare D1 test: rows left by the real sleep writer can be claimed for recovery;
      deletion states still cannot.
- [x] Update existing sleeping-container unit fixtures to the realistic post-sleep shape.
- [x] Surgical reverts: each fix reverted alone reddens the intended tests; record in PR.
- [x] Docs: check public docs for Instant sleep/wake claims and update if stale. (No change:
      `guides/instant-sessions.md` already documents send-to-wake, which is now true; the
      pre-existing `CF_CONTAINER_WAKE_TIMEOUT_MS` claim is noted in idea 01M0VZ205TN8A1JYHNJN77DS4F.)
- [x] File SAM ideas for follow-ups found: live-container crash recovery `dead_target` →
      idea 01M3KH4NKPAY873F790RQY2XDN; wake-completion delivery nudge → appended to existing idea
      01M0VZ205TN8A1JYHNJN77DS4F; `sleepForUser` lifecycle-lock hardening → idea
      01M3KJFYDXMABJDCK7GA864017.
- [x] Staging regression (found in Phase 6): archiving a slept Instant session through
      `POST /sessions/:id/stop` returned 500, because the stop's pre-teardown signal woke the
      container. The chat stop and cancel routes now skip a sleeping runtime
      (`isSleepingContainerRuntime`, `47037a749`).
- [x] Enumerate every request that can reach a slept container (rule 67). Result: the table in the
      PR. The workspace-page per-session stop needed the same guard (`a0d22b9fd`, after the pure
      move `89a40c6b9`, rule 18). Non-durable wakes that skip the commit and the activity probe
      went to idea 01M3KX6RV5KGFZVCC7VK6Z6QHK. The chat list's stale sleep icon went to idea
      01M3KTV8E8NPAR1MD6ZY4Y53NK.
- [x] Vertical-slice tests for chat stop, chat cancel and the workspace-page stop on a slept
      session, through the real routes and the real teardown, with controls on both sides of each
      guard. Each guard was reverted, and separately over-fired, and reddened only its own tests.

## Acceptance Criteria

- [x] An idle-slept Instant session with a completed snapshot receives a follow-up prompt and
      wakes (vertical slice through the real sleep writer; fails on main).
- [x] A container that is genuinely gone still reports `container_runtime_unavailable`.
- [x] Production count of the same wake refusals since #2145/#2155 is in the PR. (Measured: 0.)
- [x] Staging: start an Instant session, let it idle-sleep (~75 s after the turn), send another
      prompt, confirm it wakes and answers. Clean up afterwards. (See "Staging" below. The final
      commit `a0d22b9fd` still needs its own deploy once staging is free.)
- [ ] Draft PR opened, left in draft; idea updated with the PR link.

## Implementation Notes

- The pure move of `persistRuntimeRecoveryFailed` into `vm-agent-container-recovery-failure.ts`
  (rule 18; the module was 572 lines) landed as its own commit before the fix.
- Review follow-ups (commit `8589cb608`): the sleeping-container verdict now derives from the
  container DO's own `IN_PLACE_WAKEABLE_STATUSES` (less the documented `error` strictness) instead
  of a parallel terminal list. It also mirrors the resumer's cf-container-node and
  `runtime_deletion_confirmed_at` predicates. Before this, a node mid-teardown (`destroying`) was
  probed and retried until TTL instead of being reported.
- Fails on main: against origin/main's `apps/api/src` the final vertical slice reports 4 failed /
  3 passed.
  - Both sleep-writer cases fail with the incident's exact "Wake failed: The sleeping container
    runtime is gone and cannot wake in place. (container_runtime_unavailable)".
  - The mid-wake case is refused before any wake begins.
  - The `destroying` control fails there too: main retried a mid-teardown node until TTL.
  - The other three gone-container controls pass.
- Surgical reverts on the final code (each alone; slice + adapter unit tests):
  - Container DO no longer wakes `sleeping` rows → the 3 wake tests.
  - Verdict reads node health, or waits for a `running` agent session → the 3 wake tests plus the
    adapter's positive probe case.
  - Refuse only `recovery`+`unhealthy`, or retry only an agent session in `recovery` → only the
    mid-wake test.
  - Node status unchecked → the deleted-node unit control plus the `destroying` and `deleted`
    slice controls.
  - Node runtime unmirrored → only the non-container-node unit control.
  - Confirmed deletion unrefused → only its slice control.
  - Workspace status unchecked → only the deleted-workspace unit control.
  - Miniflare D1: removing the `sleeping` admission reddens the two wake cases; removing the
    deletion fence reddens only its control.
- Harness lesson: the ProjectData substitute must not load the real module through
  `importOriginal`. Against main's module graph, the container's dynamic import then reached the
  real RPC. The substitute lists exactly the calls these flows make.
- Local reviewers:
  - task-completion-validator: PASS.
  - cloudflare-specialist: ADDRESSED. MEDIUM-1 fixed; MEDIUM-2 → idea 01M3KJFYDXMABJDCK7GA864017.
  - architecture-reviewer: ADDRESSED. HIGH fixed; MEDIUM → appended to idea
    01M3KH4NKPAY873F790RQY2XDN.
  - test-engineer: ADDRESSED. The mid-wake gate is now explicit, and third-writer coverage is
    documented.
- Validation: full API unit suite 10,901/10,901 (before the review fixes); resolver- and
  container-related unit files, the Workers subset, the API build and `check:fast` re-run on the
  final code.

### Staging (2026-09-28, Potato project, profile `rollout-recovery-phase1-live` = `cf-container`)

- Fix deployed (run 36407713214). Instant session `cbda0fae…`:
  - Answered at 10:54:53, then idle-slept at 10:55:56. The rows took the incident's exact shape.
  - The follow-up at 10:56:32 woke it in place; it answered "142" in 36 s.
  - A second cycle answered "77" in 37 s.
  - No "Wake failed" message, attention `null`, 0 console errors.
- VM control `cbb7fed4…`: a recovery-task wake answered "142".
- Regression: `POST /sessions/:id/stop` on the slept session returned 500. Reproduced under a full
  `wrangler tail` (request `4fd93a4b…`):
  - The stop's cancel signal started `vm_agent_container_recovery_started` (idle).
  - The container booted and then fetched a snapshot the same request's teardown had already
    deleted (404).
  - `stopNodeResources` threw "Managed node changed before teardown could be claimed".
  - No container leaked: the heartbeats stopped, and a later sweep confirmed the deletion.
- Guards deployed (`47037a749`, run 36415494306; live from 11:32). Session `8e84fa9f…`:
  - Cancel while asleep: `idle`, and the heartbeat did not move.
  - The follow-up woke it; "142" in 21 s.
  - Chat stop while asleep: 200 in about 16 s, no wake, workspace deletion confirmed.
- The UI Archive check (`/tasks/:id/close`) on session `e07b68c5…` ran after another task's deploy
  replaced the Worker (11:50:53). It therefore exercised main's code, not this branch, and counts
  as inconclusive.
- Still to verify on staging, once another task's run frees it: the final commit `a0d22b9fd`, i.e.
  the workspace-page stop of a slept session, plus UI Archive of a slept session on this branch.

## References

- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md` (apps/api scoped copy)
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`
- `tasks/archive/2026-09-04-truthful-vm-workspace-deletion.md` (#2019)
