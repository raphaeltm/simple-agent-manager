# Inbox slice F2: Project Overview becomes the landing page, with Needs you

SAM task `01M7J0GMRFPPAJ19VS5X754KPX` · spec idea `01M7G03ZCQ6TM6CMEYDRKQ8ST9` (sections 1.5, 1.6, 4.2, 6 row F2) ·
channel `feature.inbox` · branch `sam/implement-slice-f2-inbox-754kpx` · merge authorized through production (2026-11-16).

## Problem

Opening a project lands on chat. The spec makes the Project Overview the landing page, with the person's
open inbox items for this project ("Needs you") at the top, chat one tap away, and Running now worded
the same way as the inbox ("paused on this").

## Research findings

- Index route: `apps/web/src/App.tsx` `<Route index element={<Navigate to="chat" replace />} />`.
- Shell classifiers: `apps/web/src/lib/shell-routes.ts` `isFullBleedRoute` (no bare `/projects/:id`) and
  `isProjectChatRoute` (includes the bare index, because it redirected to chat). Used by `AppShell`, `Project`,
  `App.tsx` (`ProjectRouteFallback`, chat chunk preload).
- Route prefetch: `apps/web/src/lib/project-route-prefetch.ts` treats the bare index as a chat route and
  prefetches the chat session list (consumed once by `readInitialSessionList`).
- Overview page (F1): `apps/web/src/pages/project-overview/index.tsx` (`OverviewLayout` main/rail/taskBox,
  `PHONE_ORDER`), `sections.tsx` (`RunningNowSection`, `RunningMeta` says "Waiting on you"),
  `useProjectOverview.ts`, `OverviewTaskBox.tsx` (receipt line).
- Slice C reusable pieces: `components/inbox/useInbox.ts` (`useInboxList`, `useInboxCount`, query keys shared
  with the inbox page, refreshed by `useNotificationSocket`, no polling), `InboxRow.tsx` (`InboxRow`),
  `inbox-model.ts` (`buildRows`, `isPausedOnItem`), `pages/inbox/InboxPage.tsx` (item pane Back button
  `walk.close()`), `useInboxWalk.ts` (URL params copied on every navigation, so an extra `from` param survives
  answer/advance).
- Phone app bar: `components/shell/MobileAppBar.tsx` primary slot = `screenAction` set by pages through
  `useAppShell().setScreenAction` (project chat uses it for its chat list).
- Project-shell interaction effects: `Project.tsx` has no redirect effects; chat auto-select/redirect effects
  live in `useProjectChatState` and only run when `ProjectChat` mounts (it no longer mounts on the index).
- Running now "waiting" (`packages/operations/src/project-overview.ts`, `PAUSED_ON_PERSON_SQL`) = attention
  marker or open question ask (slice G). Inbox `agentState: 'waiting'` = any open blocking item on a running
  task (`inboxAgentState`, `packages/operations/src/inbox-rows.ts`), including secret requests. A chat paused on
  a secret request whose turn ended is therefore in Needs you but missing from Running now.
- Links into a project (decisions in the PR):
  - "this project" → Overview: `ProjectSummaryCard`, command palette project entries, `ProjectInvite`
    (post-invite), `ProjectOnboardingWizard` onSkip, `workspace/index.tsx` back, `SidebarProjectList` (was
    `/chat`), `TaskRedirect` fallback without a chat (was `/chat`), `ActiveTaskCard` fallback without a chat
    (was `/chat`), notification `buildActionUrl` without a session and push (server, unchanged: resolves via the
    index), Connector `link` (server, unchanged), `account-map` project links, SAM receipts project target.
  - "this chat" → chat (unchanged): every `projectChatPath`, notification/push with a session, onboarding wizard
    first chat, inbox Open chat, Running now rows, receipts' Open chat, command palette "New chat", deployments
    "ask agent", `CompletionScreen` ("Start chatting").
  - Fixed: `ObservabilityLogEntry` `/projects/:id?sessionId=` (the redirect dropped the query) → chat path.
  - Emails: agent-email builds no project links (grep).
- Slice E (`error` items for failed starts) is a sleeping draft (PR #2781); it files failed-task items from a
  cron scan and the VM-agent callback (asynchronous). A synchronous submit failure has no task and no item.
- Insights slice F (PR #2789) takes the rail's This week pane directly under Running now.

## Implementation checklist

- [x] Index route → `overview`; `isFullBleedRoute` covers the bare index; `isProjectChatRoute` no longer does;
      route prefetch reads the Overview (and its Needs you list) for the index and `/overview`
- [x] Links: SidebarProjectList, TaskRedirect fallback, ActiveTaskCard fallback → project; ObservabilityLogEntry → chat path
- [x] `NeedsYouSection`: slice C hooks + `InboxRow`; 3 rows phone / 5 desktop; count + "All N" link; one quiet line
      when empty / loading / unavailable; rows open `/projects/:id/inbox?item=<ref>&from=overview`
- [x] Layout: main = [brief slot comment, Needs you]; rail = [Running now, Budgets, Automations, Recently];
      PHONE_ORDER needsYou 1, running 2, (3 free for This week), budgets 4, automations 5, recently 6
- [x] Phone app bar Chat control on the Overview (setScreenAction); desktop Chat nav item already present
- [x] Inbox item view: Back returns to the Overview when opened from it (phone and desktop), no reload
- [x] Running now: "Paused on this" (amber) when the viewer has a paused Needs-you item from that chat;
      server waiting predicate also counts open blocking asks and pending secret requests for the chat
- [x] Couldn't start wiring: slice E (#2781) is not in production (unmerged draft, 2026-11-16 11:45Z), so NOT built; the exact follow-up is posted on feature.inbox (event 4a9cd154-374c-43da-9fab-39904a9bcf73) for the coordinator to dispatch. Today's receipt-line failure is unchanged.
- [x] Tests: landing behavioural test (opening a project shows the Overview, no bounce to chat; returning from an
      inbox item keeps the Overview); Needs you unit tests; Running now wording; shell-routes; prefetch; operations SQL
- [x] Playwright audit 375/1280: 40 items, long titles, stack, expiring permission, failed start item,
      nothing-needs-you, brand-new empty project; first-screen check at 375x667
- [x] Docs: `guides/project-overview.md`, other docs naming where a project opens; rule 26 note

## Acceptance criteria

- Opening `/projects/:id` shows the Overview (URL `/projects/:id/overview`) and never bounces to chat.
- Needs you lists this project's open items for the viewer in inbox order: 3 rows on a phone, 5 on desktop, with
  the count and a link to the project inbox; empty is one quiet line.
- Tapping a row opens it in the project inbox item view; answering shows the receipt and moves on; Back returns to
  the Overview with the count reduced, without a full reload.
- Chat is one tap away: desktop Chat nav item; phone app-bar Chat control.
- A chat paused on the viewer's inbox item reads "Paused on this" in Running now and its item is in Needs you.
- At 375x667 the first screen shows ≥3 Needs you rows and the start of Running now, with the task box pinned.

## References

Rules 06 (interaction effects), 48 (stale-while-revalidate), 17 (visual audit), 62, 26; spec idea above; prototype
Library `/design/project-overview-inbox-2026-11-15/`.

## Notes

- Recent chats (phone app bar and desktop sidebar) now uses a History icon, as in the accepted
  prototype, so it is not a second speech bubble beside the new phone Chat control.
- Quarantined Playwright specs that opened the bare project URL expecting chat now open `/chat`
  (focus-mode, nested-session-sidebar, wake-failed-session-sidebar). nested-session-sidebar and
  focus-mode are quarantined (not selected by CI) and fail locally on the first-run wizard overlay
  regardless of this change.
