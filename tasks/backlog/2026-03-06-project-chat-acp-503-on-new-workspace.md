# Project Chat ACP WebSocket 503 on Newly Created Workspace

## Problem

When a new task is submitted from the project chat view, the task runner provisions a workspace and links it to the session. The client-side ACP WebSocket immediately tries to connect to `wss://ws-{workspaceId}.{baseDomain}/agent/ws`, but gets a **503 Service Unavailable** because the Cloudflare DNS record / Worker route for the new workspace subdomain isn't fully propagated yet.

This causes the "Agent offline" banner to appear even though the task completes successfully (via the server-side task runner ACP path). A page refresh resolves it.

## Context

- Discovered during staging E2E testing on 2026-03-06
- The task still executes correctly because the task runner uses a server-side ACP connection, not the client WebSocket
- Only affects the client's ability to send follow-up messages until DNS propagates or page is refreshed
- Console error: `WebSocket connection to 'wss://ws-01kk1fae...' failed: Error during WebSocket handshake: Unexpected response code: 503`

## Acceptance Criteria

- [ ] Client ACP connection retries with exponential backoff on 503 (may already be implemented — verify)
- [ ] If retry logic exists, verify it covers the initial provisioning window (typically 5-15s after workspace creation)
- [ ] "Agent offline" banner should not show during initial provisioning if retry will resolve it
- [ ] Alternative: delay the client ACP connection attempt until workspace status is confirmed "running"
