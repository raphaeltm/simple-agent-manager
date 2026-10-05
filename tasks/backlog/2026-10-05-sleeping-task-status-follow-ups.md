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

- [ ] List every consumer that enumerates task statuses as "active", "live" or "non-terminal"
      (API, MCP, web, scheduled sweeps) and decide per consumer whether `sleeping` belongs. Prefer
      one shared constant over patching each list.
- [ ] Dashboard Active Tasks, `list_project_agents` and the account map include slept VM
      conversations, with the Sleeping indicator.
- [ ] `send_message_to_subtask` and `send_durable_message` to a slept VM agent are accepted and
      delivered through the durable wake path (or refused with an explicit, documented reason);
      `stop_subtask` cancels a slept child.
- [ ] Opening a slept VM conversation renders the sleeping state, not provisioning, and does not
      start the 2 s task poll.
- [ ] The transition to `sleeping` writes a `task_status_events` row.

## Acceptance criteria

- [ ] Each fix has a test that reaches it the way production does: put a VM task to sleep through
      the real teardown path, then call the real route or tool (`.claude/rules/62`). Do not
      hand-write `status='sleeping'` as the only setup.
- [ ] Each test has a control proving the same consumer still excludes terminal tasks.
- [ ] A behavioral web test covers the chat restore effect with a `sleeping` task.
