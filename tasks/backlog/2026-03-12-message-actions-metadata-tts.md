# Message Actions: Metadata & Text-to-Speech

## Problem

Agent-generated messages in the chat UI have no interactive affordances. Users cannot:
1. View message metadata (timestamp, message ID, word count)
2. Listen to a message read aloud via text-to-speech

## Research Findings

### Key Files
- `packages/acp-client/src/components/MessageBubble.tsx` — Main message bubble component (React.memo'd)
- `packages/acp-client/src/components/AgentPanel.tsx` — `ConversationItemView` routes items to MessageBubble
- `apps/web/src/components/chat/ProjectMessageView.tsx` — `AcpConversationItemView` routes items (project chat)
- `packages/acp-client/src/hooks/useAcpMessages.ts` — `ConversationItem` types with `timestamp` field
- `packages/ui/src/components/Tooltip.tsx` — Existing tooltip (string content only, side positioning)

### Existing Patterns
- **Tooltip**: `@simple-agent-manager/ui` Tooltip supports string content only — we need a richer popover for metadata
- **VoiceButton**: Already uses Web Audio API for recording; TTS will use `speechSynthesis` API (no external dependency)
- **Design tokens**: SAM design system with CSS vars, Tailwind v4
- **Icons**: No Lucide React in acp-client currently; use inline SVGs (consistent with existing pattern)

### Architecture
- `MessageBubble` receives `text`, `role`, `streaming` props
- `ConversationItem` has `timestamp: number` on all item types
- Both `ConversationItemView` (AgentPanel) and `AcpConversationItemView` (ProjectMessageView) pass the full item to MessageBubble but only forward `text`, `role`, `streaming`
- Need to pass `timestamp` through to MessageBubble for metadata display

## Implementation Checklist

- [ ] Create `MessageActions.tsx` in `packages/acp-client/src/components/`
  - Info button: toggles a small popover showing timestamp, word count, character count
  - Speaker button: uses `window.speechSynthesis` to read the message text aloud (toggle play/stop)
  - Only shown for agent messages (not user messages)
  - Appears on hover or focus of the message bubble
- [ ] Update `MessageBubble.tsx` to accept optional `timestamp` prop and render `MessageActions` for agent messages
- [ ] Update `ConversationItemView` in AgentPanel.tsx to pass `timestamp` to MessageBubble
- [ ] Update `AcpConversationItemView` in ProjectMessageView.tsx to pass `timestamp` to MessageBubble
- [ ] Add `MessageActions.test.tsx` with behavioral tests:
  - Renders info and speaker buttons for agent messages
  - Does not render for user messages
  - Clicking info shows metadata popover with timestamp/word count
  - Clicking speaker triggers speechSynthesis
  - Clicking speaker again stops speech
- [ ] Update existing MessageBubble tests if props change
- [ ] Export `MessageActions` from acp-client index
- [ ] Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] Agent messages show a small action row (info + speaker icons) on hover
- [ ] Clicking info icon displays a popover with: formatted timestamp, word count, character count
- [ ] Clicking speaker icon reads the message text aloud using browser TTS
- [ ] Clicking speaker again (or speech ending) resets the icon state
- [ ] User messages do NOT show the action row
- [ ] Streaming messages do NOT show the action row (wait until complete)
- [ ] All existing MessageBubble tests still pass
- [ ] New behavioral tests cover all interactive elements
