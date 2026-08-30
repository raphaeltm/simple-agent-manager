# Chat session tool rail — surface the buried session controls

Ships **Variation A** from the chat-toolbar prototype exploration
(branch `sam/few-buttons-drop-down-fvckk5`, design writeup + 8 screenshot sheets in
library `/design/chat-toolbar/`). Raphaël reviewed both variations and chose A.

## Problem

Nine session controls are unreachable without knowing to tap one unlabeled 14px chevron.

| Control | Where it lives today | Visible by default? |
| --- | --- | --- |
| Files | `SessionHeader.tsx:657` — inside the `expanded` disclosure | No |
| Git | `SessionHeader.tsx:663` — inside the disclosure | No |
| Workspace | `SessionHeader.tsx:669` — inside the disclosure | No |
| Timeline | `SessionHeader.tsx:682` — inside the disclosure | No |
| Comments | `SessionHeader.tsx:689` — inside the disclosure | No |
| Report | `SessionHeader.tsx:696` — inside the disclosure | No |
| Complete | `SessionHeader.tsx:703` — inside the disclosure | No |
| Retry | `SessionHeader.tsx:276` — title row | Icon only, unlabeled |
| Fork | `SessionHeader.tsx:287` — title row | Icon only, unlabeled |

The disclosure's only affordance is the chevron at `SessionHeader.tsx:301`, whose accessible
name is **"Show session details"** — it promises metadata, not tools. There is no "…", no
count, no partial peek. New users have no reason to believe Files, Git, or Timeline exist.

This is the same structural problem the comments work hit in August ("the session action row
holding Timeline/Files/Git/Workspace is INSIDE the collapsed disclosure, so a Comments button
there alone stays invisible"). Comments was fixed by promoting one button to the chip row.
This task generalises that fix instead of repeating it per-button.

## Research findings

### Layout

`ProjectMessageView` (`components/project-message-view/index.tsx`) has **two** render branches
— empty conversation (`:539`) and populated (`:569`) — each shaped
`<div class="flex-1 min-h-0 min-w-0 relative flex flex-col lg:flex-row">` containing a chat-log
column plus `{desktopCommentRail}`. Both branches need the rail.

`DesktopCommentRail` (`comments/MessageCommentPanels.tsx:159`) is already a right-side flex
sibling (`hidden … w-80 shrink-0 … lg:flex`). The tool rail goes to its **right** so both can
coexist: `[chat log] [comment rail when open] [tool rail]`.

The prototype anchored the rail below the floating header via `useFloatingHeaderHeight()` and
needed a `min(headerHeight, 45%)` clamp, because opening the disclosure grows the header past
the viewport and pushed the rail off-screen (measured y=763 in a 667px viewport). **Anchoring
to the messages-area container instead (`inset-y-0 right-0` inside the existing `relative`
parent) removes that failure mode by construction** — no header-height dependency, no clamp.
A `shrink-0` spacer of the gutter width keeps the chat log and its `absolute` FloatingHeader
correctly narrowed, and keeps the layout stable when cycling icons↔labels.

The scroll-to-bottom button (`index.tsx:610`, `absolute right-4`) and
`commentUi.selectionControls` both live inside the chat-log column, so they inherit the
narrowed width automatically — no separate offset needed. Verify in the audit.

### Responsive trap (measured in the prototype, must be preserved)

A 158px labels rail is **42% of a 375px viewport** — message bubbles collapsed to ~200px and
code spans broke mid-token. Labels mode must **overlay** on mobile (gutter stays at icon width,
rail floats with a heavier shadow) and **push** on desktop, where 158/1280 = 12%.

### Test blast radius

Removing the disclosure action row, the title-row Retry/Fork, and the chevron touches:

- Unit: `tests/unit/RetryForkButtons.test.tsx`, `tests/unit/components/session-header.test.tsx`,
  `tests/unit/components/project-message-view.test.tsx`.
  (`tests/unit/pages/project-chat.test.tsx` mocks `ProjectMessageView` wholesale at `:178-184`,
  so it is insulated — confirm, don't assume.)
- Playwright, 7 specs referencing `Show session details`: `chat-file-viewer-audit` (3 refs),
  `session-header-agent-info-audit`, `report-issue-audit`, `docs-screenshots`,
  `comments-navigation-audit`, `chat-timeline-drawer-audit`, `chat-dom-bound-audit`.

### Rules consulted

- `.claude/rules/17-ui-visual-testing.md` — mobile+desktop audit, overflow assertions, and the
  **virtualized-list** section: this chat uses Virtuoso, so the audit must not rely on a mock
  that renders every row.
- `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md` — use
  `assertNoClippedOverflow`, and page roots inside the Outlet wrapper need `w-full min-w-0`.
- `.claude/rules/64-unstable-prop-identity-remounts-subtrees.md` — the action array must be
  `useMemo`'d; an inline array would give the rail a new prop identity on every poll tick.
- `.claude/rules/24` / `.claude/rules/59` — one implementation per operation. `buildToolActions`
  becomes the single source of truth, replacing nine inline JSX conditions.
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — drive the real controls; an
  absence assertion needs a liveness assertion beside it.
- `.claude/rules/37-prototype-development.md` + policy 529b4261 — the prototype route and page
  directory must be deleted; the product surface is the deliverable.
- `.claude/rules/03-constitution.md` — rail widths/breakpoint are layout constants, but any
  timing/limit must be env-configurable with a `DEFAULT_*`.

## Implementation checklist

- [ ] Add `session-tool-actions.ts` — `buildToolActions()` deriving the tool list from the same
      conditions the header uses today (workspace+active gate, `canMarkComplete`, `reportEnabled`,
      task presence), plus `ToolStripMode`, `nextMode`, `isGroupStart`.
- [ ] Add `SessionToolRail.tsx` — icons / icons+labels / hidden tri-state, one cycling control,
      group dividers, comment badge, full-sentence `aria-label` on every button in icon mode.
- [ ] Make `SessionHeader` disclosure state **controlled** (`expanded` + `onExpandedChange`), so
      the rail's Details action and the "+N more ports" chip drive the same panel.
- [ ] Delete the action row from the disclosure (`SessionHeader.tsx:653-715`).
- [ ] Delete the title-row Retry/Fork buttons and the chevron (`SessionHeader.tsx:274-311`).
- [ ] Thread the new props through `FloatingHeader`.
- [ ] Render the rail + gutter spacer in **both** `ProjectMessageView` branches; own `expanded`
      and `toolStripMode` state there; memoize the action array.
- [ ] Persist the chosen mode across sessions (localStorage), defaulting to `icons`.
- [ ] Delete `pages/chat-toolbar-prototype/`, its route, its `DEV_ONLY_ROUTE_PATHS` entry, and
      `tests/playwright/chat-toolbar-prototype-audit.spec.ts`.
- [ ] Update the 3 unit test files and 7 Playwright specs to drive the rail.
- [ ] New unit tests: `buildToolActions` per session state; rail renders/cycles/activates.
- [ ] New Playwright audit against the **real** chat at 375×667 and 1280×800, with the
      mobile-overlay vs desktop-push gutter assertion proven discriminating.

## Acceptance criteria

- [ ] All nine controls are reachable without opening any disclosure, in a session where they
      apply. Verified by a test that asserts each is visible on first paint.
- [ ] The rail cycles icons → icons+labels → hidden → icons through its own control, and the
      hidden state still exposes a labelled pull-tab.
- [ ] In icon-only mode every button has a full-sentence accessible name.
- [ ] Labels mode overlays on mobile and pushes on desktop — asserted on the measured gutter,
      and proven to fail if the responsive branch is removed.
- [ ] Opening session details does not evict the rail (assert on-screen coordinates).
- [ ] Tools shown match session state: a sleeping session shows no Files/Git/Workspace; an
      active one does.
- [ ] No horizontal overflow and no clipped overflow at 375px or 1280px.
- [ ] The scroll-to-bottom button and comment selection controls do not collide with the rail.
- [ ] No `/prototype/*` route or prototype page directory remains.
- [ ] Full suite green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- [ ] Staging: rail visible and every control works end-to-end on `app.sammy.party`, mobile and
      desktop, zero errors.

## References

- Prototype branch `sam/few-buttons-drop-down-fvckk5`, commit `d71d7e27c`
- Library `/design/chat-toolbar/` — writeup + 8 screenshot sheets
- Knowledge entity `ChatToolStrip` — the two layout traps, measured
