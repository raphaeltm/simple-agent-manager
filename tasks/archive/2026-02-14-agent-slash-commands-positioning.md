# Fix Agent Slash Command Positioning

## Summary

The agent slash command suggestions currently overlay and cover the text input, especially on mobile. They should be positioned above the text input instead, and long command text should wrap correctly rather than being clipped or overflowing.

## Current Behavior

- Slash command suggestions appear on top of the text input, blocking what the user is typing
- On mobile (the primary use case), this makes the input unusable when suggestions are visible
- Long command text may not wrap properly

## Desired Behavior

- Slash command suggestions appear **above** the text input, not overlapping it
- The text input remains fully visible and usable while suggestions are shown
- Long suggestion text wraps cleanly within the suggestion container
- Works well on mobile viewports (320px+)

## Implementation Notes

### Key Files

- Look in `apps/web/src/components/` or `packages/vm-agent/ui/` for the ACP chat input and slash command suggestion components

### UI Requirements

- Position suggestions above the input (e.g. `bottom: 100%` or flex column-reverse)
- Ensure suggestions don't extend off-screen on small viewports
- Text wrapping: `word-break: break-word` or similar to prevent horizontal overflow
- Max height with scroll if there are many suggestions
- Touch-friendly suggestion items (min 44px tap targets per mobile guidelines)
