# Research: DO-Owned ACP Session Lifecycle

**Feature**: 027-do-session-ownership | **Date**: 2026-03-11

## Decision 1: Where to Store ACP Session State

**Decision**: ProjectData Durable Object's embedded SQLite (new `acp_sessions` table)

**Rationale**:
- ProjectData DO already owns chat sessions, messages, and activity events for each project
- DO's single-threaded execution model eliminates concurrent state corruption risk
- SQLite in DO survives restarts (persistent storage)
- Keeps all per-project data co-located (chat sessions, ACP sessions, messages)
- D1 `agent_sessions` table exists but is cross-project — DO is the right place for project-scoped authoritative state

**Alternatives Considered**:
- **D1 only**: Cross-project queries easy, but D1 has higher latency and no single-threaded guarantee. Would need distributed locks for state machine transitions.
- **Separate DO per session**: Too many DOs, no cross-session queries within a project. Overhead of managing DO lifecycle.
- **VM agent SQLite**: Already proven unreliable — dies with VM. This is the problem we're solving.

## Decision 2: Relationship Between Chat Sessions and ACP Sessions

**Decision**: ACP sessions are a *child concept* of chat sessions. Each chat session can have zero or more ACP sessions (e.g., original + forks). The `acp_sessions` table references `chat_sessions.id`.

**Rationale**:
- Chat sessions already track the user conversation, messages, and workspace link
- ACP sessions represent the *execution* of an agent within that conversation
- Forking creates a new ACP session within the same chat session (or a new one)
- This keeps the message flow unchanged — messages reference `chat_sessions.id`, and ACP sessions are the execution backing

**Alternatives Considered**:
- **Replace chat_sessions with acp_sessions**: Would break existing UI, message flow, and idle cleanup. Too disruptive.
- **Merge into one table**: Conflates conversation (user-facing) with execution (system-facing). Different lifecycles.

## Decision 3: VM Failure Detection Strategy

**Decision**: Heartbeat-based detection via DO alarm. VM agent sends periodic heartbeats to the ProjectData DO. If no heartbeat received within configurable window (default: 5 min), DO marks session as "interrupted."

**Rationale**:
- NodeLifecycle DO already uses alarm-based timeout patterns
- Heartbeats are simple to implement (periodic POST from VM agent)
- Detection window is configurable per constitution Principle XI
- No new infrastructure needed — reuses existing DO alarm mechanism

**Alternatives Considered**:
- **NodeLifecycle DO signals**: Would couple node lifecycle to session lifecycle. Node can be "warm" (alive) while session is done.
- **External health checker**: New service, more infrastructure. Violates Principle XII (zero-to-production).
- **TCP/WebSocket keepalive**: Too granular, generates noise. Network blips would cause false positives.

**Implementation**:
- VM agent POSTs heartbeat every `ACP_SESSION_HEARTBEAT_INTERVAL` (default: 60s) to `POST /api/projects/:id/sessions/:id/heartbeat`
- ProjectData DO stores `last_heartbeat_at` and sets alarm for `last_heartbeat_at + DETECTION_WINDOW`
- If alarm fires without fresh heartbeat, transition session to "interrupted"

## Decision 4: Session Forking Strategy

**Decision**: Fork creates a new ACP session (and optionally a new chat session) with a context summary generated from the parent's messages as the initial prompt. No history injection.

**Rationale**:
- ACP SDK does not support injecting chat history (confirmed assumption)
- Context summary keeps the initial prompt within reasonable token limits
- Clear UX — user sees a "Continued from previous session" divider
- `parentSessionId` tracks lineage for UI navigation

**Alternatives Considered**:
- **Full history replay**: ACP SDK doesn't support it. Even if it did, long histories would exceed context windows.
- **No forking**: Users lose all context and must re-explain. Poor UX.
- **Copy messages to new session**: Messages are conversation artifacts, not execution state. Copying them creates confusion about what the agent "remembers."

**Context Summary Approach**:
- Extract last N messages (configurable, default: 20) from parent session
- Format as a system prompt prefix: "You are continuing work from a previous session. Here is the context: ..."
- Include: task description, key decisions, final state, any errors
- Let the LLM work with this context naturally

## Decision 5: Reconciliation Protocol

**Decision**: On startup, VM agent queries the control plane for sessions assigned to its node. For each session: if "assigned" → attempt to start; if "running" but no local process → report as errored.

**Rationale**:
- VM agents can restart (updates, crashes, warm pool recycle)
- Without reconciliation, assigned sessions would be lost
- Simple query-and-act pattern, no complex sync protocol

**Implementation**:
- VM agent calls `GET /api/nodes/:id/sessions?status=assigned,running` on startup
- For "assigned" sessions: attempt to start ACP session
- For "running" sessions with no local process: report error to DO
- Timeout: configurable `RECONCILIATION_TIMEOUT` (default: 30s)

## Decision 6: D1 agent_sessions Table Migration

**Decision**: Keep D1 `agent_sessions` table for cross-project queries (admin dashboard, user session list) but make DO the authoritative source. D1 becomes a read-optimized projection updated asynchronously.

**Rationale**:
- D1 supports cross-project queries that DOs cannot (e.g., "show all my sessions across projects")
- DO is authoritative for state machine transitions
- D1 updated via async projection (DO writes to D1 on state change via API route)
- Acceptable eventual consistency for dashboard queries

**Alternatives Considered**:
- **Remove D1 agent_sessions entirely**: Breaks cross-project queries. Would need to fan-out to all DOs.
- **D1 as authoritative**: Returns to the original problem — no single-threaded guarantee, higher latency for state transitions.

## Decision 7: PTY Session Boundary

**Decision**: PTY sessions remain 100% VM-agent owned. No DO involvement. No changes to interactive terminal behavior.

**Rationale**:
- PTY sessions are interactive (user types, shell responds). Latency-sensitive.
- DO round-trip would add unacceptable latency to keystrokes
- PTY sessions have no orchestration needs (single user, single VM, ephemeral)
- Clean separation: ACP = DO-owned orchestrated execution, PTY = VM-owned interactive terminal

## Configurable Values (Constitution XI Compliance)

| Value | Env Var | Default | Context |
|-------|---------|---------|---------|
| Heartbeat interval | `ACP_SESSION_HEARTBEAT_INTERVAL_MS` | `60000` (60s) | VM agent → control plane |
| Detection window | `ACP_SESSION_DETECTION_WINDOW_MS` | `300000` (5 min) | DO alarm timeout |
| Reconciliation timeout | `ACP_SESSION_RECONCILIATION_TIMEOUT_MS` | `30000` (30s) | VM agent startup |
| Fork context messages | `ACP_SESSION_FORK_CONTEXT_MESSAGES` | `20` | Messages to include in fork summary |
| Max fork depth | `ACP_SESSION_MAX_FORK_DEPTH` | `10` | Prevent infinite fork chains |
