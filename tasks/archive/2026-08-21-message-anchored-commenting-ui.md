# Message-anchored commenting production UI

## Problem

SAM needs the production web UI slice of the commenting MVP from idea
`01M0JQB842XSJ3W172DYPB37HN`. This constituent PR owns message-anchored comments
in the real project chat surface only. The backend contract will be reconciled by
the primary integration PR with sibling backend work `01M0K4EP5SND5CPK2N6GYS4449`,
so the web implementation must isolate and document its assumed contract.

Explicit constraints:

- Start from current `main` and work on branch `sam/build-production-web-ui-z72qrz`.
- Open a focused PR to `main`.
- Do not merge.
- Do not deploy to or mutate staging.
- Scope is message anchors only: no production file comments, fuzzy re-anchoring,
  mentions, reactions, global inboxes, or unrelated redesign.

## Research findings

- Idea `01M0JQB842XSJ3W172DYPB37HN` defines the MVP as message-anchored comments
  with thread body/replies, resolve/reopen, `open | sent | resolved` status,
  send-to-agent as a distinct action from note-only comments, desktop rail
  at `>=1024px`, and mobile inline expansion.
  - Checklist coverage: thread model, send/note composer, rail/inline UI,
    status and marker items below.
- Prototype branch `sam/really-get-feature-talked-5ckt0s` validated the core
  interaction under `apps/web/src/pages/comments-prototype/`.
  `useCommentSelection.ts` uses debounced `selectionchange` as the primary
  trigger because mobile long-press and selection-handle changes do not reliably
  produce mouse/touch terminal events. Desktop gets a floating chip; touch gets a
  bottom action bar that does not fight native OS selection UI.
  - Checklist coverage: selection hook, desktop and mobile Playwright tests with
    actual selection.
- Production chat renders in
  `apps/web/src/components/project-message-view/index.tsx`. Each `Virtuoso` row
  already has `item.id` in scope and wraps `AcpConversationItemView` in
  `.sam-message-entry`; this is the correct anchor hook point. Do not modify
  `MessageBubble` for anchoring.
  - Checklist coverage: row wrapper integration, preservation tests for existing
    chat behavior.
- `ProjectMessageView` uses `react-virtuoso`; offscreen rows are unmounted.
  The desktop comment rail must be driven from fetched comment data, not from
  mounted DOM rows. The retained timeline-jump post-mortem in
  `tasks/archive/2026-07-03-chat-full-load-timeline-jump.md` shows why tests
  must assert virtualization coordinates/behavior rather than only checking
  rendered rows.
  - Checklist coverage: data-driven rail, offscreen/virtualization unit and
    Playwright coverage.
- Existing data-fetching guidance in `.claude/rules/48-stale-while-revalidate-ui.md`
  requires new web fetch surfaces to use TanStack Query with identity-scoped keys
  and stale-while-revalidate behavior. Existing query keys live in
  `apps/web/src/lib/query-options/chats.ts`; REST client helpers live in
  `apps/web/src/lib/api/`.
  - Checklist coverage: isolated API client and query layer.
- `useChatWebSocket` currently handles chat/session event types. Comment realtime
  reconciliation should be a narrow hook that accepts documented comment event
  payloads and updates the query cache without replacing chat message flow.
  - Checklist coverage: optimistic updates and realtime reconciliation hooks.
- `packages/ui` has `Button`, `Dialog`, `Input`, `Tooltip`, etc. It has no
  generic `Avatar`, `Textarea`, or interactive anchored `Popover`. The prototype
  hand-built these gaps. Add reusable primitives only where the implementation
  has a generic need and keep comment-specific pieces in `apps/web`.
  - Checklist coverage: UI primitive additions or explicit local rationale.
- `.claude/rules/17-ui-visual-testing.md`,
  `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`, and
  `.claude/rules/62-tests-must-observe-the-real-trigger.md` require Playwright
  audits that drive real user actions, check clipped overflow, and inspect
  screenshot evidence instead of only proving DOM presence.
  - Checklist coverage: Playwright visual/behavior audit at 375x667 and 1280x800.
- Constitution Principle XI means body/quote storage limits belong in the server
  contract with backend configurability. The web may have display caps to protect
  layout, but must not imply reader-side truncation is the write boundary.
  - Checklist coverage: contract documentation and no hardcoded operational
    server limits in the UI.

## Implementation checklist

- [x] Document the assumed message-comment server contract for the backend
      integrator, including endpoint paths, payload shapes, event types,
      optimistic IDs, status semantics, and write-boundary limit assumptions.
- [x] Add an isolated typed comment API client under `apps/web/src/lib/api/`.
- [x] Add TanStack Query options/hooks for listing threads by project/session,
      creating a thread, replying, resolving, reopening, sending to agent, and
      applying realtime comment events with optimistic reconciliation.
- [x] Add generic `packages/ui` primitives only where justified by the production
      implementation, likely `Avatar`, `Textarea`, and an interactive anchored
      `Popover`; keep comment-specific markers/composers local to chat.
- [x] Add production comment types and utilities for message anchor filtering,
      status labels, relative time, author display, and optimistic IDs.
- [x] Add a message-selection hook using debounced `selectionchange` as primary
      trigger, preserving native browser selection and supporting keyboard,
      desktop pointer selection, and mobile long-press/selection-handle flows.
- [x] Integrate message anchors into `ProjectMessageView` row wrappers without
      modifying `MessageBubble` and without changing existing chat streaming,
      composer, scroll, header, timeline, or virtualization behavior.
- [x] Add create-thread composer with selected quote, comment body, explicit
      note-only and send-to-agent actions, cancel behavior, focus management,
      `Ctrl/Cmd+Enter`, and screen-reader labels.
- [x] Add thread UI with body, quoted anchor, replies, reply composer,
      resolve/reopen, `open | sent | resolved` status, loading/error/empty
      states, and optimistic pending/error affordances.
- [x] Add count marker/accent on commented messages with unresolved vs resolved
      state and no permanent mobile gutter clutter.
- [x] Add a desktop rail at `>=1024px` driven solely by comment data and active
      anchor state, not mounted virtual rows.
- [x] Add mobile inline expansion with touch-friendly controls and responsive
      overflow safety.
- [x] Add realtime reconciliation hooks for documented comment WebSocket events,
      keeping the query cache and optimistic rows server-authoritative.
- [x] Add unit/component tests for selection, query/client transformations,
      create/reply/resolve/reopen/send flows, accessibility/focus, and
      virtualization/offscreen behavior.
- [x] Add Playwright tests on the real project chat route with mocked API data at
      375x667 and 1280x800, including actual selection, create, reply, resolve,
      reopen, send-to-agent, mobile layout, desktop rail, offscreen/virtualized
      anchors, focus behavior, loading/error/empty states, and screenshots in
      `.codex/tmp/playwright-screenshots/`.
- [x] Run local quality gates: relevant targeted tests during development, then
      `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- [x] Run required local specialist reviews: `ui-ux-specialist`,
      `test-engineer`, accessibility review, `constitution-validator`,
      `doc-sync-validator`, and `task-completion-validator`.
- [x] Open the constituent PR to `main`, preserve "do not merge" and
      "no staging" constraints in the PR body, and leave it open.

## Acceptance criteria

- [x] A user can select text in a visible agent or user message and create a
      quoted comment without losing native selection behavior.
- [x] Desktop pointer selection shows an anchored affordance; mobile/coarse
      pointer selection shows a bottom action bar and preserves OS selection
      handle behavior.
- [x] A user can create a note-only comment or explicitly send a comment to the
      agent; the UI reflects `open` vs `sent`.
- [x] A user can reply to a thread, resolve it, reopen it, and see resolved
      threads represented without hiding their existence.
- [x] Commented messages show count/accent state, including unresolved vs
      resolved distinction, without cluttering mobile gutters.
- [x] Desktop `>=1024px` shows a comment rail backed by comment data, including
      comments for offscreen messages.
- [x] Mobile uses inline thread expansion and remains usable at 375x667 with no
      clipped horizontal overflow.
- [x] Loading, error, and empty states are visible and accessible.
- [x] Keyboard and screen-reader users can start, submit, cancel, navigate, and
      manage comments with visible focus and clear labels.
- [x] Optimistic create/reply/status actions reconcile with documented server
      responses and realtime events.
- [x] Existing project chat behavior, scrolling, composer, streaming, file links,
      timeline drawer, and virtualization continue to work.
- [x] The exact assumed backend contract is documented in the PR and in-repo.
- [x] Unit/component and Playwright tests cover the critical flows and viewports.
- [x] Staging deployment is intentionally skipped by explicit user instruction.

## Specialist review findings

- `ui-ux-specialist`: PASS. Screenshot-backed desktop 1280x800 and mobile
  375x667 audits verify the data-backed rail, mobile inline threads, visible
  loading/error/empty states, touch-sized controls, and no horizontal overflow.
- `test-engineer`: PASS. Coverage includes typed API transforms, optimistic
  cache reconciliation, actual DOM/browser selection, create/reply/send/resolve/
  reopen flows, realtime upsert, offscreen/virtualized message comments, and UI
  primitive tests.
- Accessibility review: PASS with one documented MVP caveat. The floating
  desktop selection chip is a transient pointer affordance, not a trapped modal;
  keyboard users have an always-focusable row Comment path, composer autofocus,
  labelled textareas/radios/buttons, Escape cancel, `Ctrl/Cmd+Enter`, alerts,
  visible focus, and screen-reader labels.
- `constitution-validator`: PASS. Server write-boundary limits are documented as
  backend-configurable; UI constants are display/interaction caps only. No
  production file comments, fuzzy re-anchoring, mentions, reactions, inboxes, or
  staging/deploy changes were introduced.
- File-size review: PASS/WARN. The modified chat entrypoint was reduced from
  966 lines to 786 lines, below the mandatory 800-line ceiling, by extracting
  comment row/rail wiring and session helper utilities. Remaining 500+ line
  files in the diff are legacy candidate-size files or test files.
- `doc-sync-validator`: PASS. The assumed server contract is documented in
  `specs/035-message-comments/contracts/message-comment-api.md`; API/query
  exports and WebSocket event names match that contract.
- `task-completion-validator`: PASS/WARN. The task file research/checklist,
  acceptance criteria, diff, and tests align. The only vertical-slice caveat is
  intentional: backend persistence is owned by sibling task
  `01M0K4EP5SND5CPK2N6GYS4449`, so this PR uses a documented UI contract and
  stateful API-boundary Playwright mocks.

## Evidence log

- Constituent PR left open: <https://github.com/raphaeltm/simple-agent-manager/pull/1880>
  (`sam/build-production-web-ui-z72qrz` -> `main`), with explicit "do not
  merge" and "do not deploy to staging" instructions in the PR body.
- Targeted unit/component tests:
  `pnpm --filter @simple-agent-manager/web test -- tests/unit/api/comments.test.ts tests/unit/components/message-comments.test.tsx tests/unit/components/project-message-view.test.tsx tests/unit/components/chat/project-message-view-resume.test.tsx`
  — 94 tests passed.
- UI primitive tests:
  `pnpm --filter @simple-agent-manager/ui test` — 12 test files and 104 tests
  passed, including direct coverage for new Avatar, Textarea, and Popover
  primitives.
- Targeted browser audit:
  `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/message-comments-audit.spec.ts --project='Desktop (1280x800)'`
  — 3 tests passed, covering desktop 1280x800 and mobile 375x667 via per-test viewport overrides.
- Screenshot evidence:
  `.codex/tmp/playwright-screenshots/message-comments-desktop-thread-flow-1280x800.png`,
  `.codex/tmp/playwright-screenshots/message-comments-desktop-error-state-1280x800.png`,
  `.codex/tmp/playwright-screenshots/message-comments-desktop-empty-state-1280x800.png`,
  `.codex/tmp/playwright-screenshots/message-comments-mobile-inline-send-375x667.png`.
- Targeted gates:
  `pnpm --filter @simple-agent-manager/web typecheck` passed;
  `pnpm --filter @simple-agent-manager/web lint` passed with three pre-existing warnings;
  `pnpm --filter @simple-agent-manager/ui typecheck && pnpm --filter @simple-agent-manager/ui lint` passed.
- Root gates:
  `pnpm test` passed before the final import-sort-only amend — 21/21 turbo
  tasks, web 284 test files and 3410 tests passed, API 583 test files and 7880
  tests passed. After the final amend, the focused 94-test web suite passed and
  root `pnpm build` passed — 9/9 turbo tasks; root `pnpm lint` passed — 13/13
  turbo tasks, with only pre-existing warnings in `packages/acp-client` and
  unrelated web files; root `pnpm typecheck` passed — 19/19 turbo tasks, with
  the existing Astro template baseline report for `apps/www`.
- Stabilized existing `useSessionTimeline` unit test race found by the first
  root `pnpm test` run by waiting for the derived timeline entry before
  asserting; isolated and root reruns passed.

## References

- SAM idea `01M0JQB842XSJ3W172DYPB37HN`
- Prototype branch `sam/really-get-feature-talked-5ckt0s`
- `apps/web/src/components/project-message-view/index.tsx`
- `apps/web/src/components/project-message-view/useSessionLifecycle.ts`
- `apps/web/src/hooks/useChatWebSocket.ts`
- `apps/web/src/lib/query-options/chats.ts`
- `packages/acp-client/src/components/MessageBubble.tsx`
- `packages/ui/src/components/`
- `tasks/archive/2026-07-03-chat-full-load-timeline-jump.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/48-stale-while-revalidate-ui.md`
- `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
