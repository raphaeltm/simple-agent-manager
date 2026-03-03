# Post-Mortem: Chat Session Message Leakage

**Date:** 2026-03-03
**Severity:** High — data isolation violation
**Status:** Fixed

## What Broke

Messages from one chat session appeared in another session within the same project. When switching between sessions in the project chat UI, the user would sometimes see messages from the previously-viewed session persisting or replacing messages in the newly-selected session.

## Root Cause

Four leakage vectors were identified, with the primary cause being a **polling race condition** on session switch.

### Primary: Polling Race Condition

**File:** `apps/web/src/components/chat/ProjectMessageView.tsx:447-473`

The `ProjectMessageView` component uses a 3-second polling fallback (`setInterval`) that fetches session data via `getChatSession(projectId, sessionId)`. When the user switches sessions:

1. The `useEffect` cleanup calls `clearInterval()` — this stops future polls
2. But an **in-flight HTTP request** for the old session is NOT aborted
3. The new session's `loadSession()` fires and sets correct messages
4. The old session's in-flight poll resolves AFTER step 3 and calls `setMessages()`, **overwriting** the new session's messages with old data

Compounding factor: `<ProjectMessageView>` was rendered **without** a `key={sessionId}` prop (`ProjectChat.tsx:446`), so React reused the same component instance across session switches. All state (messages, session, polls, WebSocket) persisted across sessions instead of being cleanly reset.

### Contributing: WebSocket Broadcast Without Session Filtering

**File:** `apps/api/src/durable-objects/project-data.ts:970-980`

The `ProjectData` Durable Object's `broadcastEvent()` method sends events to ALL WebSocket connections for the entire project, without filtering by session:

```typescript
private broadcastEvent(type: string, payload: Record<string, unknown>): void {
  const sockets = this.ctx.getWebSockets(); // ALL project sockets
  for (const ws of sockets) {
    ws.send(message); // Sent to every connected client
  }
}
```

Client-side filtering exists in `useChatWebSocket.ts:130` (`if (p.sessionId !== sessionId) return`), but this is a weak defense that depends on JavaScript closures being current during React state transitions.

### Contributing: Missing Session Validation in Message Ingestion

**File:** `apps/api/src/routes/workspaces.ts:1493-1595`

The POST `/workspaces/:id/messages` endpoint (used by VM agents to persist messages) validates message format but does NOT verify that the `sessionId` in the request body matches the workspace's linked `chatSessionId`. A buggy VM agent could inadvertently route messages to the wrong session within the same project.

## Timeline

- **2026-02-27:** TDF-6 chat session management implemented
- **2026-03-01:** Chat UI shipped with polling fallback for reliability
- **2026-03-03:** User reports cross-session message leakage
- **2026-03-03:** Root cause identified and fixes implemented

## Why It Wasn't Caught

1. **No session-switch test:** Existing tests verified session creation, message persistence, and cross-project isolation, but no test simulated rapid session switching within a project
2. **Component tests didn't exercise lifecycle:** Tests for `ProjectMessageView` didn't test the full mount → switch session → verify no leakage cycle
3. **Backend isolation was correct:** SQL queries are properly scoped (`WHERE session_id = ?`), cross-project DO isolation works — this gave false confidence that session isolation was complete
4. **Client-side race conditions invisible to unit tests:** The poll race condition only manifests when real network latency causes responses to arrive out of order

## Class of Bug

**Stale async response race condition** — when cleanup cancels the timer/subscription but not in-flight requests, and the response handler writes to shared mutable state (React state) without verifying it's still relevant.

This class includes:
- Polling/interval effects that don't abort in-flight fetches
- WebSocket reconnection handlers that apply data to stale component instances
- Any async operation that writes state without verifying the operation's context matches the current context

## Fixes Applied

### 1. Component Isolation via React Key (Frontend)

Added `key={sessionId}` to `<ProjectMessageView>` in `ProjectChat.tsx`. This forces React to unmount the old instance and mount a fresh one on every session switch, eliminating ALL stale state (polls, WebSocket handlers, messages, etc.).

### 2. AbortController for Polling (Frontend)

Added `AbortController` to the polling `useEffect` in `ProjectMessageView.tsx`. The controller is aborted in the effect cleanup, cancelling any in-flight fetch requests. Defense-in-depth even with the key fix.

### 3. Server-Side WebSocket Session Filtering (Backend)

Modified the WebSocket connection flow to include session-scoped filtering:
- Client sends `sessionId` as query param when connecting
- DO tracks per-socket session subscriptions
- `broadcastEvent()` now accepts an optional `sessionId` parameter and only sends to subscribed sockets for session-specific events
- Project-wide events (session.created, activity.new) still broadcast to all

### 4. Session Validation in Message Ingestion (Backend)

Added validation to POST `/workspaces/:id/messages` that verifies the `sessionId` in the request body matches the workspace's `chatSessionId` from D1.

## Process Fix

### New Rule: Async Effect Cleanup Must Cancel In-Flight Requests

When a `useEffect` makes HTTP requests (directly or via intervals), the cleanup function MUST abort in-flight requests using `AbortController`, not just stop future ones. Added to `.claude/rules/06-technical-patterns.md`.

### New Rule: Session-Scoped Components Must Use Key Prop

Any component that receives a session/entity ID as a prop and manages internal state based on that ID MUST have `key={id}` set by its parent, unless it explicitly handles all state transitions internally (which is error-prone and not recommended).
