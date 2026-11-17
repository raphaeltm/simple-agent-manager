# Insights slice R: the Run receipt

SAM task `01M7HTTR355XNCSH4QBV7V72ZE`, build spec idea `01M7HTS38KX2G78JD0ESAGMKKH`,
channel `feature.insights`, coordinator task `01M7H0X3PMHK6WT29B1BSSCGWW`.
Branch `sam/build-insights-slice-r-7v72ze`. Authorized through production by Raphaël on 2026-11-16.

## Problem

After a task-backed chat runs, nobody can see where its time went, what it produced, which
account it ran on, what it used, or what slowed it down, without digging through D1. The
prototype (Library `/product/analytics/analytics-prototypes.html`, `?s=receipt`) shows a
"Receipt" tab in the chat side panel: a phases bar, stat tiles, a CPU line with tool-call
markers, and a "What slowed it down" list.

## Research findings

- Shared-operation pattern: `packages/operations/src/project-overview.ts` + thin REST adapter
  `apps/api/src/routes/project-overview.ts` (Inbox F1). Catalog registration (`registry.ts`
  `operations`) exposes read ops to the SAM Connector automatically
  (`apps/api/src/routes/connector-mcp.ts` loops the catalog). Slice I adds the sam-mcp tool.
- Phases sources:
  - `tasks.created_at`, `task_status_events` (queued/delegated/in_progress transitions,
    `idx_task_status_events_task_created_at`). Events table has no project_id: scope by joining
    `tasks` on `project_id`.
  - `workspaces.creating_started_at`, `build_started_at` (precise; machine ready → setup).
  - `lifecycle_state_episodes` has no project id and no entity_id index, and only samples
    watchdog states; the workspace timestamps already answer the same question exactly, so the
    receipt does not read it (documented, not a gap: slice T adds the purpose-built
    `lifecycle_phase_timings`).
  - Waiting on a person: ProjectData `session_attention_markers` kind `needs_input`
    (created_at → resolved_at, historical rows kept) plus D1 `asks` by `source_session_id`
    (`idx_asks_session_status`). Intervals are unioned so overlap counts once.
  - CI: `pull_request_checks.updated_at` is an ordering/completion time, no start time. CI phase =
    final head's last check result minus the agent's last message, when positive.
- Outcome: `task_pull_request_associations` (owned) + `tasks.output_pr_url` →
  `pull_requests` (state, merged_at, head_sha) → `pull_request_checks` on the final head.
  Older heads cannot be attributed to a PR (no PR number on check rows) and reruns overwrite the
  same `check_key`, so **CI first-try is not derivable**: shipped as "not recorded". Posted to the
  channel (event `d53712be`).
- Account: `agent_sessions.agent_credential_{source,scope,reference}`; the canonical session is
  `acp_sessions.chat_session_id` (DO). Account NAME only for the person who ran it
  (`routes/chat-agent-credential.ts` rule: members see the kind, never which account).
- Resources: `workspace_resource_summaries` by `(project_id, task_id)` index:
  `MAX(memory_peak_bytes)`, `MAX(cpu_peak_millis)`, `SUM(oom_count)`. Requested memory from
  `workspaces.resolved_reservation_json` via `parseStoredResolvedReservationJson`
  (`packages/scheduler-core`).
- CPU line: per-minute rollups already in D1 (`workspace_resource_chunks.rollup_json` with
  `cpuMaxCores` and `toolCallStarts`) served by the existing session timeline
  (`GET .../sessions/:sessionId/resource-history`, `apiResourceHistorySource`). The Receipt
  reuses that read for the line instead of duplicating the parser.
- Tool calls: `chat_messages.tool_metadata` JSON `{toolCallId, kind, status, toolName}` (ACP
  kinds). One bounded DO RPC aggregates in SQLite (`GROUP BY kind`, distinct toolCallId) over a
  row cap, so memory does not scale with the session (rule 69 memory ceiling).
- Web: rail actions in `session-tool-actions.ts`, overlay state in `useSessionOverlays.ts`,
  lazy drawers in `SessionMessageViewDialogs.tsx`, GlassSheet `mobile="full"` (Automation
  drawer is the template). `SessionMessageView.tsx` is at 499 lines (rule 18).
- Settings go in the admin settings registry (`INBOX_SETTINGS` pattern), not Worker vars
  (rule 07 runtime tunables).
- Slice T (phase timings) runs in parallel; R ships with workspace timestamps unless T merges
  first. T merged first (#2787). R kept its own comparison: T's provision rows carry no project,
  so they cannot give a usual machine wait; T has no history before its deploy; and its rows are
  sub-phases, which do not sum to a setup median. Posted on `feature.insights`. Follow-up: switch
  the setup comparison to T's per-phase stats once 30 days of rows exist.

## I/O budget (rule 60: receipt ≤ 8)

1 authorization (access port) · 1 settings (per-isolate cached) · 1 task query (task, workspace,
status events JSON, resource aggregates, asks JSON, agent-session JSON) · in parallel: 1 PR+checks
query, 1 DO RPC, 1 comparison (median) query · optional 1 account-name read (own session only).
Max 7.

## Implementation checklist

- [x] Shared types `RunReceipt*` in `packages/shared/src/types/insights-receipt.ts`, exported
- [x] DO module `packages/project-data/src/do/run-receipt-facts.ts`: tool-call counts by kind
      (bounded scan, distinct toolCallId), `needs_input` intervals, last agent message time,
      acp session id for the chat, all inside a time window; DO method + client wrapper + port
- [x] Settings definition `insights-receipt-settings-definition.ts` + registry entry in
      `admin-settings-features-definitions.ts`
- [x] `packages/operations/src/insights-receipt.ts` (`runReceipt`): auth, project-scoped SQL in
      every predicate, same not-found for missing and foreign tasks, per-row tolerant parsing,
      phases, outcome, account, resources, tool calls, slowed-down (≤3), tokens "not reported"
- [x] `sam_run_receipt` read operation registered in the catalog (`insightsOperations`)
- [x] REST route `GET /api/projects/:projectId/tasks/:taskId/receipt`
- [x] Tests: real SQL engine (`createSqliteD1`), foreign-project attack + owner control, missing
      task same not-found, malformed rows tolerated, phase math, slowed-down ranking, budget
- [x] DO facts test in workers pool (real DO SQLite)
- [x] Web: API client + `useRunReceipt` TanStack hook (identity-scoped key)
- [x] Web: `SessionReceiptDrawer` (GlassSheet, phone full sheet), phases segmented bar, stat
      tiles, CPU line + tool markers from the existing timeline query, slowed-down list
- [x] Web: rail action "Receipt" for task-backed chats; overlay state; lazy load
- [x] Web unit tests (rail action gating, drawer render states)
- [x] Playwright visual audit 375 + 1280 with normal/long/empty/error/many data
- [x] Docs: user-facing page in `apps/www/src/content/docs/docs/` for the Receipt
- [x] Staging verification on a real task-backed chat (PR #2786 comment 6916002524)

## Review-driven changes (Phase 5)

- Security (MEDIUM): ask titles follow the inbox's visibility (assignee / team claimant); waiting
  time still counts for everyone. Test with teammate vs assignee and owner control.
- Cloudflare (HIGH): comparison query indexed by migration 0252 (`idx_tasks_project_skill_created`,
  `idx_tasks_project_profile_created`), cap applied before event lookups; EXPLAIN QUERY PLAN test at
  3,001 tasks, proven red by dropping the index and by removing the `+project_id` asks hint.
- Cloudflare (MEDIUM): DO read is one pass bounded by messages read (setting renamed
  `insights.receiptMessageScanMaxRows`, default 10,000, max 100,000); status-event times via
  `julianday()` (mixed ISO / CURRENT_TIMESTAMP); asks newest-first; `since` bound is a date prefix.
- Validator/UI: one task-id expression for the rail and the drawer; waiting cap disclosed as `+`;
  route-level test; drawer read-state test; CPU loading/error states; retry feedback; PR link 44px
  with new-tab cue; CPU legend and run-anchored axis; light theme + scrolled mobile captures.
- `insights-receipt.ts` split: reads in `insights-receipt-reads.ts`.

## Acceptance criteria

- [x] `GET .../tasks/:taskId/receipt` returns phases, outcome, account, resources, tool calls,
      slowed-down, tokens `not_reported` for a real task
- [x] Foreign-project task and missing task return the same 404
- [x] A malformed row (status event / asks / resource summary / agent session JSON) degrades
      that field, not the receipt
- [x] ≤ 8 round trips, asserted in a test
- [x] Receipt tab appears only for task-backed chats; opens as a side panel on desktop and a
      full sheet on phone; stale-while-revalidate
- [x] Playwright audit at 375 and 1280 passes overflow checks
- [x] Staging: receipt opens on a real task-backed chat and shows real values with zero errors

## References

- `.claude/rules/60-request-io-and-bundle-budgets.md`, `11`, `28`, `50`, `17`, `48`, `62`
- Prototype screenshots: `.tmp/shots/proto-1280.png`, `.tmp/shots/proto-375.png`
