# DO-Only Chat Architecture: TypewriterText + WorkspaceChatView

## Problem

WorkspaceChatView crashes with React error #185 (infinite render loop) because it merges messages from two independent WebSocket sources: the DO WebSocket (batched persistence) and the ACP WebSocket (real-time streaming). This dual-source architecture is complex and fragile.

## Solution

Remove the direct ACP WebSocket connection from the browser in WorkspaceChatView. Route ALL messages through the Durable Object. Add a typewriter animation effect to maintain the perception of continuous streaming despite 2-second batched delivery.

## Research Findings

### Key Files
- `apps/web/src/pages/workspace/WorkspaceChatView.tsx` — component being modified (321 lines)
- `apps/web/src/hooks/useProjectAgentSession.ts` — ACP hook being removed from this view (stays in codebase for other consumers)
- `apps/web/src/hooks/useChatWebSocket.ts` — DO WebSocket hook that stays as sole message source
- `apps/api/src/routes/chat.ts:395` — existing `POST /sessions/:sessionId/prompt` endpoint
- `apps/web/src/lib/api/sessions.ts:166` — existing `sendFollowUpPrompt()` API helper (currently marked @deprecated)
- `packages/acp-client/src/components/` — where TypewriterText goes
- `packages/acp-client/src/index.ts` — package exports

### Existing Infrastructure
- `sendFollowUpPrompt()` in `apps/web/src/lib/api/sessions.ts:166` already calls the REST prompt endpoint — we just need to un-deprecate it
- `useChatWebSocket` already provides: real-time message delivery, session stopped/completed events, catch-up on reconnection, connection state tracking
- The API prompt endpoint forwards to VM agent which dispatches async and returns 202
- `useProjectAgentSession` is also used by `useSessionLifecycle.ts` (ProjectMessageView) — do NOT delete the hook file
- `mergeMessages` utility already handles deduplication

### Architecture After Change
```
Browser <-> DO WebSocket <-> DO (batched, every 2s)
Browser -> REST API -> VM Agent (prompts only)
WorkspaceChatView uses single source -> no loop possible
TypewriterText animates batches -> feels like streaming
```

## Implementation Checklist

### Part 1: TypewriterText Component
- [ ] Create `packages/acp-client/src/components/TypewriterText.tsx`
  - Props: `text: string`, `animated?: boolean`, `wordsPerSecond?: number`
  - When `text` grows, queue new words for animation
  - Use `requestAnimationFrame` for word-by-word reveal at ~25 wps
  - Adaptive rate: `words_in_queue / expected_batch_interval`
  - When queue empties, stop naturally (signals "agent thinking")
  - Markdown-safe: reveal at word boundaries
  - `animated=false` renders instantly (for historical messages)
- [ ] Export TypewriterText from `packages/acp-client/src/index.ts`
- [ ] Add unit tests in `packages/acp-client/tests/unit/components/TypewriterText.test.tsx`

### Part 2: WorkspaceChatView DO-Only Mode
- [ ] Remove `useProjectAgentSession` import and usage from WorkspaceChatView
- [ ] Remove the dual-source `conversationItems` useMemo that merges DO + ACP messages
- [ ] Remove `agentSession.sendPrompt()` calls
- [ ] Remove `agentSession.isAgentActive` checks
- [ ] Remove `mergeMessages` import (if no longer needed)
- [ ] Un-deprecate `sendFollowUpPrompt` in api/sessions.ts and use it for sending prompts
- [ ] Add agent state derivation: idle -> prompting -> responding -> idle
  - Set `prompting` when user sends (API returns 202)
  - Set `responding` when first new assistant message arrives
  - Set `idle` when no new messages for ~3 seconds
- [ ] Integrate TypewriterText for the LATEST assistant message only
- [ ] Update input placeholder to use derived agent state
- [ ] Update component docstring to reflect new architecture

### Part 3: Tests
- [ ] TypewriterText unit tests: instant render, animated render, batch growth, word boundary safety
- [ ] WorkspaceChatView: verify it no longer imports useProjectAgentSession

## Acceptance Criteria
- [ ] WorkspaceChatView renders messages from DO WebSocket only (no ACP WebSocket)
- [ ] Prompts are sent via REST API (POST /sessions/:sessionId/prompt)
- [ ] TypewriterText animates new assistant content word-by-word
- [ ] Historical messages render instantly (no animation)
- [ ] Agent state (idle/prompting/responding) is derived from message flow
- [ ] No React error #185 possible (single message source)
- [ ] ChatSession component is unchanged (still uses ACP)
- [ ] useProjectAgentSession hook file is NOT deleted (used by ProjectMessageView)
- [ ] All existing tests pass
- [ ] New TypewriterText tests pass

## References
- React error #185: infinite render loop from dual WebSocket sources
- `tasks/backlog/2026-03-06-unify-project-chat-through-do-streaming.md` — earlier proposal for DO-only streaming
