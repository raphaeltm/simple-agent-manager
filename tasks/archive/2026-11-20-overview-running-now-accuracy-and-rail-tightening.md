# Overview: accurate "Running now", tighter rail and Budgets

## Problem

Raphaël (2026-11-20): "Not sure how we decide what shows up in 'running now' in the overview... it's
not accurate. I also feel like the budgets are a bit busy. Dunno if we need all the text at the
bottom. I feel like that whole left column could be 'tighter' somehow."

His screenshots show Running now = "Nothing is running." while the chat list shows 10 awake chats,
several with messages "Just now". Budgets shows 8 account rings and five lines of exception text
under them that repeat each account's name.

## Research findings

- Running now's rule is `overviewChatRunningSql` (`packages/operations/src/project-overview-statuses.ts`):
  awake + task running status + (starting | paused on a person | `agent_completed_at IS NULL AND
  execution_step <> 'awaiting_followup'`).
- Production D1 (2026-11-20 00:40Z, project SAM): all 10 `session_summaries.status='active'` chats
  have tasks `in_progress` with `execution_step='awaiting_followup'` and `agent_completed_at` NULL.
  So all fail the mid-turn disjunct.
- `tasks.execution_step` is written `running` only by the first transition to in_progress
  (`apps/api/src/durable-objects/task-runner/in-progress-transition.ts`); `awaiting_followup` is
  written when a turn ends and never cleared by a follow-up turn. It is latched after the first turn,
  so the predicate really means "still on its first turn" (rule 74: proxy, not the condition).
- `chat_sessions.agent_completed_at` is set only by `markAgentCompleted`, which has no callers. It is
  cleared on wake. It is never evidence of anything.
- The authority for "is the agent mid-turn" is the ProjectData DO `session_state.activity`
  (`prompting`/`recovering` = `WORKING_ACTIVITIES`), written by VM agent activity callbacks and
  control-plane turn ends, reconciled by `session-activity-reconciliation.ts` (rule 57). The chat view
  resolves a chat's activity as the newest ACP session's row, falling back to the chat-keyed row
  (`resolveChatAgentState`, `apps/api/src/routes/chat-agent-state.ts`).
- The same rule feeds the brief's re-check (`project-brief-read.ts`) and the brief facts
  (`project-brief-facts.ts` -> `readRunningChats`), so all three consumers must change together.
- The Overview page already refetches on `session.activity` socket events (`useProjectOverview`), so
  a DO-backed read is fresh within one refetch burst.
- Budgets (`apps/web/src/pages/project-overview/BudgetsSection.tsx`): tiles show ring + account name +
  profile count/name, then a separate list of exception sentences naming each account again.

## Design

- New DO read `listWorkingChatSessionIds()`: awake chats whose resolved activity is working (same
  resolution as `resolveChatAgentState`). One RPC per Overview read, shared by Running now and the
  brief; one per brief refresh.
- `overviewChatRunningSql` takes the working ids (bound once as JSON, `json_each`) instead of the
  `agent_completed_at`/`execution_step` disjunct.
- Budgets: fold the exception text into each tile's second line ("13% left" in the window's colour,
  "Out", "Paused"); full words stay in the tile's accessible name and tooltip. Drop the profile-count
  line and the sentence list. Smaller ring and tighter grid.
- Rail tightening: one-line titles and less padding for Running now and Recently rows.

## Checklist

- [x] DO: `listWorkingChatSessionIds` (project-data `do/`), DO method, client wrapper, operations port, api operation-ports wiring
- [x] operations: `overviewChatRunningSql(paused, working)`; `readRunningChats` + `readProjectBrief` + `readBriefFacts` take working ids; overview get fetches once and shares; failure -> sections unavailable
- [x] apps/api brief refresh passes working ids
- [x] Tests: DO read against real DO SQLite (workers test) incl. newest-ACP precedence, chat-keyed fallback, sleeping chat excluded; overview SQL against real SQLite: latched `awaiting_followup` + working -> listed (fails pre-fix), idle -> not listed (control), starting/paused still listed
- [x] Budgets tile status line + remove exception list; unit tests updated
- [x] Rail rows tightened (Running now, Recently)
- [x] Playwright audit (project-overview-audit.spec.ts) mobile + desktop, screenshots checked
- [x] Docs: any doc describing Running now's rule updated

## Implementation notes

- Commits on PR #2921. Discrimination: restoring the old predicate turns the `later-turn` overview
  unit test (plus two idle-paused cases) red.
- Review: task-completion-validator PASS; cloudflare-specialist PASS (MEDIUM: a wedged `prompting`
  row lists a chat, same as the chat view, healed by rule-57 reconciliation; kept); ui-ux-specialist
  PASS, its two MEDIUMs fixed (visible status in the accessible name; number and colour from one window).
- Staging (sammy.party, deploy of e5133b500, project Potato, Claude Code conversation profile):
  turn 1 listed as starting during provisioning, then working, then dropped at turn end; the
  follow-up turn was listed as working while `tasks.execution_step` read `awaiting_followup`
  (the incident shape), then dropped at turn end; no console errors. A first run with the default
  OpenCode profile hit "Agent request failed" on staging (unrelated); Running now still dropped it.
- CodeRabbit: two minor findings fixed in 093fa6d3d (brief clock after the activity wait; the
  cross-project test reports its attack chats as mid-turn, proven red without the join).
- Deferred: `markAgentCompleted` has no callers -> `tasks/backlog/2026-11-20-agent-completed-at-has-no-writer.md`.

## Acceptance criteria

- A chat whose task is latched at `awaiting_followup` but whose agent is mid-turn appears in Running now.
- An awake chat whose agent is idle (and not starting/paused) does not appear.
- The brief cannot name a chat as running that Running now does not list.
- Budgets shows no separate sentence list; each tile carries its own short status; screen readers still hear the full usage.
- Staging: start a chat, see it in Running now while the agent works; it leaves when the turn ends.

## References

- `.claude/rules/74-proxy-signals-must-match-the-condition.md`, `57`, `62`, `65`
- Idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9 (Inbox + Overview spec, section 4.2)
