# Task recovery liveness signals: audit and fix from production evidence

SAM task `01M42YQSYPGFSX8ADC3ZYMXJVY`. Parent `01M42WJSH7238RWH5ZH7TSSFZG`.
Siblings: bounded sleep fallback `01M42YPN0VJT93T8S9MMYV429Q`, callback renewal `01M42YQA8QPJQBW48KTDQFAHDE`.

## Problem

On 2026-10-04, nodes were fresh and healthy while three session snapshots kept failing. The stuck-task sweep logged
`Skipped stuck task recovery: VM agent heartbeat is recent (task running 1218/1417 min, hard timeout at 480 min)`.
The parent read this as "recovery is heartbeat-only and bypasses the 480-minute hard timeout". This task proves what
actually happened, fixes demonstrated defects and misleading diagnostics, and leaves sleep retry policy to the sibling.

## Scope and ownership

- Mine: `scheduled/stuck-tasks.ts`, `scheduled/stuck-task-ceiling.ts`, `services/task-runtime-liveness*.ts`, the
  ProjectData liveness adapter (`durable-objects/project-data/task-runtime-liveness.ts`), their diagnostics and docs.
- Sibling `01M42YPN0VJT93T8S9MMYV429Q`: snapshot retry policy, degraded fallback, `session-snapshot-sleep-predicate.ts`,
  `session-snapshot-sleep-failure.ts`, the sleep sweep. I do not edit those files.
- Canonical idleness (policy `0f05422d`): idle = prompt turn ended, no agent tool work in flight, agent idle. Child
  tasks and durable waits never pin compute. Runtime alive is not non-idleness.

## Research findings (production, read-only, `CF_PRODUCTION_DEBUGGING_TOKEN`)

### Branch reconstruction (code)

`recoverStuckTasks` → `in_progress` and `executionMs > TASK_RUN_MAX_EXECUTION_MS` (4h) →
`evaluateRunawayCostCeiling` (24h, aged from `workspaces.created_at`) → if `not_applicable` → `getTaskRuntimeLiveness`
→ `classifyTaskRuntimeLiveness`. A task is `live` only for:

1. `task_prompt_turn_active`: ProjectData `session_state.activity` is a working activity with fresh evidence.
2. `task_runtime_work_active`: a fresh harness work lease (tool or background work).
3. `task_acp_session_live`: the task's OWN ACP session (scoped to chat session, workspace and expected ACP id) is
   `assigned`/`running` with a heartbeat within `NODE_HEARTBEAT_STALE_SECONDS` (180 s).
4. `cf_container_active_work` (Instant only).

A node heartbeat alone is never sufficient; a stale node mirror needs a bounded health probe and still falls through
to task-scoped ACP evidence. So "heartbeat-only recovery" is FALSE.

`TASK_RUN_HARD_TIMEOUT_MS` (8h) has had NO behavioural effect since PR #1567 (2026-07-16) replaced the hard kill
with liveness gating plus the 24h absolute ceiling. Its only remaining uses are the misconfiguration warning, the
`threshold` label in the terminal reason, and the skip message text. Its shared-constant doc still says "tasks are
killed regardless of node heartbeat status".

### Production records

- `platform_errors` `stuck_task_heartbeat_skip`: 2,506 rows in 7 days, the largest named recovery type. One row per
  live task per 5-minute sweep (238 rows for task `01M40BHDSQYBG79VRAJGSH0056`). The persisted context has no
  liveness reason.
- 18 tasks were skipped in the last 4 days, up to 1,438 min. Workers Logs `stuck_task.do_completed_handoff_active`
  (which does record `livenessReason`) shows the basis was almost always `task_acp_session_live`:
  `01M40Q2V76CCC2MMKRS8Z3VPGV` (83d09155) 27/27; `01M40BHDSQYBG79VRAJGSH0056` (a06bcb69) 19 acp-live, 5 runtime-work,
  1 prompt-active.
- At the same time the sleep sweep ran 15 capture attempts each for a06bcb69 and 83d09155 (05:00 to 07:45Z,
  `session_sleep.snapshot_degraded_after_no_progress`). Every non-`stopping` sleep claim first passes
  `checkAutomaticSessionSleepEligibility` → `classifySessionIdleness`. So the sessions were IDLE (awaiting the user)
  while the sweep called them "live". The live verdict was process liveness, not work.
- Ceiling outcomes at 24h:
  - `01M3XWQ2CP8C6RQBWKQ1Z76C2G` (eac438f3) and `01M3XYQ7SQETYZFB0RPAYH5REE` (8bd71576) were failed by the ceiling.
    Their snapshots were `stopping` with an old `sleep_stopping_since`, so the in-flight arm did not match.
  - `01M3Z4CCZH5N22754V7CVVN9WR` (ebdc3d65) was NOT bounded. From 10-03 ~20:22Z to 10-04 07:37Z, every sweep logged
    `stuck_task.preserved_sleeping` source=ceiling sleepStatus=failed (136 events). `runtimeGenerationMs` reached
    126,924,760 (35.3h). Only the manual node deletion ended it.
  - Mechanism: the in-flight arm of `restorableOrInFlightSleepSnapshotPredicateSql` anchors `failed`/`scheduled`/
    `preparing` rows on `COALESCE(sleep_claimed_at, sleep_after, updated_at, created_at) > now - 30 min`. Every retry
    claim re-stamps that anchor. Degraded rows and rows with `capture_generation` are exempt from
    `SESSION_SLEEP_MAX_ATTEMPTS`. So the documented 30-minute bound never lapses during a retry loop (rule 53 §5b).
    From 07:17Z the captures also failed 401 (24h callback token expiry, sibling `01M42YQA8QPJQBW48KTDQFAHDE`).
- After the manual node deletion (07:39 to 07:42Z), four conversation tasks were failed with
  `Task runtime is no longer live after 480 minutes. Last liveness result: workspace_missing.`, although they had run
  1,228 to 1,434 minutes. "480 minutes" is the vestigial hard-timeout label, not an observed duration.
- `stuck_task.terminal_gate` withheld 244 verdicts in a week (21 sleeping conversation tasks, conversation fallback).
  Each withheld log repeats the same "after 480 minutes" text.
- Sibling-owned leftovers, reported to `01M42YPN0VJT93T8S9MMYV429Q`: snapshots of eac438f3 and 8bd71576 are still
  `sleep_status='stopping'` with deleted workspace and node, and `sleep_claimed_at` was re-stamped at
  2026-10-04T07:52:42Z (immortal sweep candidate).

### Verdicts on the questions asked

| Question | Verdict |
| --- | --- |
| Heartbeat-only recovery bug | Not a bug. Task-scoped ACP evidence is required; node heartbeat alone never preserves. |
| Fresh ACP status is stale activity | No. `task_acp_session_live` is a fresh process-liveness signal for the task's own agent. It is not work evidence, and the stuck-task question is death, not idleness. |
| Behaviour correct for live conversation work | Yes before 24h. Idle conversations awaiting the user must not be failed; releasing their compute belongs to sleep. |
| Logging misleading | Yes. Wrong signal named, true reason absent, a non-existent "hard timeout" cited, no idle/work distinction or ages, a durable row every 5 minutes, and terminal reasons that cite 480 minutes. |
| Absolute ceiling bypassed by snapshot preservation | Yes, demonstrated (ebdc3d65, 35.3h). Root cause is the unbounded sleep retry loop re-stamping the shared in-flight anchor (sibling-owned). |

## Implementation checklist

- [ ] Shared liveness evidence: ProjectData returns a prompt-free work-evidence snapshot (work state, activity label,
      timestamps) for the verdict's ACP session. The shared classifier attaches `evidence` (work state, last-activity
      age, ACP heartbeat age, runtime-work progress age) to live and ACP-level verdicts. Verdicts are unchanged.
- [ ] Both adapters (cron sweep and ProjectData idle cleanup) carry the evidence (rule 61). The ProjectData
      `runtime_preserved` log includes it.
- [ ] Rewrite the live-skip diagnostics in `stuck-tasks.ts`: true reason, work state, ages, and the real live-runtime
      bound (absolute ceiling on runtime-generation age). Keep the stable identifiers `stuck_task.skipped_active_heartbeat`
      and `stuck_task_heartbeat_skip` for query continuity.
- [ ] Persist the durable `stuck_task_heartbeat_skip` record once per task per liveness basis, not every sweep.
      Per-sweep detail stays in Workers Logs.
- [ ] Terminal reason uses the observed execution minutes and the liveness reason. It must keep
      `runtime is no longer live` for `failure-classification.ts` (Runtime lost).
- [ ] Remove the vestigial `TASK_RUN_HARD_TIMEOUT_MS` (constant, env type, misconfiguration warning, tests, docs).
- [ ] Ceiling visibility: when the ceiling defers to a sleep record, log the overrun, the sleep status and the arm.
      When the overrun exceeds `SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS`, no single in-flight episode can explain it, so
      warn and write one durable operator record.
- [ ] Ceiling enforcement for a retry-restamped in-flight sleep: agree with sibling `01M42YPN0VJT93T8S9MMYV429Q` who
      bounds it (expected: their episode budget bounds the shared in-flight arm). Record the agreed contract here.
- [ ] Fix stale docs: `DEFAULT_TASK_RUN_MAX_EXECUTION_MS` doc, `.env.example`, `configuration.md` hard-timeout prose,
      env-reference skill.
- [ ] Tests (real SQLite D1 through `recoverStuckTasks` where the sweep is involved):
  - [ ] healthy long prompt turn, tool/runtime work, and background finite work: preserved with the right reason
  - [ ] handed-back idle conversation: preserved, reported idle with last-activity age
  - [ ] stale ACP heartbeat with a healthy host: inconclusive, never terminal
  - [ ] dead runtime (workspace missing): terminal reason states real minutes and the cause
  - [ ] unknown or unreachable probe (DO timeout, node probe timeout): preserved
  - [ ] identity or generation mismatch: ACP or chat id mismatch stays inconclusive
  - [ ] durable child wait: a parent waiting on subtasks with an idle turn is not "working"
  - [ ] new activity race: a fresh prompt during a sweep is preserved
  - [ ] absolute ceiling: a busy live runtime past 24h is terminalized
  - [ ] preservation behaviour: the production re-stamped in-flight loop is reported as a ceiling overrun with its
        sleep blocker
  - [ ] persistence dedup: two sweeps write one durable record per basis; a basis change writes a second
  - [ ] logs and records contain no prompt or message content
- [ ] Rebase on and verify against the sibling snapshot fix if it lands first.

## Acceptance criteria

- A preserved live task's log and durable record name the true live reason (e.g. `task_acp_session_live`), its work
  state (`idle`, `prompt_turn_active`, `runtime_work_active` or `prompt_turn_unproven`), and the relevant ages.
- No log or record claims a "hard timeout" that does not apply. The real bound (absolute ceiling on runtime-generation
  age) is stated.
- A conclusive runtime death records the observed execution minutes and the liveness reason, and still classifies as
  `runtime-lost`.
- Durable heartbeat-skip rows drop from one per sweep to one per task per liveness basis.
- A ceiling deferral that outlives any single in-flight sleep episode is visible at warn level with one durable record.
- No preserve/terminalize decision changes except as agreed with the sibling for the ceiling bypass.
- No prompts, message content, tokens or URLs in any new log or record.

## Staging

User waived staging for this wave (knowledge `SleepWakePerformance` 2026-10-04 and the task brief). This change is
diagnostics plus a removed dead knob, exercised by a 5-minute cron that needs long-lived VMs to observe. Deterministic
sweep tests with injected clocks replace staging. Production verification follows the deploy via Workers Logs.

## References

- `.claude/rules/53` (§5, §5b), `.claude/rules/57`, `.claude/rules/58`, `.claude/rules/47`, `.claude/rules/62`,
  `.claude/rules/74`, `.claude/rules/61`
- PR #1567 (hard timeout replaced), PR #2079 (ceiling sleep gate), PR #2218 (snapshot completeness)
- Evidence scratch: `.tmp/liveness-audit/` (not committed)
