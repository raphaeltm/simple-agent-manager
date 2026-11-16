# Inbox slice F1: Project Overview page

SAM task `01M7GZW4C52GAKVN3B57ABZQVB`. Spec: idea `01M7G03ZCQ6TM6CMEYDRKQ8ST9` (sections 1, 4.2, 6 slice F1).
Coordinator task `01M7FZH8XEZ8PT9H3JMWRNVHJ5`, channel `feature.inbox`. Authorized through production.

## Problem

People open a project and land in chat. The owner wants a Project Overview: what is running, what
the accounts have left, which automations are broken, what happened recently, and a task box that
starts work without leaving the page ("fire and forget"). F1 builds the page at its own route with
an Overview nav item. It is not the landing page yet and has no Needs you section or brief (F2/I).

## Research findings

- Routes: `apps/web/src/App.tsx` project shell, index route redirects to `chat` (keep). Pages are
  lazy-loaded with `lazyNamed`.
- Nav: one list `PROJECT_NAV_ITEMS` (`components/NavSidebar.tsx`) feeds desktop sidebar and the
  mobile drawer (`AppShell.tsx` maps it) — adding Overview first gives parity. Command palette has
  its own `PROJECT_NAV_ITEMS` (`hooks/useCommandPaletteContext.tsx`).
- Submit path: `useProjectChatState.handleSubmit` builds the request (instant vs task), calls
  `startInstantChatSession`/`submitTask`, clears composer, sets provisioning and navigates.
  Effects reacting to a new session on the chat page: `useProvisioningTracker` (provisioning +
  sessionId), `useComposerPrefill(sessionId)`, `useAvailableCommands(.., sessionId)`, the
  `session.created` socket handler in the same hook. No global listener navigates on
  `session.created` (grep: only chat page files and palette formatting). The Overview does not
  mount any of those, so not navigating cannot trip them.
- Composer: `pages/project-chat/ChatInput.tsx` (profile To control, run account control,
  options, attachments, wizard) around `ProjectChatComposer`. Reuse it; add an optional receipt
  line and a "collapse toolbar while empty" option for the phone.
- Running now: D1 `session_summaries` index (status/agent_completed_at/attention_json, synced by
  the DO) + `tasks` (status, execution_step, agent_profile_hint) + `agent_profiles.name`. Chat
  list "idle" = `status='active' AND agent_completed_at IS NOT NULL` (`session-summary-index.ts`);
  terminal task statuses come from shared `TASK_TERMINAL_STATUSES` (`chat-operational.ts`).
- Budgets: client model `useProfileUsages` (accounts model + `explainProfileAccount`). The task
  box needs exactly this map for its own ring, so Budgets derives from the same cached reads at
  no extra request. Moving it server-side would fork the account resolution rules.
- Automations: client model `useAutomationData` + `attentionItems` + `comingUp`
  (`pages/automation/`). `AttentionPanel` is ~210px tall; export a compact one-line row and share
  the fix-button piece with it, do not fork the attention rule.
- Recently: `listIdeasWithDerivedStatus` operation (IdeaRow input) and D1 `pull_requests`
  (`state='merged'`, `merged_at`).
- Operations pattern: `packages/operations` op + `webOperationContext` REST adapter;
  `authorizeProjectOperation` owns membership. Real-SQL tests via `createSqliteD1`.

## Decisions

- One aggregated read `projectOverviewGet` (GET `/api/projects/:projectId/overview`) for Running
  now and Recently. Budgets and Automations reuse the canonical client models (no fork); Budgets
  adds zero requests (shared with the task box).
- Running now = awake chats (`status='active'`) whose task is not terminal and that are working
  (`agent_completed_at IS NULL`) or paused on an open question (`attention_json` set). Sleeping and
  idle chats are excluded. Row: topic, then "1h · <profile>", or "Starting · <profile>", or amber
  "Waiting on you" (own chats) / "Waiting for an answer" (others').
- Desktop layout: `OverviewLayout` with `main` and `rail` slots. F1 puts Running now and Recently in
  `main` (wide) and Budgets and Automations in the `rail`, task box pinned under `main`. F2 moves
  Running now/Recently to the rail and puts brief + Needs you in `main` — a slot reassignment.
- Task box success: no navigation, one-line receipt "Started: <title> · Open chat", optimistic
  Running now row until the next server read includes it.

## Checklist

- [ ] Shared types `ProjectOverviewResponse` etc. in `packages/shared`
- [ ] Operation `projectOverviewGet` in `packages/operations` (auth, running query with per-row
      validation, ideas via `listIdeasWithDerivedStatus`, merged PRs), exported
- [ ] REST route `GET /api/projects/:projectId/overview`, mounted; API reference docs
- [ ] Real-SQL tests: foreign-project rows excluded, owner control, sleeping/idle/terminal excluded,
      waiting chats included, malformed row skipped, merged PRs ordered, limits
- [ ] Extract composer state + submit into a shared hook used by chat page and Overview (chat page
      behaviour unchanged; existing chat tests green)
- [ ] `ChatInput`: receipt slot, collapse-when-empty, focusOnMount passthrough
- [ ] `usageWords` long window names ("5-hour window · 38% left")
- [ ] Automation: export compact attention row sharing the fix-button piece with `AttentionPanel`
- [ ] Overview page (lazy) with sections, layout slots, TanStack query, socket invalidation,
      no hidden-tab polling
- [ ] Route `overview` + nav item first (desktop + mobile drawer) + command palette entry
- [ ] Behavioural tests: send from Overview → no navigation, receipt, new Running now row (fetch
      mocked at the network edge); failed start shows error in receipt line
- [ ] Playwright audit 375/1280: normal, 12 running, 6% account, two failing automations, long
      titles, empty quiet project, receipt, failure; screenshots reviewed and posted
- [ ] Docs: public docs page for the Overview / nav, api-reference
- [ ] Channel: interface publication; merge + deploy publications

## Acceptance criteria

- `/projects/:id/overview` renders Running now, Budgets, Automations, Recently from real data; index
  route still goes to chat; Overview is first in project nav on desktop and phone.
- Sending from the task box keeps you on the page, clears the box, shows the receipt and the new
  row in Running now; Open chat reaches the chat. A failed start shows its error in the receipt.
- One aggregated read within 20 round trips (count stated in PR); TanStack Query; no polling while
  hidden; one malformed row does not break the read.
- Staging: verified as the smoke user on a project with a real running agent.
