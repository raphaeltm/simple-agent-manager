# Inbox slice G: questions into `asks`

SAM task `01M7H9J27FET6DZ0SVNTD8AN6X`. Spec: idea `01M7G03ZCQ6TM6CMEYDRKQ8ST9` (decision 8: one record
per ask, in D1; slice G in section 6). Coordination channel `feature.inbox`. Authorized through
production on 2026-11-16. Builds on slice A (PR #2776, `b3c04e1d3`).

## Problem

A question an agent asks with `request_human_input` is a ProjectData attention marker today
(`session_attention_markers`, kind `needs_input`, source `request_human_input`), copied into D1
`session_summaries.attention_json` for the chat list and inbox. Decision 8 says every ask has one
record, in D1, with no copies. After this slice a new question is one `asks` row (kind `question`)
and nothing else: the row holds the ask, its status and its answer. Marker-era questions that
exist at deploy time stay answerable and archivable until they resolve or expire.

## Research findings

(Inventory of every reader and writer: see "Rule 44 inventory" below.)

- `request_human_input` (`apps/api/src/routes/mcp/human-input-tool.ts`) validates context
  (<= `MAX_HUMAN_INPUT_CONTEXT_LENGTH`), category, options; resolves the chat; creates a marker with
  `computeHumanInputSchedule(env)`; sends `notifyNeedsInput` (metadata `attentionMarkerId`) and links
  the notification to the marker; returns `{message, humanInputRequest:{id, sessionId},
  notificationScheduled}`. The chat card (`HumanInputCard`) loads the question by that id through
  `GET /api/projects/:p/sessions/:s/attention/:markerId`.
- Answer today: `answerAttention` (`routes/chat-attention.ts`): `authorizeAgentWake` (writer:
  owner or active grantee + wake policy) → DO claim (`prepareAttentionAnswer`, outcomes ready /
  in_flight / already_resolved / conflicting_answer / invalid_option / not_found) → live-agent
  prompt (`preparePromptForLiveAgent` + `sendPreparedPromptToLiveAgent`, dedup on marker id) →
  `completeAttentionAnswer`. Response `{resolved, alreadyResolved, answer}` or 202 `{inFlight}`.
  Archive (slice A) uses the same claim with an archive value.
- Expiry today (DO alarm, `attention-expiry.ts`): escalations at fractions of the window resend the
  linked push; at `expires_at` without a confirmed push delivery the marker is extended by the
  undelivered grace up to `max_expires_at`; at expiry the task is failed
  (`transitionToTerminal`), work preserved (`preserveFailedWorkOrSurfaceLoss`) or the session
  failed and the run released. Schedule from env `HUMAN_INPUT_*` (no GitHub Environment overrides
  in staging or production, checked 2026-11-16).
- A typed human chat message resolves every open marker of the chat
  (`message-persistence.ts:resolveAttentionForRoles`, `durability-foundation.ts` human prompt).
- Slice A gave `asks` a CAS writer (`closeAsk`), durable agent notices (`deliverInboxAskNotice`,
  prompt source kind `inbox_ask`, `notified_at` + 5-minute sweep retry) and an expiry sweep
  (`services/inbox/sweep.ts`). Durable prompt delivery wakes a sleeping chat (VM and Instant).
- The chat list reads attention from `session_summaries.attention_json` (D1 index,
  `services/session-summary-index.ts`) or the DO (`listSessions` → `getAttentionSummary`).
- Connector operations (`attention-core.ts:pendingAttention`) read open markers per chat for
  `sam_chat_read`, `sam_chat_interactions`, `sam_work_changes`; `sam_agent_answer` answers through
  `ports.chat.answerAttention`.
- The stalled-task classifier keeps a task alive while a question is pending
  (`hasPendingSessionHumanInput`).

## Design

- **Create.** `request_human_input` keeps its inputs and limits, files the question through the
  shared `createAsk` (kind `question`, blocking, assignee = the task owner, title = first sentence
  of the context capped at `inbox.titleMaxChars`, body = the full context, answer spec = options or
  text, category, source session/task/workspace, schedule) and sends the same notification, linked
  to the ask (`notification_id`). The tool result keeps its shape; `humanInputRequest.id` is the
  ask id.
- **Answer (one shared operation).** Compare-and-set `open` → `answered` with the answer, bound to
  project and chat; deliver through the durable prompt path (the wake path for sleeping chats) and
  record `notified_at`; the inbox sweep retries an answer whose delivery was not queued. Outcomes for
  the caller: accepted; already answered (same answer); conflicting answer; invalid option; still
  being delivered (claimed, `notified_at` NULL, same answer → 202 inFlight). Callers: the attention
  resolve route (chat card, notification deep link, `sam_agent_answer`) and the inbox answer route.
- **Typed chat message.** A human message in the chat closes the chat's open questions
  (`answered`, no answer text, `notified_at` set: the message itself reached the agent), as it
  resolves markers today.
- **Expiry and reminders** run from `asks` in the 5-minute inbox sweep with today's schedule
  (window, reminder fractions, undelivered grace, hard maximum), read from admin settings
  `inbox.question*`. At expiry the ask becomes `expired` and the same task outcome as today runs
  (ProjectData RPC reusing the marker-expiry consequence).
- **Adapters, no web change.** The attention GET and resolve routes accept an ask id in place of a
  marker id (asks first, marker fallback for marker-era questions) and return today's shapes. The
  chat list overlays the chat's newest open question ask onto `attention`; the live read ranks
  chats with an open question in the attention group. The Connector's pending attention merges
  open question asks. The stalled-task guard reads `asks` then the DO.
- **Marker-era overlap.** Markers that exist at deploy keep their DO paths (answer, archive,
  expiry, list via `attention_json`) until they resolve; no new question marker is written.
  Removing the marker-era question code after the overlap is tracked (idea filed in this PR).
- **Migration** `0247_asks_questions.sql` (additive): `source_workspace_id`, `category`,
  `notification_id`, `next_escalation_at`, `escalation_count`, `max_expires_at`; partial index
  for due reminders.

## Implementation checklist

- [x] Rule 44 inventory written below and in the PR
- [x] Migration 0247 + drizzle columns
- [x] Admin settings `inbox.questionTimeoutMinutes`, `inbox.questionFirstReminderPercent`,
      `inbox.questionSecondReminderPercent`, `inbox.questionUndeliveredGraceMinutes`,
      `inbox.questionMaxWaitMinutes`
- [x] `createAsk` accepts question fields; `request_human_input` writes an ask, links notification
- [x] Shared question answer operation (CAS + outcomes + durable delivery + notified_at)
- [x] Inbox answer of a question goes through it; inbox archive of a question unchanged (asks)
- [x] Attention GET/resolve adapters (ask first, marker fallback)
- [x] Typed human message closes open question asks (both DO paths)
- [x] Sweep: question reminders, undelivered-grace extension, expiry with task outcome
- [x] Chat list overlay (index + DO fallback) and live-read ranking
- [x] Connector pending attention merges question asks
- [x] Stalled-task classifier reads asks
- [x] Remove code that only served new needs_input question markers
- [x] Tests: capability (ask → sleep → answer via inbox → woken once; archive), concurrent answers,
      marker-era vs asks-era overlap, tenancy attack/owner pairs on real SQL (discriminating),
      expiry/reminder schedule, chat list overlay, Connector projection
- [x] Docs: API reference / admin settings / any doc describing request_human_input storage
- [x] Idea for removing marker-era question code after overlap: `01M7HC7CN5WY6GEP9G0PP4DG7B`

- [x] Reconciliation check-in hold, idea status, team/account-map reads, Connector lists (from the inventory)
- [x] Rebased on main after F1 (#2775): the Project Overview reads open question asks as "waiting" (`open_questions` CTE, project-bound; commit 3e738055a, both guards proven discriminating)
- [x] Staging (staging2, run 43838856327, 2026-11-16 09:39–09:55Z): real Claude Code agents on a VM and on Instant: ask, answer from inbox and card, concurrent answers (one wins), invalid option 400, archive, expiry on a 1-minute setting, sleeping VM chat woke from an inbox answer. Codex: not testable on staging2 (only Claude Code keys are provisioned there); covered by the harness-agnostic MCP path and its tests

## Notes

- Reviews: security-auditor, cloudflare-specialist, test-engineer, task-completion-validator all ADDRESSED (see PR #2780).
- 07:08Z: paused for the account's 5-hour window (77%, resets 09:10Z); resume wake 09:12Z. Remaining: rebase on F1 (#2775) if merged and adapt its overview query (`.tmp/adapt-f1.py` locally, otherwise: count open question asks in RUNNING_SQL has_attention/row filter/WAITING_ON_VIEWER_SQL), staging2 live checks, merge, deploy.
- Main rejected the direct task-file push (repository rules), so this file lives on the branch only.

### Staging evidence (staging2, 2026-11-16)

Project `01M7HTM8747B16PHS25TQ6WBZA` (Artifacts, Claude Code), user `staging2-agent-user`.

| Check | Runtime | Result |
| --- | --- | --- |
| Question filed as one `asks` row; inbox `store: "ask"`; chat list `needs_input` with the ask id; card GET; Project Overview `waiting`, `waitingOnViewer: true` | Instant | pass |
| Concurrent answers (inbox `eu` vs card `us`) | Instant | card won 200; inbox 409 "A different answer is already being delivered"; replay 200 `alreadyResolved`; agent replied `GOT I: us` |
| Archive from inbox | Instant | 200 `archived`, `agentNotified`; later answer 409; agent told and replied |
| Answer from inbox to a SLEEPING chat | VM | chat slept (snapshot), question still shown on it; answer woke it; agent replied `GOT A: eu` |
| Answer from card; invalid option | VM | `medium` 400; `large` 200; agent replied `GOT B: large` |
| Expiry, `inbox.questionTimeoutMinutes` and `questionMaxWaitMinutes` = 1 (reset to defaults after) | Instant | card `expired: true` at the deadline; sweep set `status='expired'` at 09:53:09Z; task failed "Human input request expired after timeout" (marker-era outcome) |
| D1 rows | both | 3 answered, 1 archived, 1 expired; every row `notified_at` set; schedule columns as configured |

Found while testing (filed): manual sleep 500 on a slow hibernate (`tasks/backlog/2026-11-16-manual-sleep-hibernate-timeout-500.md`); capacity-pool test at the 5 s timeout (`tasks/backlog/2026-11-16-capacity-pool-query-plan-test-near-timeout.md`). A transient upstream `402 AI inference failed` on the VM agent's first turn cleared on retry. Cleanup: both chats stopped, VM node deleted, lease released (run 43844057826).

## Rule 44 inventory

Every writer and reader of question markers (kind `needs_input`) and of
`session_summaries.attention_json`, and what it does after this slice. "Marker-era" = keeps
serving questions that existed as markers at deploy until they resolve (max 24 h by default);
removal tracked in the follow-up idea filed with this PR.

### Writers

| Path | Before | After |
| --- | --- | --- |
| `routes/mcp/human-input-tool.ts` (`request_human_input`) | `createAttentionMarker` + `linkAttentionNotification` | `fileQuestionAsk` → `createAsk` (asks row) + `linkQuestionNotification` (`asks.notification_id`); no marker |
| `ProjectData.createAttentionMarker` RPC (request_human_input branch: resolves check-ins) | ran for questions | branch removed; check-in resolution moved to `ProjectData.recordQuestionAsked` |
| `ProjectData.linkAttentionNotification` + client | question notification link | removed (no caller) |
| `answerAttention` (`routes/chat-attention.ts`; callers: resolve route, `ports.chat.answerAttention` → `sam_agent_answer`, inbox answer) | DO claim → live prompt → complete | ask first: `answerQuestionAsk` CAS + durable prompt + `notified_at`; marker-era fallback unchanged |
| `archiveAttention` (inbox port, `attention:` refs) | DO archive claim | marker-era only; asks archive via `archiveInboxItem` (`closeAsk` + notice) |
| `message-persistence.ts:resolveAttentionForRoles`, `durability-foundation.ts` (human message) | resolve all markers | unchanged for markers; also `closeQuestionAsksForHumanMessage` (asks → answered, notified) |
| `attention-expiry.ts` (DO alarm: expiry, escalation, undelivered grace, task outcome) | questions | marker-era only; asks: inbox sweep (`services/inbox/sweep.ts`) + `ProjectData.expireQuestionAsk` (reuses `failExpiredTaskMarker`) |
| `interaction-store-attention.ts` (permission mirrors), `reconciliation*.ts`, `idle-cleanup*.ts`, `wake-failure.ts`, `provider-limit-attention.ts` | own kinds/sources | unaffected (not questions) |
| `session-summary-sync.ts` (writes `attention_json`) | copies newest marker | unchanged; asks are never copied into it |

### Readers

| Reader | After |
| --- | --- |
| `GET …/attention/:id` (chat card, notification reader) | ask first (same response shape), marker fallback |
| Chat list D1 index (`services/session-summary-index.ts`) | one project read of open question asks merged into `attention`; live ranking counts chats with an open question |
| ProjectData `listSessions` / `getSessionsByTaskIds` / `getSession` (chat list fallback, team status `team-core.ts`, account map `routes/account-map.ts`) | `withQuestionAttention` merges open question asks |
| Web `useSessionReducer` live events | `attention.created` from `recordQuestionAsked`; `attention.resolved` from answer/archive delivery accept, typed message, expiry |
| Inbox list/count (`inbox-list-core.ts`) | asks part lists questions; attention part lists permission mirrors + marker-era questions |
| Connector `sam_chat_read` / `sam_chat_interactions` / `sam_work_changes` (`attention-core.ts`) | markers + open question asks, one projection |
| Connector `sam_chats_list` / `sam_projects_list` (`connector-read-core.ts`) | attention merged / count includes open question asks |
| Stalled-task classifier (`scheduled/stalled-task-classifier.ts`) | `hasOpenQuestionAsk` (D1) + marker check |
| Reconciliation candidates (check-in hold) | candidate deferred one lease while an open question ask exists (`resolveCandidateProjectId` D1 query) |
| Idea "question" status (`idea-work.ts`) | `mergeQuestionAsks` |
| Archive sharding (`archive-sharding.ts`) | unaffected: asks expire within `inbox.questionMaxWaitMinutes` (≤ 3 days) long before the 7-day archive grace |
| VM agent | no reference (verified) |
| `HUMAN_INPUT_TIMEOUT_MS` | removed (replaced by `inbox.questionTimeoutMinutes`); the other three `HUMAN_INPUT_*` remain for marker-era questions |

## Acceptance criteria

- [x] A new request_human_input question is one `asks` row; no marker, no `attention_json` change
- [x] Chat card, chat list needs-input state and the inbox show it as before (tests; staging pending)
- [x] Answer via chat card and via inbox: one wins under concurrency; same outcomes as today
- [x] Answer to a sleeping chat wakes it and the agent receives the answer once; archive likewise (tests prove one wake-capable delivery; live wake verified on staging2: VM chat 70624ba1 slept, inbox answer at 09:47:55Z, awake and replying at 09:49:25Z)
- [x] Expiry and reminders keep today's schedule; expired ask ends `expired`
- [x] Marker-era questions stay answerable/archivable until resolved or expired
- [x] Tenancy guards on `asks` proven on real SQL with discriminating attack/owner pairs
- [x] Limits are admin settings
