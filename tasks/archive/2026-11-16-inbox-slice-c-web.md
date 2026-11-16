# Inbox slice C: the Inbox in the web app

SAM task `01M7H9HB8DFJVS28HK0F7TFSBQ`, spec idea `01M7G03ZCQ6TM6CMEYDRKQ8ST9` (section 4.1, slice C in section 6), channel `feature.inbox`.
Merge authorized by the owner through production (2026-11-16).

## Problem

Slice A (PR #2776) shipped the inbox backend: one list of every ask an agent makes of a person, across projects. People still see agent asks only through the notification bell panel and the notification question dialog. Slice C puts the inbox in the web app and replaces the bell panel.

## Research findings

- Types: `packages/shared/src/types/inbox.ts` (InboxItem, InboxAnswerSpec, INBOX_FILTERS: needs_you, blocking, tasks, reviews, archived). No `updates` filter: Updates is the existing notification list.
- REST: `apps/api/src/routes/inbox.ts`. Writes need the app Origin and JSON (the shared `request()` sends JSON + credentials). Closed items answer with 409 (`conflict`), missing/foreign 404.
- Answer paths (`packages/operations/src/inbox-write-core.ts`): ask/question `{answer}`, interaction `{optionId}|{decline}`, secret `{secret}|{decline}` (web only), approval `{decision}`, acknowledge `{}`/`{answer}`. Archive per store: interaction → deny; ask → closed + agent told.
- Permission items carry no options: the options come from `getAcpInteractionDetail` (`useAcpPermissionCard.ts`). Secret items need the request + existing value from `getSecretRequest` (as `SecretRequestCard`).
- Bell: `NotificationCenter.tsx` mounted in `DesktopSidebar` and `MobileAppBar` (only one per viewport). It owns the notification socket via `useNotifications` (only caller). Question dialog: `NotificationQuestionDialog` (+ loader, `NotificationItem`, `attention-request.ts`) used only by the bell and `ProjectNotifications`.
- `AttentionAnswerControls` is also used by the chat `HumanInputCard`: extend, do not fork.
- `AcpPermissionCard` buttons live in `PermissionOptions`; `ApprovalItem` buttons are an inline `actions` block.
- Nav: `PROJECT_NAV_ITEMS` / `getGlobalNavItems` in `NavSidebar.tsx` feed desktop; `AppShell` maps the same lists into `MobileNavDrawer` (needs a count field). Command palette has "Go to Notifications".
- `isFullBleedRoute` (`lib/shell-routes.ts`) decides whether the page lays its own panes.
- Query client default `refetchOnWindowFocus: false`: inbox queries must opt in.
- Public docs: `apps/www/src/content/docs/docs/guides/notifications.md`, `chat-features.md`, `collaboration.md`; screenshot spec `docs-screenshots-notifications.spec.ts`; audits `notification-question-audit.spec.ts`, `notification-tabs-audit.spec.ts`.
- F1 (PR #2775) also edits `PROJECT_NAV_ITEMS` and `isFullBleedRoute`: expect a trivial rebase conflict; do not edit `pages/project-overview/`.

## Checklist

- [x] API client `lib/api/inbox.ts` + query options `lib/query-options/inbox.ts` (identity-scoped keys, focus refetch, no polling)
- [x] Hooks: `useInboxCount`, `useInboxList` (infinite), `useInboxItem`; socket `notification.new`/`updated` invalidates inbox queries
- [x] Split `PermissionOptions` (exported, inline/pinned layout) out of `AcpPermissionCard`; chat card unchanged in behaviour
- [x] Split `ApprovalDecisionButtons` out of `ApprovalItem`; Admin + chat card unchanged
- [x] `AttentionAnswerControls`: injectable submit, "Type a different answer" beside options, radio list + pinned Send above five options, pinned layout
- [x] Inbox row, chip row (Needs you, Blocking, Tasks, Reviews, Updates; Archived in ⋯ menu; active chip scrolls into view), stacks, empty state, Updates list
- [x] Item view: meta line, title, reason, link chips, collapsed Context, pinned controls per answer spec, Archive + Open chat in top bar, previous/next, stack counter
- [x] Auto-advance after answer with one-line receipt; stale item closes itself; failed answer keeps item with error
- [x] Archive with Undo window, then send; pending archive flushed on navigation/unmount/pagehide (keepalive)
- [x] Pages `/inbox` and `/projects/:id/inbox` (lazy, full-bleed); phone list → item full screen; desktop list beside item
- [x] Nav: Inbox in global nav and project nav (replaces project Notifications) with counts, desktop and phone drawer; command palette entry
- [x] Inbox icon in the bell slot: desktop popover with safe one-tap answers + Open inbox; phone link to page
- [x] Remove NotificationCenter, NotificationQuestionDialog (+loader), NotificationItem, attention-request, ProjectNotifications; redirect `/projects/:id/notifications`
- [x] Unit/behavioural tests (answer each kind, archive with/without Undo, failed answer, stale item, last-of-stack → next stack, last overall → empty, nav counts)
- [x] Rule 82: typed chat cards still render for every harness after the split
- [x] Playwright audit 375/1280 with stress data (30/30, blocking clipped-overflow check); screenshots posted on PR
- [x] Docs: notifications/chat-features/collaboration guides; docs screenshot spec
- [x] Interface handoff on feature.inbox

## Acceptance criteria

- Inbox reachable from global nav, project nav and the inbox icon on desktop and phone, each with its count.
- Every item kind opens and answers (or shows read-only) through the slice A routes; the agent gets the outcome.
- Answering advances to the next item with a receipt; last of a stack → next stack; last overall → empty state.
- Archive shows Undo; undone archives send nothing; pending archives are sent on navigation and tab close.
- Counts refresh on load, on focus and on notification socket events; no interval polling.
- Refetches never unmount the list or the open item.
- Old bell panel and question dialog removed; push, preferences and settings page stay.
- Staging: real agent `request_human_input` + `request_secret`, one answered and one archived from the inbox at phone and desktop sizes, agent receives both.

## Implementation notes

- PR #2779. The notification socket moved into `AppShell` (one per app, also in Focus mode, where the sidebar hides the icon) and invalidates inbox queries on `notification.new`/`notification.updated`.
- Answer/archive hand-over: `useInboxWalk` records where an answered item handed over to (`handedOver`) so the render between hiding the item and the URL update never shows an empty item pane.
- Secrets keep the existing secret-request routes through `SecretRequestForm` (same record, value never enters a query/mutation cache); everything else answers through the slice A inbox routes.
- Guards proven discriminating: removing the unmount flush reddens "a pending archive is still sent when the page unmounts"; disabling the stale check reddens "closes an item that was answered elsewhere when it opens".
