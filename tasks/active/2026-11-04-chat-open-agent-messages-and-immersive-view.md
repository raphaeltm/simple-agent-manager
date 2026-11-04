# Project chat: agent messages without a bubble, and an immersive conversation view on phones

## Problem

On a phone, an agent reply in project chat gets about 200px of a 390px screen. The losses are
the 80% bubble cap, the bubble padding, the 46px session tool rail, the frame padding and the app
bar plus session header above the conversation. Wide content (tables) is cut off. Raphaël asked
for agent messages without a bubble (only messages sent to the agent stay in bubbles) and a
button that slides the rest of the chrome away so only the conversation shows, with a tap to come
back. He tried an interactive prototype on branch `sam/love-new-ui-see-2sqw33` (commits
`c31a608db`, `533b641fa`) and said: "I love it. Ship it."

## Research Findings

- Agent replies render through `AcpMessageBubble` (`packages/acp-client/src/components/MessageBubble.tsx`)
  from `AcpConversationItemView.tsx` with `bubbleClassName="glass-msg-assistant"`. The bubble's
  layout (`max-w-[80%] rounded-lg px-4 py-3`) is hardcoded in `MessageBubble`, so the prototype
  had to override it with CSS. Production adds a real layout option instead.
- The SAM assistant chat (`components/sam/SamTurn.tsx`) already renders replies without a bubble,
  so this aligns project chat with it.
- Message rows use `sam-message-entry px-4` in
  `project-message-view/comments/CommentableConversationItem.tsx` and
  `pages/comment-reader/ReaderConversation.tsx`. On phones, 12px side padding gains 8px.
- Mobile chrome: `MobileAppBar` (`components/shell/MobileAppBar.tsx`, rendered by `AppShell` in
  `.sam-void flex flex-col gap-2.5 p-2.5`), the session header slab (`FloatingHeader.tsx`,
  `data-testid="session-floating-header"`), the tool rail (`SessionToolRail.tsx`, a wrapper `div`
  whose inline width reserves the gutter, plus the `aside`) and the composer
  (`SessionFooter.tsx`, `data-testid="session-footer"`).
- Desktop Focus Mode state is shared through `AppShellContext` (`lib/focus-mode.ts`, `AppShell.tsx`)
  and forced to `default` on mobile. Immersive state belongs in the same context, forced off on
  desktop.
- Jank lesson from the prototype: animating height/width/margin re-runs layout every frame, which
  makes react-virtuoso re-measure and re-wrap and every frosted pane re-blur. Traced at 4x CPU
  throttle: ~230ms main-thread JS during the enter slide, ~130ms on exit. The final approach pins
  each chrome piece with `position: fixed` at its measured rect, changes layout once, waits for
  the message list to stop scrolling, and slides with transform/opacity only (~10ms enter, ~40ms
  exit). Exit changes layout first too, so nothing jumps when the chrome lands.
- Tests that read the old bubble classes: `tests/playwright/project-chat-tool-group-audit.spec.ts`
  (tool card column vs `.glass-msg-assistant` parent), `markdown-chat-rendering-audit.spec.ts`
  (asserts the agent bubble's green border/shadow), `staging-tool-group-verify.spec.ts`
  (locates replies by `.glass-msg-assistant`), `packages/acp-client/tests/unit/components/MessageBubble.test.tsx`.
- Docs: `apps/www/src/content/docs/docs/guides/chat-features.md` covers the chat UI and tool rail.

## Implementation Checklist

- [ ] Remove prototype scaffolding: `pages/chat-surface-prototype/`, the boot import in
      `main.tsx`, the Proto pill in `MobileAppBar.tsx`, prototype hooks in `ConversationPane.tsx`
      and `AcpConversationItemView.tsx`
- [ ] `MessageBubble`: add a `layout` prop (`'bubble'` default, `'flush'`): flush drops the width
      cap, padding, rounding and the built-in surface colors; unit tests for both layouts
- [ ] `AcpConversationItemView`: agent messages use `layout="flush"` with a `glass-msg-agent`
      class (text color, desktop line-length cap); remove the unused `.glass-msg-assistant` style
- [ ] Message rows: `px-3 md:px-4` on phones in both row components
- [ ] `AppShellContext`: `chatImmersive` + `setChatImmersive`, forced off on desktop; mobile shell
      frame padding shrinks while immersive
- [ ] Mark the four chrome pieces with `data-immersive-chrome`; tool rail gutter collapses to 0
      while immersive; CSS hides any chrome piece that is not pinned while immersive (remount safety)
- [ ] Transition module (pin, single layout change via `flushSync`, settle, transform-only slide;
      exit layout-first); honours `prefers-reduced-motion`; resets on unmount and on leaving the
      phone layout
- [ ] Toggle button bottom-right of the conversation on phones (44px, aria-pressed, labels
      "Show only the conversation" / "Show the rest of the app"); the scroll-to-bottom button sits
      beside it
- [ ] Unit tests: toggle enter/exit through the real button, context forced off on desktop,
      reset on unmount, reduced motion
- [ ] Playwright audit (real chat page, mocked API): mobile toggle hides chrome and the
      conversation fills the screen (measured coordinates), toggle back restores; agent message
      spans the row; no overflow; desktop has no toggle; both themes; 375 and 1280 viewports
- [ ] Update the three Playwright specs that read `.glass-msg-assistant`
- [ ] Docs: chat-features.md section on agent messages and the phone full-conversation view

## Acceptance Criteria

- [ ] Agent replies in project chat have no bubble and span the message column (capped for line
      length on desktop); user messages keep their bubbles
- [ ] On a phone, the toggle slides away the app bar, session header, tool rail and composer; the
      conversation fills the screen; tapping again restores everything
- [ ] The transition animates only transform/opacity (no per-frame layout of the message list)
- [ ] The toggle does not render on desktop, and immersive state never strands the shell (resets
      on unmount / breakpoint change)
- [ ] No prototype code, routes or mock data remain
- [ ] Verified on staging on a phone viewport against a real chat

## References

- Prototype commits `c31a608db`, `533b641fa` on `sam/love-new-ui-see-2sqw33`
- `apps/web/.claude/rules/17-ui-visual-testing.md`, `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `apps/web/.claude/rules/80-sam-glass.md`, `apps/web/.claude/rules/48-stale-while-revalidate-ui.md`
