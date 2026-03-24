# User Message Actions (Copy + Info)

## Problem

User-sent messages in the chat UI have no action buttons. Agent messages already have info (metadata popover), TTS (read aloud), and copy buttons via the `MessageActions` component. The user wants the same info and copy buttons on user messages, but without TTS.

## Research Findings

- **MessageBubble** (`packages/acp-client/src/components/MessageBubble.tsx`): Line 149 gates actions on `isAgent` — user messages never show `MessageActions`.
- **MessageActions** (`packages/acp-client/src/components/MessageActions.tsx`): Renders info, TTS speaker, and copy buttons. TTS conditionally renders based on `showSpeaker` but always shows browser fallback if `window.speechSynthesis` exists.
- **Color mismatch**: User messages have blue background (`bg-blue-600 text-white`). Button colors use `var(--sam-color-fg-muted)` (gray) — invisible on blue. Need a `variant` prop for on-dark styling.
- **Metadata popover**: Absolutely positioned with own background — works on both light and dark contexts.

## Implementation Checklist

- [ ] Add `hideTts?: boolean` prop to `MessageActionsProps` to suppress TTS button + audio player
- [ ] Add `variant?: 'default' | 'on-dark'` prop to `MessageActionsProps` for color scheme
- [ ] Implement on-dark color scheme: `rgba(255,255,255,0.7)` inactive, `white` active
- [ ] Modify `showActions` in `MessageBubble` to include user messages (when not streaming and timestamp exists)
- [ ] Pass `hideTts` and `variant="on-dark"` for user messages in `MessageBubble`
- [ ] Update `MessageActions` tests for new props
- [ ] Update `MessageBubble` tests to verify user messages render actions
- [ ] Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] User messages show info button that opens metadata popover (timestamp, words, characters)
- [ ] User messages show copy button that copies text with checkmark confirmation
- [ ] User messages do NOT show TTS/speaker button
- [ ] Button colors are visible and contrast well on blue background
- [ ] Existing agent message actions unchanged
- [ ] All tests pass

## References

- `packages/acp-client/src/components/MessageBubble.tsx`
- `packages/acp-client/src/components/MessageActions.tsx`
- `packages/acp-client/src/components/MessageActions.test.tsx`
- `packages/acp-client/src/components/MessageBubble.test.tsx`
