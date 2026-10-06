# Task status `sleeping` (#2230) is missing from the "active" status sets

## Problem

PR #2230 (merged 2026-10-04 23:37Z as `ee80b0ee0`, deployed by run 37245799681 at 2026-10-05
00:00Z) added the task status `sleeping`. VM sleep teardown now writes it
(`apps/api/src/services/session-sleep-teardown.ts:214-230`; the task update is new in #2230).
Before #2230, teardown left the task status alone, so a slept VM conversation kept its earlier
status. Several consumers enumerate "active" statuses and were not updated, so slept VM tasks
now fall through them. Found by the 2026-10-05 weekly queue reconciliation
(`tasks/archive/2026-10-05-weekly-queue-reconciliation.md`).

1. **Hidden from the active lists (verified in code).** `listAgentActivityTasks({ activeOnly: true })`
   filters on `AGENT_ACTIVITY_ACTIVE_TASK_STATUSES`, which is `queued`, `delegated` and
   `in_progress` (`apps/api/src/services/agent-activity.ts:16-20`, condition at `:178-182`). Its
   callers are the dashboard's Active Tasks (`apps/api/src/routes/dashboard.ts:74`), the MCP tool
   `list_project_agents` (`apps/api/src/routes/mcp/workspace-tools-direct.ts:47`) and the account
   map's active view (`apps/api/src/routes/account-map.ts:155`). Slept VM conversations disappear
   from all three. The dashboard card's "Sleeping" indicator
   (`apps/web/src/components/ActiveTaskCard.tsx:46`) can now only show for Instant rows. At
   2026-10-05 05:15Z, production D1 held 2 tasks in `sleeping`.
2. **No agent can message a slept VM agent, and parents cannot stop a slept child (verified in
   code).** MCP `resolveAgentTarget` refuses any target whose status is not in `ACTIVE_STATUSES`, which is
   `queued`, `in_progress`, `delegated` and `awaiting_followup`
   (`apps/api/src/routes/mcp/_helpers.ts:322`, check at
   `apps/api/src/routes/mcp/orchestration-comms.ts:146`). It is used by `send_message_to_subtask`
   and `stop_subtask` (`orchestration-comms.ts:253,449`), and `send_durable_message` applies the
   same check (`apps/api/src/routes/mcp/mailbox-tools.ts:378`), so no agent in the project can
   message a slept VM agent. `sleeping → cancelled` is an allowed transition
   (`apps/api/src/services/task-status.ts:37`), so the stop refusal is not intended.
3. **A slept VM chat likely renders as provisioning (code reading, not reproduced).** The project
   chat restore effect calls `setProvisioning` for every non-terminal status other than
   `in_progress` (`apps/web/src/pages/project-chat/useProjectChatState.ts:536`), and `isTerminal`
   does not list `sleeping` (`apps/web/src/pages/project-chat/types.ts:71-73`). Teardown also nulls
   `executionStep`. Opening a slept VM conversation therefore probably shows the provisioning
   indicator, sets `isProvisioning` (which suppresses auto-resume,
   `apps/web/src/components/project-message-view/useConnectionRecovery.ts:269`), and polls the task
   every 2 s while the chat is open (`useProjectChatState.ts:463-470`). The same effect is behind
   `2026-08-04-instant-persistence-step-renders-as-provisioning-vm.md` and
   `2026-09-09-chat-requests-reaped-task-404.md`.
4. **No status event for the transition (verified in code).** The write to `sleeping` records no
   `task_status_events` row, while the wake back to `queued` does
   (`apps/api/src/services/session-recovery.ts:151`). This widens the open gap in
   `2026-02-27-tdf-1-task-state-machine.md`.

Related, tracked elsewhere:

- A failed VM wake now writes `failed` on the conversation's own task
  (`apps/api/src/durable-objects/task-runner/state-machine.ts:305`) and fires the parent's
  task-wait hooks (`:351-365`); before #2230 only a recovery row failed. From code reading. SAM
  idea `01M3MFDMZ5AS0BXPHZWS3CRFED` and `2026-09-25-stopping-sleep-with-failed-projectdata-session.md`.
- A `sleeping` task has no terminal exit after the 7-day snapshot purge: item (3) of
  `2026-09-26-trustworthy-task-status.md`.
- SessionHeader gives `sleeping` the undefined fallback style of `cancelled`: item #10 of
  `2026-04-24-session-header-a11y-token-fixes.md`.

## Implementation checklist

- [x] List every consumer that enumerates task statuses as "active", "live" or "non-terminal"
      (API, MCP, web, scheduled sweeps) and decide per consumer whether `sleeping` belongs. Prefer
      one shared constant over patching each list.
- [x] Dashboard Active Tasks, `list_project_agents` and the account map include slept VM
      conversations, with the Sleeping indicator.
- [x] `send_message_to_subtask` and `send_durable_message` to a slept VM agent are accepted and
      delivered through the durable wake path (or refused with an explicit, documented reason);
      `stop_subtask` cancels a slept child.
- [x] Opening a slept VM conversation renders the sleeping state, not provisioning, and does not
      start the 2 s task poll.
- [x] The transition to `sleeping` writes a `task_status_events` row.

## Acceptance criteria

- [x] Each fix has a test that reaches it the way production does: put a VM task to sleep through
      the real teardown path, then call the real route or tool (`.claude/rules/62`). Do not
      hand-write `status='sleeping'` as the only setup.
- [x] Each test has a control proving the same consumer still excludes terminal tasks.
- [x] A behavioral web test covers the chat restore effect with a `sleeping` task.

## Reconciliation and implementation notes (2026-10-05)

- Main starts at `0366b17d9`; #2230 stable identity and #2231 provisioning restore fix already shipped. Existing task used, managed branch/workspace reused.
- Consumers audited: sleeping belongs in activity visibility and messaging/parent stop targets, and production status rendering. Dormant project task filters are excluded after browser routing audit. It stays excluded from live callers, execution admission/dispatch slots, stuck task sweeps, runtime-preservation and warm-placement predicates. Separate `AGENT_TARGET_STATUSES` avoids broadening `_helpers.ACTIVE_STATUSES` action triggers.
- Sleep events use an insert-select of current status in the same D1 transaction before updating sleeping; already sleeping and terminal rows produce no event.
- Shared staging coordinator: resource-history task `01M473KNZ9WXZ0X4G3Z743X2C1` by parent assignment; this task does not deploy or provision independently; capacity `01M473KXWJYT6S1JR03E8GVY2B`, telemetry `01M473KNZ9WXZ0X4G3Z743X2C1`. Pin heads together, max 1–2 VMs and immediate cleanup. No independent deployments over sibling validation.
- Failed-wake mismatch remains separate in SAM Idea `01M3MFDMZ5AS0BXPHZWS3CRFED`; audit added there. Stable task can fail/fire parent hooks while restoration returns chat to sleeping; finalizer can subsequently fail the preserved chat. Code evidence only; no legacy recovery migration.

## Local validation

- New real-SQLite teardown-to-consumer suite: 16 tests pass, including terminal tasks, active missing/deleted-node controls, sleeping callers, same-project peers, cross-project targets, direct parent/current membership, disabled delivery, atomic rollback and idempotent status events.
- Pre-fix API mutation: 8 regression failures / 6 controls passing; exact current production files restored, final suite green.
- Six existing sleep/MCP/activity regression suites: 92 tests pass with one worker. API typecheck and targeted ESLint pass. Initial concurrent run timed out under memory pressure; fixtures now include the existing task event table.
- Provisioning restore behavior is already shipped in #2231; existing sleeping-session-audit.spec.ts supplies behavioral coverage. No app UI edits: ProjectTasks status filters are dormant behind /tasks → /ideas redirect; actual Ideas view intentionally lists drafts and existing executing mapping includes sleeping.
- Messaging tests validate real consumer gates and durable acceptance contract. Actual durable alarm/wake and VM final-flush require the coordinated staging run; not claimed by the boundary mocks.
- Independent Cloudflare/security/constitution/doc review PASS; full quality and staging still pending.

- Completion-validator local implementation PASS. Added explicit terminal-event controls; lifecycle suite 11/11 green.
- Existing #2231 sleeping-session Playwright audit 4/4 green on built preview; idle and waking at 375×667 and 1280×800. All screenshots visually reviewed, no overflow or duplicate provisioning block; UI rubric 4/4/4/4/5. Local servers stopped. No UI diff retained.

- Full repository lint: 13/13 tasks PASS; full repository typecheck: 19/19 tasks PASS. Full test/build remains running with one worker/task.
- The failed-task-preservation realistic fixture also declares taskStatusEvents; its 21 regression tests pass. This is test setup only, runtime candidate remains reviewed `7041c6a4d`.

- Full root test:20/21 tasks PASS; API816/817 filesPASS with8 failures confined to old mocked session-sleep fixture missing db.insert. Corrected that fixture to model event insert-select without consuming workspace query responses; all43 tests pass on targeted rerun. Full API11387 passing tests plus targeted43/43 after correction; whole suite was not rerun yet. Runtime source unchanged.

- Sonar reported205 copied fixture lines. Extracted shared SQLite/boundary fixture used by consumer and lifecycle suites;27/27 targetedPASS, eslint/format/diffPASS. Independent API reviewer confirms flattened else-if is behaviorally equivalent, preserving all predicates and D1 batch order. No new admission/telemetry scope.


## Coordinated live verification (2026-10-06)

- Full serial repository rerun passed 21/21 tasks: API 817 files / 11,395 tests; web 336 files / 4,023 tests. Full build, lint and typecheck passed. PR #2240 CI and Sonar passed.
- Coordinator deployed integration `2613b82d02afe0c10a229b236055adcb979085c7`; replacement VM reported reviewed Go `4f83d6a7287c4c34fff480dc78cf9cac269840aa` with real healthy heartbeats. Live sleeping dashboard/activity/account-map visibility and reviewed mobile/desktop screenshots passed.
- Real child `01M47BRJVHCQHKTFHSNYA8TEDY` slept at 01:05:25 UTC, with available snapshot and one status event. Parent handoff message `01M47BYWX4W9H26KPDSJTBENVB` accepted at 01:06:30 recovered the same task on the same VM. Assistant replied `HANDOFF_WAKE_OK` at 01:12:28.984 and returned to idle. Durable ledger confirmed acked delivery, runtime receipt support and no final error. Recovery creates workspace `01M47C7AHNC0N40N8HKQ16K1WF`; stream sequence restarts, so reply chunks were verified by creation time.
- Draft hold: durable-mailbox wake, sleeping parent cancellation and terminal refusal remain unexecuted. Released all fixture writes to resource-history coordinator at 01:12:30 to preserve telemetry and 01:20 cleanup deadline. No gate waiver, independent deployment, extra VM, manual resume or repeated accepted message. Capacity owns final runtime/node/provider cleanup after coordinator release; retain history and snapshots under existing expiry.

- Cleanup correction: the initial 01:18:32 zero-state report was not final. The parent identified a cancelled capacity control provisioning an orphan VM through a stale runner/admission race. Last error-row deletion at 01:31:26 exceeded the original 01:20 deadline; qualified five charged cx23 hours (€0.044) remained within the original €0.10 cap. Capacity readiness is reopened and owns the fix/regression/fence review. All staging remains held until no-retry/source-stopped evidence and immediate global live/reservation/deployment checks; the assigned separate visibility slot is unreleased. No new spend, reset, production repair or deployment is authorized by that audit message.

## Follow-up live gates and final cleanup (2026-10-06)

The parent assigned a separate one-cx23 window under the resource-history coordinator, retaining the original **02:04 UTC cleanup deadline**, €0.03 cap, API integration `2613b82d02afe0c10a229b236055adcb979085c7` and Go `4f83d6a7287c4c34fff480dc78cf9cac269840aa`. No redeploy, pool policy mutation, D1 write, reset or additional host. Immediate deployment/live-use checks preceded provisioning; the historical node-less September stopping workspace was not a live VM.

- Fresh project `01M47DRHT0A0GBK2776BGK873P`, parent `01M47DS8WR3QE2RY42RMBAWZJC`, child `01M47E4QQQCAYZWTZ6ZQ5TBZVH`; one node `01M47DSFMW3EE9AVNAHTR9VMTB`, provider VM `168945770`. Child used the normal submit API with its actual parent and explicit node pin; that path refuses an unavailable/full preferred node rather than allocating another host. Real parent MCP credentials performed the messaging/cancellation checks.
- Real process start `01:39:50.413065217 UTC` from the agent journal; first heartbeat `01:40:50.721 UTC`, first observed at `01:40:53.782`. Exact reviewed Go version; approximately 60.3 seconds from process start. Coordinator independently confirmed the Cloudflare HTTP 200 heartbeat at `01:40:51.072` (<120 seconds).
- First sleep completed `01:46:26.689`. Durable mailbox message `01M47E8XAB71NZZN4917HK3JKD` was accepted once at `01:46:55.760`. The existing `workspace_deletion_unconfirmed` fence waited for normal runtime cleanup; no forced resume, TTL change or repeated message. Wake claimed `01:51:36.713` and recovered the same task/session/parent on the same host into workspace `01M47EHK2HVRRK6MQFENBKWRH3`.
- **Mailbox wake PASS:** actual assistant reply `DURABLE_WAKE_OK` at `01:53:01.453`, canonical idle at `01:53:01.600`, runtime work inactive/0. Ledger acknowledged/delivered at `01:52:58.527`, accepted by runtime at `01:52:58.532`, protocol 1/receipt supported/no final error.
- **Sleeping parent cancellation PASS:** second sleep event `01M47EP1CSZT6D066ADDTFTAWN` at `01:54:05.849`, available/nondegraded snapshot; actual direct parent's `stop_subtask` produced `sleeping → cancelled` event `01M47EPFYBWF41H08C6FPKNFWJ` at `01:54:20.747`, actor agent, and returned `stopped: true`.
- **Terminal refusal PASS:** subsequent `send_durable_message` at `01:54:38.605` returned JSON-RPC `-32602`, explicitly refusing the cancelled target.
- **Normal cleanup PASS before 02:04:** parent cancellation HTTP 200, task cancelled at `01:55:12.851`; strict node deletion HTTP 200/success at `01:55:34.483`. Retained workspace metadata records `node_runtime_terminated` at `01:55:32.636`. Final read at `01:58:00.982` (146.499 seconds after deletion) found the owned node absent, global live nodes zero, owned active reservations/admissions zero, and both tasks unchanged/cancelled with no execution step. No late allocation appeared in this observation interval. This is qualified strict normal-API/provider-boundary proof, not a direct provider inventory assertion.
- Pool maximum remained 3 throughout. Two available/nondegraded snapshots retain normal expiry (parent `2026-10-13T01:44:07.561Z`, child `2026-10-13T01:54:06.015Z`); project/history remain. Five unrelated historical September admission rows retain a provisioning label, so raw global admission-table zero is not claimed. The earlier slot's late orphan/deadline correction remains valid; this successful follow-up supersedes only the earlier unexecuted visibility gates.
- Independent final completion audit: implementation and live acceptance PASS, all planned findings implemented or explicitly deferred; no sibling ownership changes. CI `37400056377` initially failed downloading Gitleaks with GitHub HTTP 500 before scanning; one failed-job rerun completed SUCCESS. CodeRabbit/normal merge/deployment gates remain pending.
