# Fix Chat Scroll Position Jump on Message Send and Agent Handoff

**Created**: 2026-03-19
**Priority**: High
**Classification**: `ui-change`

## Problem

Two related scroll position issues in the chat interface:

### Issue 1: Scroll jumps on message send

When the user hits submit/enter to send a message, the scroll position immediately jumps to a different location (somewhere up in the conversation). The user has to tap the scroll-to-bottom button to get back. This happens consistently on every send.

### Issue 2: Scroll bump on agent handoff

When the agent finishes and human control is handed back, there's a noticeable scroll position shift — roughly 100-600 pixels. If the user has scrolled up to read earlier output, this bump is disruptive. Not as severe as Issue 1 but still annoying.

## Root Cause Analysis

### Issue 1: DO→ACP view switch on follow-up send

The root cause is the `useFullAcpView` condition in `ProjectMessageView.tsx` (line ~849):

```javascript
const useFullAcpView = acpItems.length > 0 && (
  convertedItems.length === 0 || agentSession.isPrompting || acpGrace
);
```

When the user sends a follow-up:
1. `handleSendFollowUp` → `agentSession.sendPrompt(text)` adds a user message to ACP items
2. ACP session transitions to `state === 'prompting'` → `isPrompting` becomes `true`
3. `useFullAcpView` flips from `false` to `true` (because `isPrompting` is now true and `acpItems.length > 0`)
4. The entire view switches from DO-based messages (full conversation history, potentially hundreds of messages) to ACP-based messages (just the new user prompt)
5. The scroll container's content is replaced entirely → scroll position jumps dramatically

**Code path**: `handleSendFollowUp()` (PMV:671) → `agentSession.sendPrompt()` (useProjectAgentSession:216) → ACP state changes → `isPrompting` becomes true → `useFullAcpView` flips → view switches

### Issue 2: ACP→DO grace period transition with rAF timing

When the agent finishes and the grace period (3s) ends:
1. `acpGrace` transitions from `true` to `false`
2. `useFullAcpView` becomes `false` → view switches from ACP to DO
3. The scroll preservation code (PMV:449-467) captures `scrollHeight`/`scrollTop` in a `useEffect` and adjusts in a `requestAnimationFrame`
4. `useEffect` fires AFTER paint → user sees the scroll jump for one frame before rAF corrects
5. The rAF delta calculation (`newScrollHeight - prevScrollHeight`) doesn't account for different item rendering heights between ACP and DO views

## Implementation Checklist

- [ ] **Add `committedToDoViewRef`** to prevent DO→ACP view switch during follow-ups
  - Track when the initial ACP→DO transition happens (after first grace period ends)
  - Once committed to DO view, never switch back to ACP for the same session
  - Reset the ref when `sessionId` changes
  - Update `useFullAcpView` condition to respect the committed flag
- [ ] **Capture scroll snapshot in grace timer callback** before `setAcpGrace(false)`
  - The setTimeout callback executes before React renders, so DOM reads here reflect pre-transition state
  - Store `scrollTop` and `scrollHeight` in a ref
- [ ] **Replace `useEffect`+`rAF` with `useLayoutEffect` for scroll preservation**
  - `useLayoutEffect` fires after DOM mutation but before paint — no visible flicker
  - If user was stuck to bottom: scroll to bottom
  - If user was scrolled up: restore relative position using captured snapshot
- [ ] **Remove old `prevAcpGraceRef` + `useEffect` scroll preservation code** (lines 448-468)
- [ ] **Add unit test** for `committedToDoViewRef` logic (view mode doesn't flip back)
- [ ] **Verify no regressions**: autoscroll, load-more pagination, initial provisioning ACP view

## Affected Files

- `apps/web/src/components/chat/ProjectMessageView.tsx` — main fix location (view switching + scroll preservation)

## Acceptance Criteria

- [ ] Sending a message does not change scroll position (user stays where they were, or smooth-scrolls to bottom if stuck-to-bottom)
- [ ] Agent handoff does not cause visible scroll position shift
- [ ] Autoscroll still works correctly when stuck to bottom
- [ ] Load-more pagination still preserves scroll position
- [ ] Initial provisioning still shows ACP streaming view (when no DO messages exist)
- [ ] No regression in streaming message display

## References

- `apps/web/src/components/chat/ProjectMessageView.tsx` — lines 849-860 (view switching), 449-467 (scroll preservation), 671-729 (send handler)
- `apps/web/src/hooks/useProjectAgentSession.ts` — lines 210-211 (isPrompting derivation)
- `docs/notes/2026-03-19-chat-ui-evaluation-report.md`
- `tasks/archive/2026-03-17-fix-chat-message-duplication.md`
- `tasks/archive/2026-03-15-chat-autoscroll-pause.md`
