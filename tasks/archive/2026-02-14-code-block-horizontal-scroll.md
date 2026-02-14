# Code Block Horizontal Scroll in Agent Responses

**Created**: 2026-02-14
**Priority**: Medium
**Relates to**: ChatSession component, agent response rendering

## Summary

When the agent responds with a markdown code block, it renders correctly but cannot be horizontally scrolled. On mobile (and narrow viewports), long lines are clipped and the user can only see a small portion of the block.

## Context

Agent responses are rendered with markdown support in the `ChatSession.tsx` component. Code blocks (triple-backtick fenced blocks) render with proper syntax styling, but the container does not allow horizontal scrolling. This is especially painful on mobile where screen width is limited.

## Expected Behavior

- Code blocks should horizontally scroll when content exceeds the container width
- Touch swipe should work for horizontal scroll on mobile
- The surrounding message content should NOT horizontally scroll (only the code block itself)

## Implementation Notes

- Investigate the `<pre>` / `<code>` styling in the markdown renderer
- Likely fix: `overflow-x: auto` on the code block container, with `white-space: pre` to prevent wrapping
- Ensure the fix works for both inline and fenced code blocks
- Test on mobile viewport (375px width) with a wide code block (e.g., 120+ character lines)
