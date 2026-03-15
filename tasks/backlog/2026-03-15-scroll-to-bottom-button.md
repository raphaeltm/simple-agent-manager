# Add "Scroll to Bottom" Button in Project Chat

## Problem

When autoscroll is paused (user scrolled up), there is no visible indicator that new messages are arriving below, and no quick way to jump back to the bottom other than manual scrolling. This is especially noticeable during active agent runs with streaming output.

## Context

Discovered during UI/UX review of the autoscroll pause feature (PR for `sam/manually-scroll-project-chat-01kksj`). The autoscroll pause mechanism works correctly but lacks a visual affordance.

## Proposed Solution

Add a floating "scroll to bottom" pill button (Variant B from UI/UX review):
- Position: absolute, bottom-right of the scroll container
- Icon: ChevronDown from lucide-react
- Optional: "New messages" label or unread count badge
- Clicking scrolls to bottom and sets `isStuckToBottomRef.current = true`
- Only visible when `isStuckToBottomRef.current === false`

Reference: This is the pattern used by Slack, Discord, Linear chat, and GitHub Copilot Chat.

## Acceptance Criteria

- [ ] Floating button appears when user scrolls up and autoscroll is paused
- [ ] Button disappears when user scrolls back to bottom
- [ ] Clicking button scrolls to bottom and re-enables autoscroll
- [ ] Button does not overlap message content or input area
- [ ] Accessible: button has appropriate aria-label
