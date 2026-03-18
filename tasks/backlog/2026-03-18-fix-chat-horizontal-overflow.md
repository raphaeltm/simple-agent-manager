# Fix Horizontal Overflow in Project Chat

## Problem

Project chat layout breaks with horizontal overflow when messages contain long file names, tool call paths, or other unbreakable content. This squishes icons/symbols on either side of tool calls and causes the entire chat view to scroll horizontally.

## Research Findings

### Root Causes

1. **ToolCallCard header** (`packages/acp-client/src/components/ToolCallCard.tsx`):
   - Header uses `flex items-center justify-between` but lacks `min-w-0` on flex children
   - File path span uses `truncate` but without `min-w-0` on its parent, truncation can't kick in
   - Long tool names + file paths push the layout wider than the container
   - Status icon and chevron get squished

2. **MessageBubble** (`packages/acp-client/src/components/MessageBubble.tsx`):
   - Prose wrapper uses `overflow-y-visible` which doesn't constrain horizontal overflow
   - Bubble container (`max-w-[80%]`) lacks `overflow-hidden` to clip child content
   - No `min-w-0` on the bubble div (flex child)
   - Long inline code (file paths) in markdown has no word-break

3. **FileDiffView** (`packages/acp-client/src/components/FileDiffView.tsx`):
   - Lines use `whitespace-pre` but the outer container only has `overflow-x-auto`
   - Missing `max-w-full` or width constraint means it can push parent wider

4. **TerminalBlock** (`packages/acp-client/src/components/TerminalBlock.tsx`):
   - Command header has no overflow handling for long commands

5. **ProjectMessageView** (`apps/web/src/components/chat/ProjectMessageView.tsx`):
   - Messages container at line 835 lacks `min-w-0` as a flex child

### CSS Best Practices for Flex Overflow

- Flex items default to `min-width: auto`, preventing shrinking below content size
- Adding `min-w-0` to flex children allows text truncation/wrapping to work
- `overflow-wrap: anywhere` breaks long strings like file paths at any character
- `overflow-x-auto` on preformatted content containers enables horizontal scroll without pushing parent wider
- `overflow-hidden` on message bubbles clips any child overflow

## Implementation Checklist

- [ ] **ToolCallCard.tsx**: Add `min-w-0` to both flex children in header; add `min-w-0` to file path span parent; restructure header so file path can shrink properly
- [ ] **MessageBubble.tsx**: Add `min-w-0 overflow-hidden` to bubble container; change prose wrapper from `overflow-y-visible` to `overflow-x-auto`; add `break-words` utility
- [ ] **FileDiffView.tsx**: Add `max-w-full` to outer container to prevent it from expanding parent
- [ ] **TerminalBlock.tsx**: Add overflow handling to command header (truncate or wrap long commands)
- [ ] **ProjectMessageView.tsx**: Add `min-w-0` to messages container flex child if missing
- [ ] **ToolCallCard content area**: Ensure tool output text container constrains overflow
- [ ] Add/update tests for overflow behavior (render tests with long content)
- [ ] Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] Long file paths in tool calls do not cause horizontal overflow
- [ ] Tool call icons (status, chevron) maintain their size and are not squished
- [ ] Long markdown content (inline code, URLs) wraps or scrolls within the message bubble
- [ ] Diff views scroll horizontally within their container, not the whole chat
- [ ] Terminal output with long lines does not push the chat wider
- [ ] No visual regressions in normal-length content

## References

- CSS flexbox min-width: https://drafts.csswg.org/css-flexbox-1/#min-size-auto
- Tailwind `min-w-0`: resets flex item min-width to allow shrinking
- Tailwind `overflow-hidden`: clips content that overflows the container
