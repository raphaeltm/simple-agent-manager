# External MCP: readable transcripts, schedules, channels, team evidence, human-input visibility

SAM task `01M5SKY95H590EWADCMP505NEW`; idea `01M5PRH5C9ZBZ1C21AYQ8QWMC5`. Branch
`sam/implement-ship-all-existing-505new`. The user explicitly authorized skipping staging for
this task; verification is local tests + CI + review + production read-only/owned-fixture checks.

## Problem

The user-level Connector (`/connect/mcp`, shared operations registry) is used to coordinate
agents from ChatGPT/Claude. Observed friction (Oct 24 hackathon session):

1. `sam_chat_read` returns trailing fragments of streamed replies; role filters can return empty
   pages; search returns one-word snippets.
2. No external schedule lifecycle, so "is it scheduled?" needs an internal agent's receipt.
3. No external channel/coordination reads; team readiness had to be reconstructed from chats.
4. No single team progress/evidence/usage view.
5. Questions agents raise with `request_human_input` are invisible in per-chat Connector reads.

## Research findings (code audit, 2026-10-25, base `d41ff95d6`)

### 1. Transcripts

- `operations/chat-core.ts:readChat` pages **stored rows** (one row per streamed chunk, written by
  `vm-agent/internal/acp/message_extract.go`), groups only within the page, and filters roles
  after grouping. Pages cut replies (`partialBefore`) and role filters can empty a page.
- Keyword search fallback (`project-data/message-search.ts`) matches raw chunk rows, so
  `extractSnippet` returns the chunk ("audit"). FTS hits use grouped rows (full message).
- Reusable: `project-data/message-context.ts` already reads whole runs (displayed messages) across
  pages inside the DO for both root and archive owners; `MERGED_MESSAGE_ROLES` + tool runs define
  message boundaries; message cursors `[createdAt, sequence, id]` are exact positions.
- `services/task-final-assistant-message.ts` (used by `sam_task_get` and `/sam`
  `get_task_details`) reads at most `MCP_MESSAGE_LIST_MAX` raw rows and can return a partial reply.
- Consumers of `sam_chat_read`: Connector, `/sam` operator (allowlisted), and the workspace-agent
  path (`via === 'workspace-agent'`), which must keep its behavior.

### 2. Schedules

- One-off schedules exist in ProjectData (`project-event-schedules-*.ts`): `message_session` /
  `start_session` actions, UTC `dueAt` + `displayTimezone`, `expiresAt`, idempotency per
  (project, creator, key), version CAS for reschedule/cancel, execution receipts.
  Services: `createProjectSchedule`, `getProjectSchedule`, `listProjectSchedules`,
  `mutateProjectSchedule` (`services/project-data.ts`); error mapping `rethrowScheduleError`
  (`routes/project-schedules.ts`). REST requires `task:read`/`task:write`.
- No server-side DST conversion (web does it in `apps/web/src/pages/automation/time.ts`).
- Recurring = cron triggers (D1 `triggers`), created by `services/trigger-create.ts:createTrigger`;
  pause/resume logic is inline in `routes/triggers/crud.ts` PATCH.
- Connector start budgets (`starts_hour`/`starts_day`) apply only to `sam_chat_start`.

### 3. Channels

- Humans can read channels via REST (`routes/project-event-channels.ts`, `task:read`):
  `listProjectEventChannels`, `getProjectEventChannelHistory`. Subscriber list is agent-only MCP.
  `agent-dm.*` history is project-visible; the web hides it client-side.
- Publishing/following require an agent actor (`requireChannelActorAuthority`); no human path.
- Roster sources: `tasks.coordination_channel` (unindexed), subscribers, history publishers.
- Subscription cancel exists for humans via REST (`routes/project-event-subscriptions.ts`).

### 4. Team view

- No descendant query/index over `tasks.parent_task_id`; retries/forks also set it
  (`triggered_by` distinguishes: `mcp` = subtask).
- Batched sources: `getSessionsByTaskIds` (ProjectData), `pull_requests` (+checks, webhook-fed),
  `agent_sessions.agent_provider_mode`, `compute_usage`, `credential_limit_windows`.
- Per-task/per-session harness token usage and cost are **not persisted**; deployed SHA is not
  stored. Subscription quota is per credential (`credential_limit_windows`).

### 5. Human input / attention

- `request_human_input` writes a ProjectData attention marker (`needs_input`,
  `source: 'request_human_input'`) + Notification DO row; it never touches InteractionStore.
- `sam_chat_read.pendingInteractions`, `sam_chat_interactions`, `sam_work_changes` read only
  InteractionStore → questions invisible. `getSession` already returns attention; `readChat` drops it.
- `sam_inbox_get` reads D1 `session_summaries.attention_json` for the 5 most recently updated
  sessions; marker creation does not bump `chat_sessions.updated_at`/schedule summary sync, so the
  D1 copy lags; `getAttentionSummary` returns the newest marker of any kind (a `wake_failed` hides a
  question). Inbox notifications omit `attentionMarkerId`/options. Notification dedup path keeps the
  old marker's metadata.

## Implementation checklist

### Shared
- [x] D1 migration 0208: partial indexes on `tasks.parent_task_id` and
      `(project_id, coordination_channel)`; schema.ts mirrors them
- [x] Admin settings `connector.transcript*`, `connector.search*`, `connector.team*`,
      `connector.channel*` (`services/connector-read-settings.ts`)
- [ ] Registry wiring, `CONNECTOR_INSTRUCTIONS`, catalog tests, receipts (`sam_operation_get`)

### 1. Transcripts
- [x] DO: `logical-transcript-model.ts`, `logical-transcript.ts`, `logical-message.ts`; reader
      factories exported from `message-context.ts`; RPC + service wrappers
- [ ] `sam_chat_read` default `unit: 'messages'` (logical), `unit: 'rows'` keeps legacy paging;
      `latest` user/assistant on first page; coverage disclosure; workspace-agent path unchanged
- [ ] `sam_chat_message_get` (full text by offset; thinking only on request; tool runs summarized)
- [ ] `sam_chats_search` excerpts from whole messages for the top results
- [ ] `getLatestAssistantMessageForTask` uses the logical reader (complete latest reply)
- [ ] Tests: DO reader against real SQLite (page boundaries, ties, role filter, budgets, legacy
      cursor, archive target), operation tests, no duplicate/missing chunks across pages

### 2. Schedules
- [ ] `sam_schedules_list`, `sam_schedule_get`, `sam_schedule_create`, `sam_schedule_update`,
      `sam_schedule_cancel` over the existing services; recurring via cron triggers
- [ ] Timezone-local input → UTC with DST gap/overlap handling; tests for both transitions
- [ ] Idempotent create (receipt + DO idempotency key), duplicate tests; start budget applies
- [ ] Extract trigger status update into a shared service used by REST PATCH and the operation
- [ ] Distinguish accepted / admitted / execution receipt / task outcome / notification

### 3. Channels
- [ ] `sam_channels_list`, `sam_channel_history`, `sam_channel_get` (roster + subscribers),
      `sam_channel_subscription_cancel` (caller-writable owner chats only)
- [ ] Human channel post: requires a new human actor for channel events (new trust boundary) —
      report for decision per policy 1b930820(c) instead of building silently

### 4. Team
- [ ] `sam_team_status` (root task / chat / channel scope): bounded lineage, state + freshness,
      blockers/attention, PR/CI, evidence (agent-claimed vs control-plane), measured usage with
      explicit unknowns, cap disclosure

### 5. Attention
- [ ] Shared pending-attention projection; `sam_chat_read`, `sam_chat_interactions`,
      `sam_work_changes` include it (writer-gated)
- [ ] Inbox: sessions with attention selected before the recency cap; notifications carry
      `attentionMarkerId`/options/category
- [ ] DO: marker create/resolve refresh the D1 summary; summary prefers answerable questions
- [ ] Notification dedup keeps metadata of the newest marker

### Docs
- [ ] `apps/www/.../guides/sam-connector.md`, `guides/admin-settings.md`,
      `.claude/skills/api-reference/SKILL.md` (connector section)

## Acceptance criteria

- [ ] Latest full reply and preceding user request available from one `sam_chat_read` call
- [ ] Paging a long streamed reply returns each chunk exactly once, never mid-message (legacy
      mid-message cursors are flagged)
- [ ] Role-filter paging semantics documented and tested (bounded scan, disclosed)
- [ ] Search results include message-level excerpts and stable message IDs
- [ ] Schedule create is idempotent, DST-correct and returns distinct acceptance/execution states
- [ ] Channel list/history/roster readable with cursors and bounded size; no blanket peer authority
- [ ] Team view joins tasks/descendants/state/blockers/PR/evidence/usage with sources, timestamps
      and explicit unknowns; no fake cost/quota
- [ ] A `request_human_input` question appears in `sam_chat_read`, `sam_chat_interactions` and
      `sam_inbox_get`; answering still requires explicit confirmation
- [ ] Existing tools keep working; read-only connections see no write tools
- [ ] CI green, review addressed, merged, production deploy verified with safe reads

## References

- Prior work: idea `01M5C4RT0SS8DZ5P44QWXS58C7`, PR #2387 (operational tools)
- Rules: 02, 11, 28, 50, 57, 60, 62, 65, 67; scoped API rules 47, 51, 63
