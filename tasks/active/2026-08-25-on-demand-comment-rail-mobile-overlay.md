# On-demand comment rail and mobile selected-text composer

## Problem

Desktop chat commenting is currently broken for both message-level and selected-text entry points. Clicking a message's `Comment` button or the selected-text `Comment` popover starts draft state, but desktop hides the inline message comment panel at `lg`, so no visible composer appears. The header/dropdown `Comments` control opens the session comments drawer, but that surface is a side overlay rather than an in-layout rail, so users cannot comfortably read the chat and comments at the same time.

Mobile commenting is usable, but selected-text drafts render below the source message. For selected quotes this forces the user to scroll away from the selected text and lose context while composing.

## Research findings

- `apps/web/src/components/project-message-view/comments/MessageCommentPanels.tsx` contains the active message action row and `InlineMessageComments`. Inline comments are wrapped in `lg:hidden` by `CommentableConversationItem`, which explains the desktop no-op: draft state exists, but the only composer is hidden.
- `apps/web/src/components/project-message-view/comments/useProjectMessageCommentUi.tsx` owns `activeMessageId`, `draft`, selected-text controls, and row actions. This is the right state boundary for opening the desktop rail when a comment entry point is used.
- `apps/web/src/components/project-message-view/index.tsx` owns `showComments` and lays out the chat as `lg:flex-row`. A desktop rail belongs in this in-layout flex row so the chat and comments are visible simultaneously instead of overlaying each other.
- `apps/web/src/components/chat/SessionCommentsDrawer.tsx` is currently a portal `<dialog>` with mobile fullscreen and desktop right-side drawer geometry. It remains useful for mobile session-level comment browsing, but desktop needs a non-modal rail for the current request.
- Prior task `tasks/active/2026-08-24-project-comment-inbox-endpoint.md` documents that an always-visible desktop rail was removed after Raphaël rejected it. This task supersedes only that always-visible behavior: the rail should return as an on-demand surface, not as permanent chrome.
- Prior task `tasks/active/2026-08-24-fix-comments-navigation-followup.md` and rule `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md` show that drawer/panel geometry must be validated with real browser screenshots and clipped-overflow checks.
- Rule `.claude/rules/62-tests-must-observe-the-real-trigger.md` requires tests to click the same controls users click. Coverage must drive selected text, message-level comment buttons, and header/dropdown comments controls, not directly set component props.
- UI skill requirements require 2-3 layout variants, mobile-first behavior, screenshot evidence at 375x667 and 1280x800, and rubric scores >=4.

## Layout variants considered

1. **Portal drawer everywhere**: keep `SessionCommentsDrawer` and make message buttons open it. This fixes the visible no-op but still prevents comfortable side-by-side chat/comment reading on desktop.
2. **Docked rail only**: replace the drawer with a permanent in-layout comments rail. This restores side-by-side desktop reading but repeats the always-visible rail that was explicitly rejected.
3. **Responsive comments surface**: keep comments hidden until requested; at `lg` render an in-layout docked rail, below `lg` keep mobile drawer/inline behavior, and move selected-text draft composition into a bottom-fixed mobile overlay. This matches the current request and preserves the prior rejection of permanent rail chrome.

Selected direction: variant 3.

## Implementation checklist

- [x] Reintroduce a desktop comment rail as an on-demand in-layout `aside`, with a close button and no modal backdrop.
- [x] Ensure desktop header/dropdown `Comments`, message-level `Comment`, selected-text `Comment`, and comment count markers open the rail.
- [x] Keep the rail hidden until a comment control is clicked.
- [x] Render active/draft comments in the rail on desktop, including loading, error, retry, empty, reply, resolve/reopen, and send-to-agent paths.
- [x] Keep existing mobile whole-message inline commenting behavior.
- [x] For mobile selected-text drafts, render the composer fixed at the bottom over the normal chat input so the chat remains scrollable behind it.
- [x] Add/update unit tests for desktop rail visibility, message-button/selection/header entry points, and mobile selected-text bottom composer behavior.
- [x] Update Playwright audit coverage to exercise the real user triggers at 1280x800 and 375x667, including screenshots and overflow checks.
- [x] Run local validation: focused unit tests, focused Playwright audit, then full lint/typecheck/test/build gates.
- [x] Run specialist review: `ui-ux-specialist`, `test-engineer`, `constitution-validator`, and `task-completion-validator`; address blockers.
- [x] Upload screenshots to the project library for review.
- [x] Deploy to staging and verify the comments UX end to end.
- [ ] Create PR, wait for CI, and monitor deploy after merge if normal gates authorize it.

## Implementation notes

- Split `FloatingHeader` out of `project-message-view/index.tsx`, reducing the main chat component from 850 to 741 lines during this PR.
- Added a retained lesson to `.claude/rules/17-ui-visual-testing.md` requiring responsive/on-demand surfaces to be proved visible from every public entry point at the viewport where the action is available.

## Validation log

- `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/project-message-view.test.tsx` — passed, 66 tests.
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/message-comments-audit.spec.ts --project "Desktop (1280x800)" --project "iPhone SE (375x667)"` — passed, 10 tests.
- `pnpm lint` — passed with existing warnings.
- `pnpm typecheck` — passed.
- `pnpm test` — passed.
- `pnpm build` — passed.
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/message-comments-audit.spec.ts --project "Desktop (1280x800)" --project "iPhone SE (375x667)"` — passed again after the final accessibility cleanup, 10 tests.
- `gh workflow run deploy-staging.yml --ref sam/chat-ui-desktop-broken-x7a6h9` — staging deploy run `32872775053` passed, including post-deploy smoke tests.
- `PLAYWRIGHT_BASE_URL=https://app.sammy.party pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/staging-comment-rail-verification.spec.ts --project "Desktop (1280x800)"` — temporary live-staging verifier passed, 2 tests. Verified desktop rail from message/selected-text/header controls and mobile fixed selected-text composer with real staging comment API writes.
- `doc-sync-validator` review of `.claude/rules/17-ui-visual-testing.md` — passed. The new process note references existing code/test paths and matches this PR's behavior and validation evidence.
- `gh workflow run deploy-staging.yml --ref sam/chat-ui-desktop-broken-x7a6h9` — exact-head staging deploy run `32876032734` passed at SHA `bb7288d39`, including post-deploy smoke tests.
- `pnpm --filter @simple-agent-manager/web exec node --input-type=module <exact-head live comments verifier>` — passed against `https://app.sammy.party`. Rechecked desktop selected-text rail and mobile bottom composer on the exact-head deployment.

## Review log

- `ui-ux-specialist` review — pass. The selected responsive layout is the on-demand rail plus mobile selected-text bottom composer. Screenshot review covered 1280x800 desktop rail thread/error/empty states and 375x667 mobile composer states; no horizontal overflow or clipped visible controls were found.
- `test-engineer` review — pass. Unit tests cover header/dropdown, message-level, selected-text, desktop rail hidden-by-default, desktop create, and mobile selected-text overlay behavior. Playwright tests exercise the real user triggers and verify chat scrolling behind the fixed mobile composer.
- `constitution-validator` review — pass. New constants are presentational UI geometry/breakpoint values tied to Tailwind responsive behavior and screenshot tests; no new endpoints, secrets, provider IDs, business limits, or deployment-owned configuration were hardcoded.
- `doc-sync-validator` review — pass. The durable rule update is scoped to the bug class fixed here and does not introduce stale file references or inaccurate behavior claims.
- `task-completion-validator` review — pass for completed phases. Checklist items through local validation, specialist review, and screenshot upload are reflected in the diff and validation evidence. Staging, PR, CI, and post-merge monitoring remain pending.

## Uploaded screenshots

- `01M0WW8WMQ5323ZGVAQQHX2GHW` — `message-comments-desktop-thread-flow-1280x800.png`
- `01M0WW8ZD9JQG8JK0K2BXVGS1A` — `message-comments-desktop-error-state-1280x800.png`
- `01M0WW924DMK9HPY9HYN25F8CS` — `message-comments-desktop-empty-state-1280x800.png`
- `01M0WW94V859QG68DSXG2G143Z` — `message-comments-mobile-voice-idle-375x667.png`
- `01M0WW97EP00YM2DHQREK522YC` — `message-comments-mobile-bottom-composer-send-375x667.png`
- `01M0WY32WXTSXSSZKPGABYS658` — `staging-comments-desktop-rail-1280x800.png`
- `01M0WY35PJACF0NP1YE4ZVG61N` — `staging-comments-mobile-bottom-composer-375x667.png`
- `01M0WY39G0R11VEXYAYD1HGPD6` — `staging-comments-mobile-thread-after-send-375x667.png`
- `01M0WZ9XMVJZBFH4K7QET6WR0F` — `staging-exacthead-comments-desktop-rail-1280x800.png`
- `01M0WZA1SH67SH4RVWGF9AY2J6` — `staging-exacthead-comments-mobile-bottom-composer-375x667.png`

## Acceptance criteria

- Desktop does not show a comments rail by default.
- Desktop selected-text `Comment` opens a visible composer in a docked comments rail.
- Desktop message-level `Comment` opens a visible composer in the docked comments rail.
- Desktop header/dropdown `Comments` opens the docked comments rail and keeps the chat readable beside it.
- Existing desktop comment threads can be read, replied to, resolved/reopened, and sent to the agent from the rail.
- Mobile selected-text `Comment on selection` opens a fixed bottom composer overlay above the normal chat input; the chat can still scroll while the composer is visible.
- Mobile whole-message commenting remains inline under the message.
- The changed surfaces have screenshot-backed validation at 375x667 and 1280x800 with no horizontal or clipped overflow.
- Screenshots are uploaded to the project library for review.
