# Node Data Ownership Audit

## Summary

Our architecture principle states: **anything that lives inside a node (workspaces, terminal states, chat states, logs, etc.) should be managed by the node and exposed directly by the node.** The browser should fetch node-scoped data directly from the VM Agent, not through the control plane.

A thorough audit of the current codebase reveals several violations where node-local data is either proxied through the control plane or duplicated between the control plane and VM Agent.

## Principle

```
Control Plane (API Worker)     = owns user accounts, cloud credentials, node/workspace
                                  lifecycle ownership (who owns what), display metadata
VM Agent (node-local)          = owns everything that happens INSIDE the node:
                                  terminal state, chat state, events, logs, agent sessions
Browser                        = fetches ownership/lifecycle from control plane,
                                  fetches runtime/operational data directly from VM Agent
```

## Current State: What's Correct

### Correctly Node-Local (browser fetches directly from VM Agent)

| Data | Storage | Browser Access |
|------|---------|----------------|
| Terminal PTY sessions | In-memory (Go) | `wss://ws-{id}.{BASE_DOMAIN}/terminal/ws/multi` |
| ACP chat sessions | In-memory (Go) | `wss://ws-{id}.{BASE_DOMAIN}/agent/ws` |
| Workspace tabs | SQLite on disk | `GET https://ws-{id}.{BASE_DOMAIN}/workspaces/{wid}/tabs` |
| PTY ring buffers | In-memory (Go) | Replayed on WebSocket reconnect |

### Correctly Control-Plane-Owned

| Data | Storage | Rationale |
|------|---------|-----------|
| User accounts & sessions | D1 + KV | Authentication is a platform concern |
| Cloud provider credentials | D1 (encrypted) | BYOC model, per-user encryption |
| GitHub App installations | GitHub API | Platform integration |
| Node/workspace ownership | D1 | Which user owns which node/workspace |
| Workspace display names | D1 | User-facing metadata, survives node restarts |
| Workspace/node lifecycle state | D1 | `creating`/`running`/`stopped`/`error` transitions |

## Violations Found

### 1. Workspace Events — Proxied Through Control Plane

**Current flow:**
```
Browser → GET /api/workspaces/:id/events (control plane)
       → control plane proxies to VM Agent /workspaces/{wid}/events
       → VM Agent returns in-memory events
       → control plane forwards to browser
```

**Problem:** Events are generated and stored ONLY in the VM Agent (in-memory map in `events.go`). The control plane adds no value — it just proxies. This adds latency, requires the control plane to know the node's address, and is fragile if the Worker times out.

**Fix:** Browser should fetch events directly from the VM Agent:
```
Browser → GET https://ws-{id}.{BASE_DOMAIN}/workspaces/{wid}/events?token={token}
```

**Files:**
- `apps/web/src/lib/api.ts` — `listWorkspaceEvents()` should call VM Agent directly (similar to `getWorkspaceTabs()`)
- `apps/api/src/routes/workspaces.ts` — proxy route can be deprecated/removed
- `apps/api/src/services/node-agent.ts` — `listWorkspaceEvents()` can be removed

### 2. Node Events — Proxied Through Control Plane

**Current flow:**
```
Browser → GET /api/nodes/:id/events (control plane)
       → control plane proxies to VM Agent /events
       → VM Agent returns in-memory events
       → control plane forwards to browser
```

**Problem:** Same as workspace events — node events exist ONLY in VM Agent memory (`s.nodeEvents` in `events.go`). The proxy adds no value.

**Fix:** Browser should fetch node events directly from the VM Agent:
```
Browser → GET https://vm-{nodeId}.{BASE_DOMAIN}:8080/events?token={token}
```

**Files:**
- `apps/web/src/lib/api.ts` — `listNodeEvents()` should call VM Agent directly
- `apps/api/src/routes/nodes.ts` — proxy route can be deprecated/removed
- `apps/api/src/services/node-agent.ts` — `listNodeEvents()` can be removed

### 3. Agent Sessions — Duplicated in D1 and VM Agent

**Current flow:**
```
Browser → GET /api/workspaces/:id/agent-sessions (control plane D1)
Browser → POST /api/workspaces/:id/agent-sessions (control plane D1 + proxies to VM Agent)
Browser → POST /api/workspaces/:id/agent-sessions/:sid/stop (control plane D1 + proxies to VM Agent)
```

**Problem:** Agent sessions are stored in BOTH:
- **D1** (`agentSessions` table in `schema.ts`) — browser reads from here
- **VM Agent** (in-memory `workspaceSessions` map in `manager.go`) — runtime ACP process management

This causes:
- **Consistency risk** — If VM Agent crashes, in-memory sessions are lost but D1 still shows them as `active`
- **Unnecessary control plane storage** — The control plane doesn't need to know about individual agent sessions; it's a node-internal concern
- **Extra network hops** — Create/stop operations hit both D1 and VM Agent

**Fix:** Agent sessions should be node-local only. The browser should list/create/stop sessions directly via the VM Agent:
```
Browser → GET https://ws-{id}.{BASE_DOMAIN}/workspaces/{wid}/agent-sessions?token={token}
Browser → POST https://ws-{id}.{BASE_DOMAIN}/workspaces/{wid}/agent-sessions?token={token}
Browser → POST https://ws-{id}.{BASE_DOMAIN}/workspaces/{wid}/agent-sessions/{sid}/stop?token={token}
```

Session metadata should be persisted in VM Agent SQLite (not D1) for survivability across agent restarts.

**Files:**
- `apps/api/src/db/schema.ts` — remove `agentSessions` table (or keep as audit log if needed)
- `apps/api/src/routes/workspaces.ts` — remove agent session CRUD routes (or convert to thin proxies temporarily)
- `packages/vm-agent/internal/agentsessions/manager.go` — add SQLite persistence (similar to tabs)
- `packages/vm-agent/internal/server/workspaces.go` — expose REST endpoints for session CRUD
- `apps/web/src/lib/api.ts` — point session API calls to VM Agent directly

### 4. Boot Logs — Stored in Control Plane KV

**Current flow:**
```
VM Agent → POST /api/workspaces/:id/boot-log (callback to control plane)
        → control plane writes to Cloudflare KV (key: bootlog:{workspaceId}, TTL: 30min)
Browser  → GET /api/workspaces/:id (control plane)
        → control plane reads boot logs from KV and embeds in response
```

**Problem:** Boot logs are generated by the VM Agent during provisioning but stored in Cloudflare KV via callbacks. This:
- Consumes KV writes (1,000/day free tier limit — this was a real problem, see MEMORY.md)
- Adds latency (VM Agent → Worker → KV → Worker → Browser instead of VM Agent → Browser)
- Is fragile if callbacks fail (lost boot progress)

**Fix:** Boot logs should be stored and served by the VM Agent:
- VM Agent writes boot logs to SQLite or an in-memory buffer
- Browser fetches boot logs directly from VM Agent during provisioning
- Remove the `POST /api/workspaces/:id/boot-log` callback endpoint
- Remove KV boot log storage (`appendBootLog`, `getBootLogs` in `boot-log.ts`)

```
Browser → GET https://ws-{id}.{BASE_DOMAIN}/workspaces/{wid}/boot-log?token={token}
   OR
Browser → GET https://vm-{nodeId}.{BASE_DOMAIN}:8080/workspaces/{wid}/boot-log?token={token}
```

**Caveat:** During initial node bootstrap (before the VM Agent is even running), boot logs can't come from the VM Agent. We may need to keep a minimal callback for the "node is booting" phase, but workspace-level boot logs (devcontainer build) should be node-local.

**Files:**
- `apps/api/src/services/boot-log.ts` — remove or reduce to node-level-only
- `apps/api/src/routes/workspaces.ts` — remove `POST /boot-log` callback endpoint for workspaces
- `packages/vm-agent/internal/server/` — add boot log storage (SQLite or in-memory) and GET endpoint
- `apps/web/src/pages/Workspace.tsx` — fetch boot logs from VM Agent directly during provisioning

### 5. Workspace Status Polling — Browser Polls Control Plane

**Current flow:**
```
Browser → GET /api/workspaces/:id (every 5 seconds)
       → control plane reads status from D1
       → returns workspace object with current status
```

**Problem:** The browser polls the control plane every 5 seconds to check if a workspace has transitioned from `creating` to `running`. But the actual runtime status lives on the node — the control plane only knows because the VM Agent sends callbacks (`POST /api/workspaces/:id/ready`, `POST /api/workspaces/:id/provisioning-failed`).

This is a **partial violation** — the lifecycle state machine legitimately lives in the control plane (it needs to survive node restarts and is needed for listing workspaces). But polling the control plane for real-time status during active use is wasteful.

**Fix (stretch goal):** Consider a WebSocket or SSE connection from browser to VM Agent for real-time workspace status updates during provisioning, instead of polling the control plane REST API. This would give instant feedback and reduce API load.

**Note:** This is lower priority than violations 1-4 because the control plane IS the source of truth for lifecycle state. The improvement is about efficiency, not architectural correctness.

## Implementation Order

| Priority | Violation | Effort | Impact |
|----------|-----------|--------|--------|
| 1 | Workspace events → direct fetch | Low | Removes unnecessary proxy |
| 2 | Node events → direct fetch | Low | Removes unnecessary proxy |
| 3 | Boot logs → node-local storage | Medium | Reduces KV writes, improves reliability |
| 4 | Agent sessions → node-local only | High | Removes D1 duplication, simplifies architecture |
| 5 | Status polling → WebSocket/SSE | Medium | Efficiency improvement (stretch goal) |

Violations 1 and 2 are straightforward — just change the browser fetch target from the control plane proxy to the VM Agent directly, with the workspace token for authentication. The VM Agent already has these endpoints.

Violation 3 saves real KV write quota and makes boot logs more reliable.

Violation 4 is the biggest change — it requires adding SQLite persistence to the agent session manager and exposing full CRUD endpoints on the VM Agent.

## Authentication Pattern for Direct VM Agent Calls

When the browser calls the VM Agent directly, it needs authentication. The existing pattern (used by tabs and WebSocket connections) is:

1. Browser gets a workspace-scoped token from the control plane (`POST /api/terminal/token`)
2. Browser passes the token as a query parameter (`?token={token}`) to VM Agent endpoints
3. VM Agent validates the token

This pattern should be extended to all direct VM Agent calls (events, boot logs, agent sessions).

## Acceptance Criteria

- [ ] Browser fetches workspace events directly from VM Agent (not proxied through control plane)
- [ ] Browser fetches node events directly from VM Agent (not proxied through control plane)
- [ ] Boot logs are stored and served by the VM Agent (not in Cloudflare KV)
- [ ] Agent sessions are managed entirely by the VM Agent (not duplicated in D1)
- [ ] All direct VM Agent calls use the existing token authentication pattern
- [ ] Control plane proxy routes are removed or deprecated
- [ ] No regression in functionality — all data remains accessible in the UI
- [ ] Works on both node-mode (multi-workspace) and legacy single-workspace layouts

## Notes

- The VM Agent already exposes most of these endpoints internally — the main work is changing the browser to call them directly and removing the control plane proxy layer.
- The workspace token flow (`POST /api/terminal/token`) already handles authentication for direct VM Agent calls — no new auth mechanism needed.
- Events are currently in-memory only on the VM Agent. If persistence across VM Agent restarts is desired, they could be added to SQLite (same pattern as tabs). But for now, in-memory is acceptable since events are ephemeral.
- Removing the `agentSessions` table from D1 is a schema migration. Consider keeping the table temporarily as an audit log while transitioning, then removing it once the node-local pattern is proven.
