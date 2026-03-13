# Copy Message Button

## Problem

Agent messages currently have two action buttons (info and read aloud). Users need a third button to copy the message contents to their clipboard.

## Research Findings

- **Component**: `packages/acp-client/src/components/MessageActions.tsx`
- **Test file**: `packages/acp-client/src/components/MessageActions.test.tsx`
- **Parent**: `MessageBubble.tsx` renders `MessageActions` for agent messages
- **Pattern**: Buttons use inline SVG icons, `var(--sam-color-*)` CSS variables, 32x32 min touch targets
- **Existing buttons**: Info (toggle popover), Speaker (toggle TTS via Web Speech API)
- The `text` prop already contains the raw message content needed for copying

## Implementation Steps

- [ ] Add copy button with clipboard icon SVG to `MessageActions.tsx`
- [ ] Use `navigator.clipboard.writeText()` API with brief "Copied" visual feedback
- [ ] Add unit tests for the copy button in `MessageActions.test.tsx`
- [ ] Update `MessageBubble.test.tsx` to assert copy button presence
- [ ] Run lint, typecheck, and tests

## Acceptance Criteria

- [ ] Copy button appears alongside info and speaker buttons on agent messages
- [ ] Clicking copy button copies the raw message text to clipboard
- [ ] Brief visual feedback (icon change or color) indicates successful copy
- [ ] Button has proper aria-label for accessibility
- [ ] All existing tests still pass
- [ ] New tests cover: copy success, feedback reset, clipboard API unavailable
