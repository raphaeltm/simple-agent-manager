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

- [x] Add `session-tool-actions.ts` — `buildToolActions()` deriving the tool list from the same
      conditions the header uses today (workspace+active gate, `canMarkComplete`, `reportEnabled`,
      task presence), plus `ToolStripMode`, `nextMode`, `isGroupStart`.
- [x] Add `SessionToolRail.tsx` — icons / icons+labels / hidden tri-state, one cycling control,
      group dividers, comment badge, full-sentence `aria-label` on every button in icon mode.
- [x] Make `SessionHeader` disclosure state **controlled** (`expanded` + `onExpandedChange`), so
      the rail's Details action and the "+N more ports" chip drive the same panel.
- [x] Delete the action row from the disclosure (`SessionHeader.tsx:653-715`).
- [x] Delete the title-row Retry/Fork buttons and the chevron (`SessionHeader.tsx:274-311`).
- [x] Thread the new props through `FloatingHeader`.
- [x] Render the rail + gutter spacer in **both** `ProjectMessageView` branches; own `expanded`
      and `toolStripMode` state there; memoize the action array.
- [x] Persist the chosen mode across sessions (localStorage), defaulting to `icons`.
- [x] Delete `pages/chat-toolbar-prototype/`, its route, its `DEV_ONLY_ROUTE_PATHS` entry, and
      `tests/playwright/chat-toolbar-prototype-audit.spec.ts`.
- [x] Update the 3 unit test files and 7 Playwright specs to drive the rail.
- [x] New unit tests: `buildToolActions` per session state; rail renders/cycles/activates.
- [x] New Playwright audit against the **real** chat at 375×667 and 1280×800, with the
      mobile-overlay vs desktop-push gutter assertion proven discriminating.

## Acceptance criteria

- [x] All nine controls are reachable without opening any disclosure, in a session where they
      apply. Verified by a test that asserts each is visible on first paint.
- [x] The rail cycles icons → icons+labels → hidden → icons through its own control, and the
      hidden state still exposes a labelled pull-tab.
- [x] In icon-only mode every button has a full-sentence accessible name.
- [x] Labels mode overlays on mobile and pushes on desktop — asserted on the measured gutter,
      and proven to fail if the responsive branch is removed.
- [x] Opening session details does not evict the rail (assert on-screen coordinates).
- [x] Tools shown match session state: a sleeping session shows no Files/Git/Workspace; an
      active one does.
- [x] No horizontal overflow and no clipped overflow at 375px or 1280px.
- [x] The scroll-to-bottom button and comment selection controls do not collide with the rail.
- [x] No `/prototype/*` route or prototype page directory remains.
- [x] Full suite green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- [x] Staging: rail visible and every control works end-to-end on `app.sammy.party`, mobile and
      desktop, zero errors.

## References

- Prototype branch `sam/few-buttons-drop-down-fvckk5`, commit `d71d7e27c`
- Library `/design/chat-toolbar/` — writeup + 8 screenshot sheets
- Knowledge entity `ChatToolStrip` — the two layout traps, measured

## Review findings addressed (Phase 5)

Six local reviewers ran. Everything below was found by review and fixed in-branch.

| Reviewer | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| ui-ux, task-completion | CRITICAL | Below `lg` the messages container is `flex-col`, so the sibling gutter spacer reserved **no** horizontal space — the expanded details panel slid under the rail. Screenshots did not show it. | Rail is now a flex CHILD owning its own slot; the panel is absolute inside it. Caught by measuring the header's right edge against the rail's left edge; that assertion is now in the audit. |
| ui-ux | HIGH | Details and Complete were ordered last and fell below an easily-missed internal scroll on a short viewport — the two controls the rail exists to surface. Mobile usability scored 3/5. | `meta` group (Report/Complete/Details) pinned as a non-scrolling footer, mirroring the pinned mode-cycle header. New test asserts on-screen coordinates and that scrolling the list cannot move them. |
| architecture | HIGH | `onRetry`/`onFork` were inline arrows in `ProjectChat`, so the memoized action array never actually held — it rebuilt on every session-sync and provisioning poll tick. | Wrapped in `useCallback` with destructured deps. |
| architecture | HIGH | The referential-stability test passed an already-stable input object and re-rendered with the same reference — tautological. | Rewritten to rebuild the input object each render with stable field references, plus a control asserting the array DOES rebuild when a dependency changes. |
| test-engineer | HIGH | `does not collide with the scroll-to-bottom button` was guarded on `isVisible()`, which was false on all four viewports — the test executed **zero** assertions. | Seeds 60 messages and scrolls away from the bottom so the button really renders; the guard is now an `expect(...).toBeVisible()`. |
| test-engineer | HIGH | The in-flight `Completing…` / `disabled` state lost all coverage in the move. | Added tests for the disabled state, that a second click does not dispatch, and a control proving the enabled path does. |
| test-engineer | MEDIUM | `status: state === 'sleeping' ? 'active' : 'active'` — identical branches, so the sleeping scenario silently exercised `idle`. | Fixed; the sleeping state is now genuinely constructed. |
| test-engineer | MEDIUM | The overflow-reachability test only actually overflowed on one of four viewports; vacuous elsewhere. | Measures `scrollHeight` vs `clientHeight` and asserts the strong "already on screen" property when it fits. |
| test-engineer, task-completion | MEDIUM | Untested `buildSessionToolActions` branches: comment badge, no-workspace-while-active, terminated-with-workspace; accessible names only covered 6 of 10 controls. | All added; the accessible-name test now covers all ten. |
| constitution | MEDIUM | The rail's green `rgba(34,197,94,…)` literals are dark-mode-frozen and would render the wrong green in light theme; the audit never exercised light mode. | Swapped to the theme-aware `--sam-chrome-accent-*` family and added a light-theme audit pass. |
| ui-ux | MEDIUM | The rail's comment badge showed a neutral dot while the header chip showed amber "N needs you" for the same session. | `needsAttentionCommentCount` threaded through; badge tone and hint now match the chip. |
| architecture | LOW | `selectTool`'s switch had no exhaustiveness check — a new tool id could ship a control that silently does nothing. | `never`-typed default case. |
| architecture | MEDIUM | Retry/Fork gated on `session.task?.id ?? session.taskId` while Complete gated on `taskEmbed` — two signals for one question. | Both now read `taskEmbed` with a session-field fallback. |
| doc-sync | HIGH | Four public-doc locations, `.claude/rules/26`, and `CLAUDE.md` still described the chevron/action row. | All updated. |

### Deferred with rationale

- **Git vs Fork icon similarity** (ui-ux MEDIUM): both are node-and-line glyphs. Tooltips and
  full accessible names disambiguate, and they sit in different groups. Worth a design pass if
  it comes up in use; not worth churning the icon set pre-feedback.
- **No opaque scrim fallback behind the rail's `backdrop-filter`** (ui-ux LOW): the header needed
  one because Chromium does not sample composited scroll-container content. The rail's background
  sits at 88% opacity, so a silently no-op blur still leaves icons legible. Flagged for the
  staging pass in a real browser.
- **`SessionCommentChip` coexists with the rail's Comments action**: kept deliberately. Both call
  the same handler (no state to desync), the chip is the only comment signal that survives
  `hidden` mode, and it is the at-a-glance surface while scrolling. Urgency is now consistent
  between them.

## Staging verification record

Deploy `33341167162` on this branch: conclusion `success`.

Final Playwright pass against `app.sammy.party` at 375×667 and 1280×800: **16/16 green**
(`apps/web/tests/playwright/staging-tool-rail-verify.spec.ts`). Covered: rail renders on
first paint with no disclosure opened; pinned Report/Details on-screen by measured
coordinates; the icons → labels → hidden → icons cycle through the real control; Details
opening the real panel with the rail surviving the header growth; Timeline opening the
real drawer; no unexplained console errors or failed requests; and dashboard / projects /
settings still loading.

Three harness defects were fixed to get there, none of them product bugs:

1. **Self-inflicted rate limiting.** A `token-login` per test tripped the hourly limit.
   The session cookie is now captured once per worker and replayed. A KV delete of the
   limiter key was attempted per rule 32 but the CF token lacks KV write permission.
2. **An unactionable console assertion.** Chromium reports a failed request as a bare
   "Failed to load resource", so the spec now records the URL alongside it and asserts on
   the failed-REQUEST list. That is what identified the one 404 as
   `GET /api/workspaces/:id` for a reaped workspace — a fetch that is byte-identical on
   `origin/main` (`useSessionLifecycle.ts:407`), so pre-existing and unrelated.
3. **Coupled regression navigations.** Three `goto`s chained in one test meant the third
   could still be resolving its route chunk when the per-test clock expired, which read as
   "settings is broken" while every page rendered fine in isolation (verified standalone
   on both viewports before changing anything). Split into one test per page.

The spec skips itself when `SAM_PLAYWRIGHT_PRIMARY_USER` is absent so it can never run in
the CI sweep against shared staging — verified by running it with the variable unset:
8 skipped, 0 executed. `SAM_PLAYWRIGHT` appears nowhere in `.github/`.
