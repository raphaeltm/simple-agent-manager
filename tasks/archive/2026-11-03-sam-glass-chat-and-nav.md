# SAM Glass: chat UI and navigation wrappers

## Problem

PR #2500 merged the SAM Glass foundation (material CSS, tokens, guide, rule 80, skill) but changed
no screens. Raphaël asked for a draft PR that implements it in the app: the chat UI, the general
navigation wrappers (app shell, sidebar, mobile app bar and drawers), and every panel or modal
opened from a chat button, as close as possible to the design references
(`/workspaces/.private/01M6H79VR4K6MPGKF8BW8NA12G/sam-glass-screens.zip`: 01 desktop chat, 02
multiplayer, 03 mobile chat, 04 mobile chat-list drawer, 05 app bar, 10 daylight/light).

Constraints from the request: draft PR (do not merge), CI green, screenshots of every modified
surface in light and dark, desktop and mobile, uploaded to the PR.

## Research findings

- `AppShell.tsx` renders a grid with a `glass-chrome` aside and a full-bleed `main`; mobile has a
  top bar plus the chat page's own second bar (`pages/project-chat/index.tsx`).
- `NavSidebar.tsx` items use a left-border active style; `FocusModeToggle` is the Default/Focus/Zen control.
- Chat list: `ProjectChatSidebar`, `SessionItem`, `SessionTreeItem`; mobile list `MobileSessionDrawer`.
- Conversation: `SessionMessageView` → `ConversationPane` (floating `SessionHeader` laid over the
  list, tool rail inside the pane) and `SessionFooter`/`FollowUpInput` below spanning under the rail.
- Drawers/dialogs opened from chat buttons: `ChatFilePanel` (files, git), `ChatTimelineDrawer`,
  `SessionLinkedWorkDrawer`, `SessionResourceHistoryDrawer`, `SessionAutomationDrawer`,
  `SessionCommentsDrawer`, `SessionShareDialog`, `ReportIssueDialog`, complete `ConfirmDialog`,
  `BootLogPanel`, `HierarchyModal`, `TriggerDropdown`, `RecentChatsDropdown`, `NotificationCenter`,
  `ProfilePickerSheet`, `MobileNavDrawer`, `GlobalCommandPalette`.
- Data limits (from the guide): "Others" and per-person filters need an API option; "shared with"
  avatars on rows are not in the list response; stable join-order person colours need data. Not
  in scope; the UI uses what exists (Mine/All, isMine, createdBy).
- CI runs every non-quarantined `*audit.spec.ts` on iPhone 14; structural changes can break selectors.

## Implementation checklist

- [x] packages/ui SAM Glass components (Pane, IconButton+Count, Chip, PersonAvatar, SegmentedControl, NavItem, SearchField) with stories and exports; missing tokens added to sam-glass.css in both themes
- [x] AppShell: void, 16px frame, 14px gutters, sidebar pane, content pane for non-chat routes, bare main for chat
- [x] NavSidebar + FocusModeToggle + user row in SAM Glass
- [x] Mobile app bar slab (menu, logo, project name, recent chats + notifications well, screen toggle) and menu drawer overlay (with search + project settings)
- [x] Chat list pane: header, New Chat, search well, Mine/All segmented with counts, session rows
- [x] Conversation column: header slab, quiet message pane, composer slab, full-height tool rail pane
- [x] Message bubbles, new-chat state and composer (ChatInput) restyled
- [x] Mobile chat-list drawer (overlay with live blur, from the right)
- [x] Shared drawer/dialog shell applied to every chat-attached drawer and dialog
- [ ] Existing unit and Playwright audits updated where structure changed
- [x] New audit spec capturing every modified surface: dark/light × desktop/mobile
- [x] Docs: guide/skill updated for the components built; public docs if behaviour changed

## Acceptance criteria

- [ ] Chat desktop and mobile resemble references 01/02/03/04/10 in both themes
- [ ] At most one live blur on screen; panes separated by gutters; elements solid
- [ ] All chat-attached panels and dialogs use the SAM Glass overlay
- [x] CI green on the draft PR; screenshots posted to the PR

## Implementation notes

- `isFullBleedRoute()` (lib/shell-routes.ts) decides bare vs content-pane main; shared with Project.tsx.
- The floating session header became a static slab; the message list no longer pads for it.
- On desktop the tool rail is its own pane beside the whole conversation column; on phones it stays inside the quiet message pane so header and composer keep full width.
- Counts render from `data-count` via `::before` (axe label-content-name-mismatch).
- Overlays use the full pane fill + live blur; light-mode chrome fill was too see-through.
- Hierarchy modal closes the phone chat-list drawer first (two live blurs otherwise).
- Docs screenshots under apps/www/public/images/docs predate SAM Glass; regenerating them is a separate pass.

## Reconciliation (2026-11-09 weekly queue sweep)

- Shipped: #2506 merged 2026-11-04 (originally requested as a draft; later merged), with follow-ups #2522 and #2529.
- Production deploy run on `e727f0259` (2026-11-09 01:29 UTC) succeeded and contains this merge, so the change is live.
- The unchecked visual acceptance items were not re-verified in this sweep.
- Moved from `tasks/active/` to `tasks/archive/` by the weekly reconciliation.
