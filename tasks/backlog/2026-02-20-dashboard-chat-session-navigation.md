# Dashboard Chat Session Navigation

**Created**: 2026-02-20
**Priority**: High
**Effort**: Large (multi-phase, cross-cutting: VM Agent Go, API, D1 schema, frontend)
**Tags**: `ui-change`, `cross-component-change`, `business-logic-change`

## Problem

Users currently must navigate into a workspace to see and interact with their agent chat sessions. There is no way to:

1. See which sessions are active across all workspaces from the main dashboard
2. Identify what a session is about (no topic/summary, just opaque labels or auto-generated names)
3. Jump directly into a conversation without the full workspace chrome (file browser, terminal, sidebar)

This creates friction for the most common user action: checking on an agent's progress and responding to its questions.

## Goal

Enable users to see active chat sessions from the dashboard and navigate directly into a lightweight chat view, bypassing the full workspace UI.

## Research Summary

### Current Architecture Gaps

The following gaps were identified through codebase analysis:

| Gap | Detail |
|-----|--------|
| **No session data on dashboard** | Dashboard fetches workspaces only; zero agent session information is displayed |
| **Control plane lacks live state** | `GET /api/workspaces/:id/agent-sessions` returns only D1 data (no hostStatus, no viewerCount, no agentType) |
| **No session-level heartbeat** | Workspace heartbeat carries idle/activity data but nothing about individual sessions |
| **No conversation metadata** | First message, topic, token usage, and prompt count are not stored in any backend |
| **No cross-workspace session API** | No endpoint returns sessions across multiple workspaces |
| **N+1 problem for live state** | Getting live session state requires per-workspace calls to VM Agent via ws-{id} subdomain, each needing a JWT token |

### Current Data Flow

```
Browser <--WebSocket--> VM Agent (ws-{id} subdomain)
   |                        |
   |                        |-- In-memory: hostStatus, viewerCount, agentType, message buffer
   |                        |-- SQLite: acpSessionId, agentId (survives restart)
   |                        |
   +--REST--> Control Plane API
                   |
                   +-- D1: id, workspaceId, status, label, worktreePath, timestamps
```

**The core problem**: Rich session state (hostStatus, agentType, conversation content) lives only on the VM Agent. The control plane in D1 has a minimal lifecycle record. There is no mechanism for the VM Agent to push session-level state to the control plane.

### Prior Art

- **VS Code Copilot Chat**: Shows a session list with conversation history; users can switch between sessions. Sessions are identified by their conversation content. ([VS Code docs](https://code.visualstudio.com/docs/copilot/chat/chat-sessions))
- **ChatGPT / Claude.ai**: Use the first user message (truncated) as the conversation title in the sidebar. Auto-generated, user can rename.
- **Cursor**: Multiple UX modes (chat, inline, background agents) with session-level visibility from a single interface. ([Agentic UX patterns](https://manialabs.substack.com/p/agentic-ux-and-design-patterns))
- **Agent monitoring platforms** (Langfuse, Braintrust): Session-level trace logging with status, token usage, and activity timelines. Emphasize pushing state from agents to a central observability layer. ([AI Agent Monitoring](https://uptimerobot.com/knowledge-hub/monitoring/ai-agent-monitoring-best-practices-tools-and-metrics/))

The consistent pattern: **agents push state to a central store**; the dashboard reads from that store. Never fan out to N agents from the browser.

## Proposed Design

### Phase 1: Session Activity Reporting (VM Agent -> Control Plane)

**Mechanism**: VM Agent pushes session state changes to the control plane via a new callback endpoint.

**When to report**:
- On session state change (created, agent selected, prompt started, prompt completed, error, stopped)
- Periodically for active sessions (every 60s as a keep-alive, confirming the session is still alive)

**New API endpoint**: `POST /api/workspaces/:id/agent-sessions/sync`

**Payload**:
```json
{
  "sessions": [
    {
      "sessionId": "01HXYZ...",
      "hostStatus": "prompting",
      "agentType": "claude-code",
      "viewerCount": 2,
      "lastPromptAt": "2026-02-20T10:30:00Z",
      "topic": "Fix the authentication middleware to handle expired tokens"
    }
  ]
}
```

**Control plane handling**:
- Update D1 `agent_sessions` table with enrichment columns
- Set `lastReportedAt` timestamp for staleness detection
- Sessions not reported for >15 minutes are considered stale (configurable via `SESSION_REPORT_STALE_SECONDS`)

**New D1 columns on `agent_sessions`**:
- `hostStatus` (text, nullable) — idle/starting/ready/prompting/error/stopped
- `agentType` (text, nullable) — claude-code/openai-codex/google-gemini
- `topic` (text, nullable) — auto-derived or manually set conversation topic
- `lastPromptAt` (text, nullable) — ISO timestamp of last prompt
- `lastReportedAt` (text, nullable) — ISO timestamp of last sync from VM Agent
- `viewerCount` (integer, nullable) — connected browser viewers

### Phase 2: Session Topic Capture (First Message Extraction)

**In SessionHost** (Go, `session_host.go`):
- When the first `session/prompt` is received and the session has no topic yet:
  - Extract the text content from the first prompt message
  - Truncate to 200 characters
  - Store as `topic` on the in-memory Session
  - Include in the next sync report to control plane

**Display priority**: `label` (manually set) > `topic` (auto-derived) > fallback format (`"Session from {relative_time}"`)

**Label vs Topic**:
- `label`: Explicit user rename (via existing PATCH endpoint). Short, intentional.
- `topic`: Auto-captured first message. Longer, descriptive, serves as identification when no label is set.

### Phase 3: Cross-Workspace Session Listing API

**New endpoint**: `GET /api/agent-sessions`

**Query params**:
- `status` — filter by status (default: `running`)
- `hostStatus` — filter by host status (e.g., `prompting` to find sessions waiting for input)
- `limit` / `cursor` — pagination
- `sort` — `lastPromptAt` (default), `createdAt`, `updatedAt`

**Response**: Sessions enriched with workspace context:
```json
{
  "sessions": [
    {
      "id": "01HXYZ...",
      "workspaceId": "01HABC...",
      "workspaceName": "my-project",
      "repository": "owner/repo",
      "branch": "main",
      "status": "running",
      "hostStatus": "prompting",
      "agentType": "claude-code",
      "label": null,
      "topic": "Fix the authentication middleware to handle expired tokens",
      "viewerCount": 0,
      "lastPromptAt": "2026-02-20T10:30:00Z",
      "lastReportedAt": "2026-02-20T10:30:45Z",
      "createdAt": "2026-02-20T09:00:00Z"
    }
  ],
  "cursor": "..."
}
```

**Staleness indicator**: If `lastReportedAt` is older than the configured threshold, include `"stale": true` so the UI can indicate uncertain state.

### Phase 4: Dashboard Active Sessions Panel

**Location**: Dashboard page, above or alongside the workspace cards.

**Design**: A compact list/card view of active sessions showing:
- Session topic or label (primary text)
- Host status badge (prompting = needs attention, ready = idle, etc.)
- Workspace name + repo (secondary context, small/muted)
- Relative time since last activity
- Click to navigate to direct chat view

**Status-based visual treatment**:
- `prompting` — highlighted/elevated (agent may be waiting for user input or tool approval)
- `ready` — normal (agent idle, conversation available)
- `starting` — muted (agent spinning up)
- `stale` — dimmed with indicator (VM Agent hasn't reported recently)

**Empty state**: "No active chat sessions. Open a workspace to start one."

### Phase 5: Direct Chat View

**Route**: `/chat/:workspaceId/:sessionId`

**UI**: Lightweight chat-only view:
- Minimal header: session topic/label, workspace name (as subtle breadcrumb), back button
- Full `ChatSession` component with message history and input
- WebSocket connection to VM Agent (same mechanism as workspace view)
- No file browser, no terminal, no sidebar, no tab strip

**Token acquisition**: Same flow as workspace — `POST /api/terminal/token` with workspaceId, then WebSocket to `wss://ws-{id}.{BASE_DOMAIN}/agent/ws?token=...&sessionId=...`

**Navigation**: Clicking a session on the dashboard navigates to this route. The user can always "Open full workspace" to get the complete workspace UI.

## Open Questions

1. **Session sync frequency**: 60s periodic + event-driven, or purely event-driven? Event-driven alone risks missed updates if the HTTP call fails. Periodic acts as a catch-up.
2. **Staleness threshold**: 15 minutes feels right for "is this session still alive?" but should be configurable. What's the right default?
3. **Topic generation**: Should we use the raw first message (truncated) or eventually ask the LLM to generate a summary title (like ChatGPT does)? Start simple with truncation, revisit later.
4. **Mobile UX**: The direct chat view should be the primary mobile experience. Consider whether the dashboard session list should be the default mobile landing page.
5. **Session across workspaces**: If a user has 10 workspaces with 3 sessions each, the list could get long. Filtering by workspace, status, and sorting by recency should handle this, but consider grouping by workspace as an alternative layout.

## Environment Variables (New)

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_REPORT_STALE_SECONDS` | `900` (15 min) | Threshold after which unreported sessions are considered stale |
| `SESSION_SYNC_INTERVAL_SECONDS` | `60` | VM Agent periodic sync interval for active sessions |
| `SESSION_TOPIC_MAX_LENGTH` | `200` | Max characters for auto-captured session topic |

## Dependencies

- Requires running workspaces with VM Agent (existing)
- Requires D1 migration for new columns on `agent_sessions`
- No new external services

## Related

- `tasks/backlog/2026-02-20-agent-session-startup-optimization.md` — Session startup perf (complementary)
- `tasks/backlog/2026-02-17-persistent-terminal-sessions.md` — Terminal session persistence (parallel pattern)
- `specs/007-multi-agent-acp/` — ACP protocol spec
- Recent change: `session-visibility` — VM Agent already enriches sessions with hostStatus/viewerCount (Phase 1 builds on this)
- Recent change: `persistent-agent-sessions` — SessionHost pattern (Phase 2 hooks into this)
