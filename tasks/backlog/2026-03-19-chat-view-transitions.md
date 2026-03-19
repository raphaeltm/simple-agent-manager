# Add View Transitions to Chat Send Action

**Created**: 2026-03-19
**Priority**: Low
**Classification**: `ui-change`

## Problem

When a user sends a message, the text disappears from the input and appears as a message bubble. This transition is instant and abrupt. Modern chat UIs use CSS View Transitions to create a smooth morph effect from textarea to message bubble, making the interaction feel polished and intentional.

## Context

- Part of broader polish effort to make SAM feel premium
- Connects to the LOTR/Sam theming initiative for personality and delight
- CSS View Transitions API is well-supported in modern browsers (Chrome, Edge, Safari)
- Low priority but high-impact for perceived quality

## Technical Approach

Use the CSS View Transitions API (`document.startViewTransition()`) on message send:

1. On submit, give the textarea a `view-transition-name` with a unique index
2. Call `document.startViewTransition()`
3. In the new state, apply the same `view-transition-name` to the newly appended message bubble
4. Browser automatically morphs the textarea content into the message position

This creates a smooth animation where the typed text visually "moves" from the input to the message list.

### References

- [LLM Chat Prototype with View Transitions (nerdy.dev, Jul 2025)](https://nerdy.dev/llm-chat-prototype)
- [CSS View Transitions API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API)

### Fallback

For browsers without View Transitions support, the current instant behavior is fine — wrap in `if (document.startViewTransition)` check.

## Acceptance Criteria

- [ ] Sending a message creates a smooth visual transition from input to message bubble
- [ ] Transition works for both short and long messages
- [ ] No layout thrash during the transition
- [ ] Graceful fallback in unsupported browsers (instant append, no errors)
- [ ] Animation duration feels natural (200-300ms)
- [ ] Works correctly with optimistic message rendering
