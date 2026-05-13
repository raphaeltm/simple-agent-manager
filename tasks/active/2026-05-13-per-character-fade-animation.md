# Per-Character Fade-In Text Animation

## Problem

Agent text currently arrives in visible 2-second chunks (matching the VM agent's `messagereport` batch interval). There is no client-side smoothing — text just pops in block by block. User messages appear instantly with no visual transition. Both feel jarring compared to modern chat UIs.

## Research Findings

### Current Architecture
- `TypewriterText` (`packages/acp-client/src/components/TypewriterText.tsx`): Word-by-word reveal using rAF loop. Returns raw text fragments — no markdown rendering, no per-character fade.
- `MessageBubble` (`packages/acp-client/src/components/MessageBubble.tsx`): Renders markdown via `react-markdown` + `remark-gfm` with syntax highlighting. No animation support.
- `AcpConversationItemView` (`apps/web/src/components/project-message-view/AcpConversationItemView.tsx`): When `animateText=true`, renders a hand-rolled bubble with `TypewriterText` inside a `whitespace-pre-wrap` div — bypasses `MessageBubble` entirely, losing markdown rendering.
- `ProjectMessageView` (`apps/web/src/components/project-message-view/index.tsx`): Gates `animateText` on `item.kind === 'agent_message' && index === lastAssistantIdx && lc.agentActivity === 'responding'`.
- User messages are optimistic (IDs start with `optimistic-`), created in `useSessionLifecycle.ts` lines 322-330.

### Key Design Decisions
- **Agent messages**: Rewrite `TypewriterText` to use character-level reveal + DOM-based post-render fade. Render through `react-markdown` so markdown formatting is preserved. Walk DOM with TreeWalker after render to wrap newest characters in `<span class="char-fade">`.
- **User messages**: New `UserMessageFade` component. Render each character as a `<span class="char-fade">` with staggered `animation-delay`. Adaptive timing: `charDelayMs = Math.min(1500 / text.length, 20)`.
- **CSS**: Add `.char-fade` keyframe animation to `apps/web/src/app.css`.
- **Accessibility**: Respect `prefers-reduced-motion` — skip animation entirely.
- **Performance**: Only animate last assistant message (already gated). Clean up spans after animation completes.

### Files to Modify
- `packages/acp-client/src/components/TypewriterText.tsx` — rewrite for char-level reveal
- `packages/acp-client/src/components/MessageBubble.tsx` — add `animated` prop
- `packages/acp-client/src/index.ts` — export new components/hooks
- `apps/web/src/components/project-message-view/AcpConversationItemView.tsx` — wire up
- `apps/web/src/components/project-message-view/index.tsx` — wire up user message fade
- `apps/web/src/app.css` — add `.char-fade` keyframes
- `packages/acp-client/tests/unit/components/TypewriterText.test.tsx` — update tests

## Implementation Checklist

- [ ] 1. Add `.char-fade` CSS animation keyframes to `apps/web/src/app.css` with `prefers-reduced-motion` override
- [ ] 2. Create `useStreamingReveal` hook in `packages/acp-client/src/hooks/` — rAF-based character reveal from buffered text
- [ ] 3. Rewrite `TypewriterText` to use character-level reveal + markdown rendering + DOM-based fade
- [ ] 4. Create `UserMessageFade` component in `packages/acp-client/src/components/` for adaptive user message fade-in
- [ ] 5. Export new hook and component from `packages/acp-client/src/index.ts`
- [ ] 6. Update `AcpConversationItemView` to use new `TypewriterText` (remove hand-rolled animated bubble)
- [ ] 7. Update `ProjectMessageView` / `AcpConversationItemView` to detect optimistic user messages and render with `UserMessageFade`
- [ ] 8. Update `TypewriterText` tests for new character-level behavior
- [ ] 9. Add tests for `useStreamingReveal` hook
- [ ] 10. Add tests for `UserMessageFade` component
- [ ] 11. Run Playwright visual audit (mobile + desktop) with mock data

## Acceptance Criteria

- [ ] Agent messages reveal character-by-character with per-character CSS fade-in (not word-by-word blocks)
- [ ] Agent messages still render full markdown (headings, code blocks, bold, lists)
- [ ] User messages fade in character-by-character on submit with adaptive timing (capped at 1.5s total)
- [ ] `prefers-reduced-motion` disables all animation — text appears instantly
- [ ] Only the last assistant message animates (others render instantly)
- [ ] No horizontal overflow on mobile (375px)
- [ ] Performance: DOM spans cleaned up after animation completes
- [ ] Existing TypewriterText tests updated and passing
- [ ] New tests for useStreamingReveal and UserMessageFade

## References

- SAM Idea: 01KRHCTRFP6P09RZEXNEHDAM07
- SAM Task: 01KRHCVSJR97X952JTF977GY97
- Defaults: agent char delay 20ms, fade 150ms, stagger 8ms; user max 1500ms, base 20ms
