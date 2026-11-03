# A required sleep must not fail

## Problem

Raphaël, 2026-11-03: "I want it to be as close to impossible as possible for a required sleep to
fail to take place." Policy `a3780107` items 2–3 record the decision.

**Production evidence.** Chat `ba36fd60-6b16-4001-a019-173cb8b2e9aa`:

- Its ACP turn hung at about 02:51Z. Activity stayed `prompting`, so every sleep check deferred.
- Node `01M6DPQANHDKK2JA5HE83W506G` hit its 24 h absolute lifetime at about 09:45Z.
  `prepareAbsoluteLifetimeRelease` queued an ordinary sleep, which kept deferring. After the hold it
  posted "SAM will terminate the idle workspace through its bounded sleep cleanup", but the bounded
  fallback only fires on failures, so nothing happened.
- At 11:33Z Raphaël deleted the node by hand. The finalizer preserved the chat because a sleep was in
  flight. At 11:35Z the sweep retired that sleep (`retireDeadWorkspaceSleepIntent`), leaving the chat
  `active` with no workspace, a cancelled task, and `sleeping_at` NULL. That state is unwakeable
  (idea `01M6GMC41STXANHZ90GA5PJ8Q1`).

## Research findings

- **Explicit Sleep.** Two routes reach it: `POST /api/projects/:projectId/sessions/:sessionId/sleep`
  (`routes/chat-session-controls.ts`) and `POST /api/workspaces/:id/sleep`. Both call
  `sleepWorkspaceSession` (`services/session-sleep-execution.ts`) without a claim id, which makes it
  `requestedByPerson`. While the agent is `prompting`:
  - `sleepTeardownSafetyGate` (`session-sleep-eligibility.ts`) refuses with "Workspace agent is not
    idle (prompting)", and the route answers 409;
  - `failSessionSnapshotSleepBeforeTeardown` adds to `sleep_episode_failures`.
- **Where the gate re-runs.** `verifyAndBeginSleepTeardown` checks it before capture, after capture
  and before stopping, using `idlenessStateChanged`. `completeSleepTeardown` checks it again after
  the point of no return. The bounded fallback (`session-sleep-fallback.ts`) checks it again too.
- **Forceful stop already exists on the VM.** `/cancel` → `CancelPromptFromControlPlane` →
  `StopProcessForPromptCancel` sends SIGTERM, then SIGKILL after the stop grace, and the agent
  restarts as an intentional stop. The control plane calls it from `cancelAgentSessionOnNode`
  (`services/node-agent.ts`). `routes/chat-cancel.ts:interruptChat` then calls
  `recordSessionTurnEnd` (reason `cancelled`, `observedAt` captured before the VM call), on VM
  success and on 409. Hibernate (snapshot) does not stop the agent; the process dies only at
  workspace stop.
- **The fallback only fires on failures.** `sessionSleepEpisodeTrigger` needs 3 failures, or 15 min
  after the first failure; deferrals never count. The fallback also re-runs the safety gate, so it
  defers a session that is still prompting. When it does run, the chat ends up wakeable:
  `markSessionSnapshotSleepingWithConfig` sets `sleeping_at`, and a transcript-only result is still
  restorable.
- **Node lifetime.** `sweepMaxLifetimeNodes` (`scheduled/node-cleanup/node-phases.ts`) skips a node
  with recent workspace activity even past the 24 h absolute ceiling, so the ceiling is not absolute.
  `prepareAbsoluteLifetimeRelease` queues an ordinary sleep with no "required" marker. The hold is
  `max(unhealthyReleaseAfterMs, maxAttempts × retryDelay)`, about 45 min.
- **The finalizer preserves on an in-flight sleep.** On node deletion,
  `finalizeProjectDataSession` (`services/workspace-lifecycle-finalizer.ts`) preserves the session
  when `findRestorableOrInFlightSleepSnapshot` matches an in-flight sleep. The sweep later retires
  that intent (`session-sleep-fallback-state.ts:retireDeadWorkspaceSleepIntent`) and leaves the
  session `active`. The wake path, `loadRecoveryContext`, requires `sleeping_at`.
- **Runtimes.** VM and Instant (cf-container) share `sleepWorkspaceSession` and the gate. Instant's
  teardown is `sleepVmAgentContainer`. `isSleepingContainerRuntime` must skip a cancel for a
  container that is already sleeping, because a cancel would wake it.
- **Tunables.** New tunables must go in the admin settings registry
  (`admin-settings-core-definitions.ts` with `resolveAdminSetting`). A new `Env` scalar fails
  `quality:runtime-tunables`.

## Design

A sleep requirement level, `normal | deadline | required`. A new
`services/session-sleep-requirement.ts` resolves it in one place:

- **required:** a person-initiated sleep, OR the workspace's managed VM node is older than the
  absolute lifetime plus the leeway (`operations.nodeLifetimeForceSleepAfterMs`, default 30 min).
- **deadline:** the node is past the absolute lifetime but still within the leeway. The session
  sleeps as soon as its turn ends, skipping the idle interval, but nothing is killed.
- **normal:** everything else, unchanged.

How each piece behaves:

1. **Required sleep ends the turn first** (`endAgentTurnForRequiredSleep`). It reads ProjectData
   state. If a turn is working, it calls `cancelAgentSessionOnNode` (skipped for a sleeping Instant
   container) and then `recordSessionTurnEnd` (`cancelled`, observedAt captured before the call),
   on success or 409. If the VM call fails, it throws, which counts as an ordinary failure toward
   the fallback budget.
2. **Required gate.** The turn has ended (activity is not `prompting` or `recovering`); harness
   leases and the idle interval are ignored. The mid-capture abort check only aborts when a NEW turn
   starts.
3. **Sweep eligibility.** `required` is eligible. `deadline` uses policy `prompt-turn-ended`.
4. **Fallback in required mode.** It still attempts the VM cancel, then records the turn end
   regardless of the VM's answer, and tears down. The chat stays wakeable through the existing
   fallback marking.
5. **Lifetime sweep.** A node past the absolute ceiling with active workspaces always enters
   `prepareAbsoluteLifetimeRelease`, even with recent activity. That is option (a).
6. **Stranded-chat fix.** When the sweep retires a dead intent whose workspace is `deleted`, and no
   live workspace serves the chat, it closes the ProjectData session through `stopSession`. That is
   the same outcome node deletion gives any workspace it did not preserve. Stopped and errored
   workspaces keep today's behaviour, because they can be restarted.

## Checklist

- [x] `session-sleep-requirement.ts`: `resolveSleepRequirement` plus the admin setting
      `operations.nodeLifetimeForceSleepAfterMs` (definition, name union, docs)
- [x] `endAgentTurnForRequiredSleep` (`cancelAgentSessionOnNode` and `recordSessionTurnEnd`; 404 and
      409 mean no turn; skips sleeping containers)
- [x] Gate and abort check take the requirement: `sleepTeardownSafetyGate`, `sleepStateChanged`,
      `completeSleepTeardown`, `verifyAndBeginSleepTeardown`
- [x] `sleepWorkspaceSession` resolves the requirement and ends the turn after the claim, before verify/capture
- [x] Sweep eligibility (`checkAutomaticSessionSleepEligibility`) honours deadline and required
- [x] Fallback honours required (forces the turn end, skips the activity gate)
- [x] `sweepMaxLifetimeNodes`: past the absolute ceiling, active workspaces are not exempt
- [x] Stranded-chat convergence for a deleted workspace, closed BEFORE the intent is retired so a
      failed close is retried; any non-deleted sibling workspace keeps the chat
- [x] Tests: explicit Sleep on a prompting agent (VM success, 404, failure); lifetime deadline vs
      required; fallback required; stranded convergence with live and stopped sibling controls; a
      cf-container sleeping skip; discrimination for each guard
- [x] Docs: the sleep behaviour pages, the admin settings page, the API reference (explicit sleep)

### Adversarial review round 1 (all addressed)

- [x] H1: `/cancel` restarts the agent, which reports `recovering`, and that aborted the required
      gate. First fixed by switching to `/stop` (42126e1a0); round 2 found `/stop` leaves the VM
      session permanently stopped, so a sleep that then failed stranded the chat. Final: keep
      `/cancel` (kill, idle restart, chat usable on failure) and let the required gate count only
      `prompting` as a turn (`classifyRequiredSleepTurn`); `sleepStateChanged` adds nothing for
      required sleeps.
- [x] H2: a person's Sleep was required only for its first attempt. Migration 0217 adds
      `session_snapshots.sleep_required_episode_started_at`; required while equal to
      `sleep_episode_started_at`, so every episode-ending writer clears it for free.
- [x] H3: nodes past their lifetime still took placements. `node-lifetime-admission.ts`: no new
      placement in the last `operations.nodeLifetimeAdmissionCutoffPercent` (default 10) of the
      lifetime, enforced in the final reservation (insert and attach; restart exempt) and as a hint
      in the task runner's candidate queries. `PlacementAdmissionPolicy` makes the compiler
      enumerate every new-placement path.
- [x] M3 close before retire; M5 404 is no turn; L1 widen serving statuses to "not deleted";
      L2 lifetime notice text; L3 explicit sleep documented in the API reference; L4 test no longer
      swallows its failure.

### Adversarial review round 2

- [x] HIGH `/stop` strands the chat when the sleep fails: reverted to `/cancel` (see H1).
- [ ] MEDIUM persisted warm claim skips the cutoff and can loop
- [ ] MEDIUM trial orchestrator candidate query ignores the cutoff and can hot-loop
- [ ] MEDIUM a close that keeps failing stalls retirement and the failed-task release
- [ ] LOW preferred/explicit node refusals do not name the cutoff
- [x] LOW `/stop` slow under lock: gone with the revert
- [ ] LOW marker never cleared, only made stale (timestamp collision, speculative)
- [x] Cloudflare HIGH bind-limit test with the cutoff on; MEDIUM `nodes.created_at` index (pre-existing,
      bounded by `user_id`/`id`), noted
- [x] Selection records the cutoff as a named, non-deferrable rejection (rule 74)

- [x] M4 (finalize `stopping` snapshots as sleeping on deletion): deferred to
      `tasks/backlog/2026-11-03-finalize-stopping-snapshot-on-workspace-deletion.md`.
- Rule 18 splits: `workspace-admission-sql.ts`, `node-selection-shared.ts`, `warm-node-claim.ts`,
  `session-sleep-workspace.ts`.

## Acceptance Criteria

- [ ] Pressing Sleep on a session whose agent is stuck `prompting` stops the agent and sleeps it,
      leaving the chat wakeable
- [ ] A workspace on a node past 24 h sleeps as soon as its turn ends. Past 24 h plus 30 min it is
      force-stopped and slept, whether the turn is hung or active
- [ ] If the VM never confirms, the bounded fallback still tears the runtime down, and the chat
      stays wakeable
- [ ] A deleted workspace's retired sleep intent never leaves its chat `active` with no runtime
- [ ] Idle sleep for normal nodes is unchanged (controls)
- [ ] A person's Sleep that failed stays required through the sweep's and fallback's retries
- [ ] A node in the last 10% of its lifetime takes no new workspace; restarts and nodes the lifetime
      sweep never reaps are unaffected
- [ ] Verified on staging: explicit Sleep on a prompting session
