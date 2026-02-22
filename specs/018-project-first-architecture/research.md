# Research: Project-First Architecture

**Date**: 2026-02-22
**Status**: Complete
**Spec**: [spec.md](./spec.md)

## Research Summary

This document resolves all technical unknowns identified during planning. The prior research document (`docs/architecture/project-first-research.md`, merged via PR #131) established the high-level hybrid D1+DO architecture. This research addresses implementation-specific decisions.

---

## Decision 1: Per-Project Durable Object vs Per-Project D1

### Decision: Per-project Durable Object with embedded SQLite

### Rationale

Projects are isolated units with no cross-project relationships. Both per-project D1 and per-project DO could provide data isolation. We choose DO because:

1. **Co-located compute + storage**: DO runs code next to its SQLite database with zero network hops. D1 requires a network round-trip from the Worker to the database.
2. **Auto-provisioning**: DOs are created on first access via `env.PROJECT_DATA.idFromName(projectId)`. Per-project D1 would require explicit database creation, binding management, and routing logic.
3. **Native WebSocket support**: Hibernatable WebSockets enable real-time chat streaming through the DO at near-zero idle cost. D1 has no WebSocket capability.
4. **Schema migrations in constructor**: DO migrations run via `blockConcurrencyWhile()` in the constructor — no external migration tooling needed. Per-project D1 would require running migrations across N databases.
5. **Simpler Worker bindings**: One DO namespace binding (`PROJECT_DATA`) vs up to 5,000 D1 bindings per Worker.
6. **Storage cost advantage at scale**: DO SQLite is $0.20/GB-month vs D1's $0.75/GB-month (3.75x cheaper).

### Alternatives Considered

| Alternative | Rejected Because |
|-------------|-----------------|
| Per-project D1 databases | Higher operational overhead (provisioning, binding management, migration orchestration), no WebSocket support, 3.75x more expensive storage, max 5,000 bindings per Worker |
| Single central D1 for everything | Single-writer bottleneck for chat messages and task events at scale. Concurrent agent activity across projects would queue behind a single write path. |
| R2 for message storage | No SQL query capability. Would require loading entire session history to filter/sort. Not suitable for structured data with indexes. |

### References

- [Cloudflare D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) — D1 recommends horizontal sharding per-entity
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) — "Create one DO per logical unit that needs coordination"
- [Control/Data Plane Pattern](https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/)

---

## Decision 2: Task Data Storage Location

### Decision: Tasks remain in central D1 (current state). Task status events move to per-project DO with async summary sync to D1.

### Rationale

Tasks have a dual access pattern:

1. **Project-scoped operations** (create subtask, update status, delegation): Project-scoped, write-heavy when agents are active. Naturally fits DO.
2. **Cross-project queries** (user's task dashboard, "show all my tasks"): Requires querying across projects. D1 handles this natively.

The pragmatic approach for the current single-user scale:

- **Task metadata** (title, status, priority, assignment) stays in D1 — enables cross-project queries for the dashboard and is sufficient for current write volumes.
- **Task status events** (append-only audit trail, currently growing unbounded in D1) move to the per-project DO — bounded by project scope, benefits from DO isolation and retention policies.
- **Future migration path**: When agent-driven subtask decomposition makes task writes a bottleneck, move task CRUD to per-project DO and sync summaries to D1 via change data capture. The project isolation in the data model makes this migration straightforward.

### Alternatives Considered

| Alternative | Rejected Because |
|-------------|-----------------|
| Move all tasks to DO now | Cross-project task dashboard would require fan-out queries across all project DOs — unnecessary complexity for current scale |
| Keep task status events in D1 | Append-only, unbounded growth in a single-writer database. Already flagged as a write hotspot. |

---

## Decision 3: Durable Object Naming Strategy

### Decision: Use `idFromName(projectId)` with the project's UUID as the DO name

### Rationale

- Project IDs are globally unique UUIDs generated at project creation time
- `idFromName()` is deterministic — the same project ID always resolves to the same DO instance
- No need for a separate mapping table (D1 already has the project record)
- The DO ID can be derived from any context that has the project ID

### Access Pattern

```
Worker receives request with projectId
  → const id = env.PROJECT_DATA.idFromName(projectId)
  → const stub = env.PROJECT_DATA.get(id)
  → await stub.someMethod(args)
```

---

## Decision 4: Chat Message Persistence Pipeline

### Decision: Dual-write from API Worker — messages forwarded to both browser (existing WebSocket) and project DO (new persistence path)

### Rationale

The current ACP (Agent Communication Protocol) flow is:

```
User browser <-> API Worker (proxy) <-> VM Agent (on Hetzner node)
```

Messages flow through the API Worker as a WebSocket proxy. The persistence pipeline taps into this existing flow:

```
User browser <-> API Worker <-> VM Agent
                     |
                     +-> Project DO (persist message)
```

The API Worker already sees every message passing through. Adding a DO write is a single additional async call per message. This avoids modifying the VM Agent (Go binary) and keeps persistence logic in the TypeScript Worker.

### Message Flow Detail

1. User sends message via browser WebSocket → API Worker receives it
2. API Worker forwards to VM Agent (existing behavior)
3. API Worker **also** calls `projectDO.persistMessage(sessionId, message)` (new)
4. VM Agent processes, generates response → streams back through API Worker
5. API Worker forwards assistant response to browser (existing)
6. API Worker **also** calls `projectDO.persistMessage(sessionId, response)` (new)

### Error Handling

- Message persistence failures are **non-blocking** — the chat continues even if DO write fails
- Failed writes are logged and can be retried via a dead-letter mechanism
- The DO is the source of truth for persisted history; the browser buffer is ephemeral

### Alternatives Considered

| Alternative | Rejected Because |
|-------------|-----------------|
| VM Agent writes directly to DO | Requires Go code changes, network path from Hetzner VM to Cloudflare DO, and authentication for DO access |
| Browser writes to DO after receiving | Client-side persistence is unreliable (network issues, tab close, etc.) |
| Batch persist on session end | Loses messages if workspace crashes or is force-stopped |

---

## Decision 5: Hibernatable WebSocket Strategy

### Decision: Use Hibernatable WebSockets on the per-project DO for real-time session streaming and activity feed updates

### Rationale

- **Idle connections cost $0** with Hibernatable WebSockets (the DO evicts from memory while maintaining connections)
- Auto-response to ping/pong without waking the DO
- Multiple clients can connect to the same project DO for real-time updates (session list changes, new activity events)
- WebSocket connection is the natural transport for streaming chat messages in real time

### Connection Types

| Connection | Purpose | Wake Frequency |
|------------|---------|----------------|
| Chat session viewer | Stream new messages for active session | Per message (~seconds) |
| Project dashboard | Activity feed updates, session status changes | Per event (~minutes) |
| Idle monitoring | No active sessions, just checking for updates | Hibernated, wakes on event |

### Alternatives Considered

| Alternative | Rejected Because |
|-------------|-----------------|
| Polling from browser | Higher latency, unnecessary API load, poor UX for real-time chat |
| Server-Sent Events (SSE) | Workers have limited SSE support; WebSocket is the native Cloudflare pattern for DOs |
| Non-hibernatable WebSockets | Idle connections would incur continuous duration charges |

---

## Decision 6: DO SQLite Schema Migration Strategy

### Decision: Constructor-based lazy migration with a `migrations` tracking table

### Rationale

Durable Objects don't have built-in migration tooling like D1. The recommended pattern is:

1. Define migrations as ordered, named functions
2. Track applied migrations in a `migrations` table within the DO's SQLite
3. Run pending migrations in `blockConcurrencyWhile()` during DO construction
4. Wrap in `transactionSync()` for atomicity

This is the pattern recommended by Cloudflare's best practices guide and used by `durable-utils` and `@cloudflare/actors`.

### Implementation Pattern

```typescript
export class ProjectData extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(() => {
      ctx.storage.transactionSync(() => {
        this.runMigrations()
      })
    })
  }

  private runMigrations() {
    const db = this.ctx.storage.sql
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`)
    const applied = new Set(
      db.exec('SELECT name FROM migrations').toArray().map(r => r.name as string)
    )
    for (const migration of MIGRATIONS) {
      if (!applied.has(migration.name)) {
        migration.run(db)
        db.exec('INSERT INTO migrations (name, applied_at) VALUES (?, ?)',
          migration.name, Date.now())
      }
    }
  }
}
```

### Alternatives Considered

| Alternative | Rejected Because |
|-------------|-----------------|
| `durable-utils` library | External dependency for a simple pattern. The migration runner is ~30 lines of code. |
| `PRAGMA user_version` | Not supported by DO SQLite storage |
| Background migration worker | Unnecessary complexity; lazy migration on access is sufficient and guarantees schema is current before any operation |

---

## Decision 7: Cross-Project Dashboard Queries

### Decision: D1 remains the source of truth for cross-project dashboard views. Project DOs sync summary data to D1 asynchronously.

### Rationale

The user's dashboard needs:
- "Show all my projects with activity summaries" — cross-project query
- "Show all my tasks across projects" — cross-project query
- "How many active sessions do I have?" — cross-project aggregation

These are read-heavy, cross-project queries that D1 handles natively. Fan-out to N project DOs for every dashboard load would add latency and complexity.

### Sync Strategy

The project DO pushes lightweight summary updates to D1 on significant state changes:

| Event | What gets synced to D1 |
|-------|----------------------|
| Chat session created/stopped | Project's `last_activity_at`, session count |
| Activity event recorded | Project's `last_activity_at` |
| Task status changed | Task record in D1 (already there) |

This follows the [checkpoint synchronization pattern](https://lord.technology/2026/01/12/rethinking-state-at-the-edge-with-cloudflare-durable-objects.html) — accepts seconds of staleness in D1 in exchange for reduced write amplification.

### Implementation

The DO calls back to the API Worker (or directly to D1 via an env binding) to update summary fields. This keeps the sync lightweight and event-driven rather than polling-based.

---

## Decision 8: GitHub Repo Identity — Stable Numeric ID

### Decision: Add `github_repo_id` (INTEGER) to the projects table as the stable, immutable link. Keep `repository` (TEXT, `owner/repo`) as the cached display name.

### Rationale

- GitHub's numeric `id` never changes across renames, transfers, or org renames
- The current `repository` field stores `owner/repo` which is mutable
- Adding `github_repo_id` enables: unique constraint per user per repo, webhook-driven name updates, transfer resilience
- Uniqueness constraint: `UNIQUE(user_id, github_repo_id)` prevents duplicate projects for the same repo

### Migration

1. Add `github_repo_id INTEGER` column (nullable initially for existing data)
2. Backfill from GitHub API for existing projects
3. Make non-null after backfill
4. Add unique index on `(user_id, github_repo_id)`

### Webhook Handling

| Webhook Event | Action |
|---------------|--------|
| `repository.renamed` | Update `repository` field (lookup by `github_repo_id`) |
| `repository.transferred` | Update `repository` field (lookup by `github_repo_id`) |
| `repository.deleted` | Set project status to `detached`, preserve all data |

---

## Decision 9: Workspace projectId — Required vs Optional

### Decision: Make `projectId` required for new workspace creation. Existing workspaces without a project are migrated automatically.

### Rationale

- The spec requires every workspace to belong to a project (FR-007, FR-011)
- Current schema has `projectId` as nullable (`references(() => projects.id, { onDelete: 'set null' })`)
- Migration strategy: On first access after deployment, auto-create projects for any orphaned workspaces based on their `repository` field

### Migration Approach

1. D1 migration adds NOT NULL constraint with a default placeholder
2. Background task iterates orphaned workspaces → creates/matches projects → updates `projectId`
3. API validation enforced immediately for new workspace creation
4. Existing API consumers (UI) already support project context for workspace creation

---

## Decision 10: Cost Model Validation

### Decision: Proceed with DO architecture. Cost is negligible at current scale ($5/month minimum) and scales favorably.

### Analysis

At the specified scale (50 projects, 5,000 sessions, 250,000 messages):

| Component | Monthly Cost |
|-----------|-------------|
| DO Requests | $0 (within 1M included) |
| DO Duration | $0 (within 400K GB-s included, Hibernatable WebSockets eliminate idle cost) |
| DO SQLite Storage | $0 (within 5GB included; estimated 141MB total) |
| DO SQLite Row Ops | $0 (within included limits) |
| **Total** | **$5/month** (Workers Paid plan minimum) |

At 1000x scale (50,000 projects), DO SQLite is 3.75x cheaper than D1 for storage ($0.20/GB vs $0.75/GB), saving ~$74/month on storage alone.

### References

- [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)

---

## Sources

### Cloudflare Architecture
- [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Rules of Durable Objects (Dec 2025)](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Control/Data Plane Pattern](https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/)
- [Zero-latency SQLite in DO](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- [Hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Rethinking State at the Edge — Jamie Lord (Jan 2026)](https://lord.technology/2026/01/12/rethinking-state-at-the-edge-with-cloudflare-durable-objects.html)

### Integration Patterns
- [One Database Per User with DOs — Boris Tane](https://boristane.com/blog/durable-objects-database-per-user/)
- [DO SQLite Migrations — Cris-O](https://www.cris-o.com/notes/sqlite-migrations-durable-objects/)
- [durable-utils (migration library)](https://github.com/lambrospetrou/durable-utils)

### Prior Art
- [Linear Multi-Region Architecture](https://linear.app/now/how-we-built-multi-region-support-for-linear)
- [Task Tree Agent (Hierarchical Task Management)](https://github.com/SuperpoweredAI/task-tree-agent)
