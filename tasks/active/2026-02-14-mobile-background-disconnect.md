# Mobile Background Tab Should Not Disconnect Agent Session

## Summary

On mobile, briefly switching away from the browser (e.g. checking another app for 5 seconds) and returning causes the agent chat to show "waiting for agent" — the WebSocket connection has been dropped and the session appears lost. This is a broken experience. A brief tab/app switch should not disconnect the user from their active agent session.

## Current Behavior

- User is in an active agent chat session on mobile
- User switches to another app for a few seconds
- User returns to the browser — sees "waiting for agent" message
- The WebSocket connection was torn down during the background period
- User has to re-establish or wait, losing context of what was happening

## Desired Behavior

- Brief background periods (under ~30 seconds) should be invisible to the user — they return and see the current session state
- The UI should automatically reconnect the WebSocket when the tab regains focus
- On reconnect, the UI should fetch/replay any missed session updates so the conversation is up to date
- No "waiting for agent" message unless the agent is genuinely not running

## Root Cause (Likely)

Mobile browsers aggressively suspend background tabs — WebSocket connections are killed almost immediately. The client-side code likely has no reconnection logic or missed-message recovery when the connection drops.

## Implementation Notes

### Reconnection Strategy

- Listen for `visibilitychange` / `focus` events to detect tab becoming active again
- On re-focus: attempt WebSocket reconnect with backoff
- After reconnect: fetch current session state to catch up on missed `session/update` notifications
- Only show "waiting for agent" if the agent process itself is not running (not just because the WS dropped)

### Key Areas to Investigate

- WebSocket client code in `apps/web/` — how connections are managed and what happens on close
- ACP session update flow — whether missed updates can be replayed from the VM agent
- VM agent WebSocket handler — whether it supports reconnection to an existing session

### Considerations

- Don't reconnect aggressively in a tight loop — use exponential backoff
- Distinguish between "WS dropped because mobile background" vs "agent actually crashed"
- The VM agent already has session persistence (spec 012) — leverage that for state recovery
- Consider a lightweight HTTP poll fallback if WebSocket reconnect takes too long
