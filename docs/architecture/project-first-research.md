# Project-First Architecture: Research & Recommendations

**Date**: 2026-02-20
**Status**: Research complete
**Context**: Paused spec-017 (Dashboard Chat Navigation) after identifying that conversation history persistence requires a project-centric D1/DO architecture.

---

## Executive Summary

SAM needs to shift from a workspace-first model to a **project-first model** where:
- A **project** (linked to a GitHub repo by its stable numeric ID) is the primary organizational unit
- **Workspaces** are created under projects, not as top-level entities
- Each project gets its own **Durable Object** for high-throughput, isolated data (chat sessions, event logs)
- The central **D1 database** remains for platform-level metadata (users, projects index, nodes, workspaces)

This mirrors what every successful developer platform has converged on (Vercel, Railway, Render, Ona/Gitpod) and aligns with Cloudflare's recommended architecture for multi-tenant SaaS.

---

## 1. Current State: Data Surface Inventory

### Central D1 Database (Current)

| Table | Write Frequency | Read Frequency | Concern |
|-------|----------------|----------------|---------|
| `users` | Low (on first login) | Per request (auth) | Fine |
| `sessions` | Per login | Per request (JWT) | Fine |
| `credentials` | Medium (key rotation) | High (every workspace op) | Consider KV cache for active keys |
| `nodes` | **High** (heartbeat every 30-60s) | High (per workspace op) | `lastHeartbeatAt` + `lastMetrics` write hotspot |
| `workspaces` | **High** (heartbeat every 30-180s) | High (listing, status) | `lastActivityAt` write hotspot |
| `agent_sessions` | Medium (creation, status) | High (workspace access) | Fine |
| `projects` | Low-Medium | Medium | Already exists |
| `tasks` | Medium-High | High (listing) | Fine |
| `task_status_events` | **High** (append-only) | Medium | No retention policy; grows unbounded |

### KV Storage (Current)

| Key Pattern | Purpose | Write Freq | TTL |
|-------------|---------|------------|-----|
| `bootstrap:{token}` | One-time workspace credentials | Per workspace creation | 15 min |
| `bootlog:{workspaceId}` | Boot progress entries | Multiple/min during boot | 30 min |
| `rate-limit:{type}:{key}` | API rate limiting | Per request | 1 hour |

### Ephemeral Data (In-VM, Lost on Stop)

| Surface | Storage | Size | Concern |
|---------|---------|------|---------|
| ACP message buffer | In-memory (Go) | Up to 5000 messages (~500MB) | **Lost on session stop** |
| Terminal PTY data | Streamed via WebSocket | N/A (not persisted) | Expected |
| Agent process state | Go process | 50-200MB | Expected |

### Key Insight: The Persistence Gap

Chat conversations are the highest-value data in the system, yet they exist **only in ephemeral VM memory**. When a workspace stops, all conversation history is lost. This is the primary motivation for the project-first architecture shift.

---

## 2. Why Durable Objects, Not More D1

### The Single-Writer Bottleneck

Each D1 database is backed by a **single Durable Object** processing queries serially. Throughput depends on query duration:

| Query Duration | Throughput |
|---------------|-----------|
| 1 ms | ~1,000 queries/sec |
| 10 ms | ~100 queries/sec |
| 100 ms | ~10 queries/sec |

For chat messages (potentially dozens per minute per session, across many concurrent sessions), a single D1 becomes a bottleneck. Read replication helps reads but **does nothing for writes**.

### Durable Objects: Co-located Compute + Storage

Durable Objects with embedded SQLite provide:

- **Zero network hop** between code and database (co-located)
- **~500-1,000 requests/sec per object** for simple operations
- **10 GB SQLite storage per object**
- **Native WebSocket support** with Hibernatable WebSockets (cost-efficient idle connections)
- **Automatic geographic placement** near the first requesting user

The tradeoff vs D1:
- No built-in migration tooling (you manage your own schema)
- No read replication (single object handles reads + writes)
- Only accessible from Workers, not via REST API
- More complex to operate at scale

### The Hybrid Architecture (Recommended)

| Data Type | Storage | Rationale |
|-----------|---------|-----------|
| Users, platform settings, credentials | **D1 (single platform DB)** | Low-write, relational, needs cross-entity queries |
| Project/workspace/node metadata | **D1 (single platform DB)** | Relational, needs cross-project queries for dashboards |
| Real-time chat sessions, messages | **Durable Object (per-project)** | Write-heavy, real-time streaming, co-located compute |
| Event/activity logs per project | **Durable Object (per-project)** | Append-only, project-scoped, no cross-project queries needed |
| Large files, agent binaries | **R2** | Object storage |
| Bootstrap tokens, rate limits | **KV** | Ephemeral, high-throughput |

---

## 3. Prior Art: Platform Entity Hierarchies

| Platform | Hierarchy | Repo Relationship |
|----------|-----------|-------------------|
| **Vercel** | Team > Project > Deployment | Many projects : one repo (monorepo) |
| **Railway** | Workspace > Project > Service > Deployment | Project = app stack |
| **Render** | Workspace > Project > Environment > Service | Project groups services |
| **Ona/Gitpod** | Project > Environment (workspace) | Shifting from repo-first to project-first |
| **Codespaces** | Repository > Codespace | 1:1 (repo IS the project) |
| **Linear** | Workspace > Team > Project > Issue | N/A (issue tracker) |

**Every successful platform converges on**: Project as the primary organizational unit, linked to a Git repository, with workspaces/deployments as child entities.

---

## 4. Proposed Entity Hierarchy for SAM

```
User
  |
  +-- Project (linked to GitHub repo by repo_id)
        |
        +-- Workspace (ephemeral VM environment)
        |     |
        |     +-- Agent Session (terminal, chat)
        |
        +-- Chat History (persisted conversations)  <-- NEW, in project DO
        +-- Event Log (activity stream)              <-- NEW, in project DO
        +-- Settings (agent config per project)      <-- NEW or moved
```

### Key Design Decisions

1. **Project is the primary navigation unit** (not workspace)
2. **Workspaces always belong to a project** (`project_id` required FK)
3. **Chat history persists beyond workspace lifecycle** (stored in project DO, not VM memory)
4. **Project linked to GitHub repo by `repo_id`** (numeric, stable across renames/transfers)

---

## 5. GitHub Integration: Stable Identifiers

### The Problem with Repo Names

`full_name` (e.g., `owner/repo-name`) is **mutable**. It changes on:
- Repository rename
- Repository transfer (different owner)
- Organization rename

### The Solution

Every GitHub repo has a stable numeric `id` (e.g., `515187740`) that never changes. Also available: `node_id` (Base64, for GraphQL).

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  github_repo_id INTEGER,          -- STABLE numeric ID
  github_repo_full_name TEXT,      -- cached display name (mutable)
  github_repo_node_id TEXT,        -- GraphQL node_id
  name TEXT NOT NULL,
  ...
  UNIQUE(user_id, github_repo_id)
);
```

### Webhook Handling

| Event | Action |
|-------|--------|
| `repository.renamed` | Update `github_repo_full_name` (look up by `repo_id`) |
| `repository.transferred` | Update `github_repo_full_name` (look up by `repo_id`) |
| `repository.deleted` | Mark project as "detached" (preserve data, show warning) |
| `installation_repositories.added` | Optionally auto-create project |

### Mapping: Start 1:1

Start with one project per repository. Defer monorepo support (multiple projects per repo) to a later phase.

---

## 6. Per-Project Durable Object Architecture

### Schema (Inside Project DO's SQLite)

```sql
-- Chat sessions within this project
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,              -- which workspace ran this session
  topic TEXT,                     -- auto-captured from first message
  status TEXT NOT NULL DEFAULT 'active',  -- active, stopped, error
  started_at TEXT NOT NULL,
  ended_at TEXT,
  message_count INTEGER DEFAULT 0
);

-- Individual messages (append-only)
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id),
  role TEXT NOT NULL,             -- user, assistant, system, tool
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT                   -- JSON for tool calls, file ops, etc.
);

-- Project activity stream (append-only)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,       -- workspace_created, session_started, pr_opened, etc.
  actor TEXT,                     -- user_id or 'system'
  workspace_id TEXT,
  payload TEXT,                   -- JSON
  timestamp TEXT NOT NULL
);
```

### Access Pattern

```
Browser -> API Worker -> lookup project DO id in central D1
                      -> forward request to Project Durable Object
                      -> DO handles chat/event operations locally
```

### WebSocket Support

For real-time chat streaming, the project DO can accept WebSocket connections directly using the Hibernatable WebSocket API. This means:
- Chat messages stream through the DO (not just the VM)
- The DO can persist messages as they arrive
- Multiple viewers can connect to the same session via the DO
- When the workspace stops, the DO retains the full conversation

### Migration Strategy

DOs don't have built-in migration tooling. Options:
1. **Version field on DO state** — check schema version on first access, run migrations inline
2. **Lazy migration** — apply schema changes when the DO is next accessed
3. **Background migration worker** — iterate through all project DOs and trigger migration

Recommended: **Version field + lazy migration**. Each DO stores a `schema_version` in its state. On access, if `schema_version < CURRENT_VERSION`, run pending migrations before proceeding.

---

## 7. Session Persistence Model

Learning from Claude Code, Codex CLI, Copilot, and Windsurf:

### Core Principles

1. **Sessions scoped to project** (not just working directory or workspace)
2. **Append-only storage** in project DO SQLite
3. **Resume by session ID** — load full conversation history
4. **Fork** — create new session with history up to fork point
5. **Auto-summarize** — generate session summaries for dashboard display
6. **Compaction** — for very long sessions, summarize older turns

### Message Persistence Flow

```
1. User sends message via browser
2. Message forwarded to VM agent (ACP protocol)
3. VM agent processes, generates response
4. Response streamed back to browser AND to Project DO
5. Project DO persists both user message and assistant response
6. If workspace stops, conversation is preserved in DO
7. User can resume later (from dashboard, different workspace, etc.)
```

### What Gets Persisted vs Ephemeral

| Data | Persisted (in DO) | Ephemeral (in VM) |
|------|-------------------|-------------------|
| Chat messages (user + assistant) | Yes | Also buffered |
| Tool call results (file reads, etc.) | Metadata only | Full content |
| Terminal I/O | No | Yes |
| File diffs | Summary/metadata | Full content |
| Agent process state | No | Yes |

---

## 8. Dashboard Navigation UX

### Proposed Drill-Down Flow

```
Dashboard (project list)
  -> Project Detail (active workspaces, recent sessions, activity feed)
    -> Workspace Detail (status, terminal, logs)
      -> Chat Session (conversation view, resume/fork)
```

### Key UX Patterns (from Vercel, Linear research)

1. **Project list as landing page** — cards showing: repo name, last activity, active workspace count, status
2. **Project switcher in sidebar** — always visible, recently accessed at top
3. **Cmd+K universal search** — search across projects, workspaces, sessions
4. **Breadcrumb trail** — `Dashboard / Project Name / Workspace / Chat Session`
5. **Activity feed per project** — timeline of events (workspace created, session started, PR opened)
6. **Session navigator** — list of past sessions with timestamp, topic, resume/fork actions

---

## 9. Write Hotspot Mitigations

### Current Hotspots That Benefit from This Architecture

| Hotspot | Current | After Project-First |
|---------|---------|-------------------|
| `workspaces.lastActivityAt` | D1 write every 30-180s per workspace | Could move to project DO |
| `nodes.lastHeartbeatAt` + `lastMetrics` | D1 write every 30-60s per node | Keep in D1 (node-scoped, not project-scoped) |
| `task_status_events` (append-only) | D1, grows unbounded | Move to project DO with retention policy |
| Chat messages | **Not persisted at all** | Project DO (solved) |

### Node Heartbeat Optimization (Separate Concern)

Node heartbeats remain in D1 since nodes aren't project-scoped. Potential optimizations:
- Write to KV first (eventual consistency), batch-sync to D1
- Only write to D1 on status change, not every heartbeat
- Archive old metrics to R2

---

## 10. Implementation Phases (Rough)

### Phase 1: Project Entity + Workspace Association
- Add `github_repo_id` to projects table (already partially exists)
- Make `project_id` required on workspaces
- Update workspace creation flow: select project first, then create workspace
- Dashboard shows projects as primary navigation

### Phase 2: Per-Project Durable Objects
- Create Project DO class with SQLite schema
- Implement chat message persistence pipeline (VM -> API -> DO)
- Implement event logging in DO
- Add session resume/fork from DO storage

### Phase 3: Dashboard Chat Navigation (Unblock spec-017)
- Session list on project detail page
- Lightweight chat view with full conversation history from DO
- Recently stopped sessions with metadata
- Real-time session updates via DO WebSocket

### Phase 4: Advanced Features
- Session forking
- Auto-summarization for cross-session memory
- Compaction for long-running sessions
- Activity feed rendering

---

## 11. Open Questions

1. **What happens to existing workspaces without a project?** Migration path needed. Auto-create projects from existing workspace repo associations?

2. **Should tasks (the task system) also move to per-project DOs?** Currently in D1. The `task_status_events` table is append-only and could benefit from DO isolation. But tasks need cross-project queries (user's task dashboard).

3. **DO cost model** — Durable Objects charge per request + storage duration. Need to model cost for: N projects x M sessions x P messages. Is this cheaper than D1 at our scale?

4. **Message size limits** — Agent responses can be very large (full file contents, diffs). Should we store full content or summaries + references? R2 for large payloads?

5. **Offline/detached project behavior** — If the GitHub repo is deleted or the user revokes the GitHub App, the project DO still exists with all its data. What's the UX for this state?

---

## Sources

### Cloudflare Architecture
- [D1 Overview & Limits](https://developers.cloudflare.com/d1/)
- [D1: Database-per-tenant pattern](https://architectingoncloudflare.com/chapter-12/)
- [Durable Objects Overview](https://developers.cloudflare.com/durable-objects/)
- [SQLite in Durable Objects](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- [DO Control/Data Plane Pattern](https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/)
- [Storage Product Comparison](https://developers.cloudflare.com/workers/platform/storage-options/)

### Developer Platform Prior Art
- [Vercel Projects & Deployments](https://vercel.com/docs/getting-started-with-vercel/projects-deployments)
- [Railway Basics](https://docs.railway.com/overview/the-basics)
- [Render Projects & Environments](https://render.com/docs/projects)
- [Gitpod/Ona Rebrand](https://www.theregister.com/2025/09/03/gitpod_rebrands_as_ona/)
- [Linear Conceptual Model](https://linear.app/docs/conceptual-model)

### GitHub Integration
- [GitHub Repo Rename/Transfer Webhooks](https://github.com/orgs/community/discussions/7947)
- [GitHub Global Node IDs](https://docs.github.com/en/graphql/guides/using-global-node-ids)

### AI Session Persistence
- [Claude Code Session Management](https://code.claude.com/docs/en/how-claude-code-works)
- [Codex CLI Session Persistence](https://developers.openai.com/codex/cli/features/)
- [Windsurf Cascade Memories](https://docs.windsurf.com/windsurf/cascade/memories)
