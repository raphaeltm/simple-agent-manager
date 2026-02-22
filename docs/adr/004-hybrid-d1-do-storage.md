# ADR 004: Hybrid D1 + Durable Object Storage Architecture

**Status**: Accepted
**Date**: 2026-02-22
**Deciders**: Development Team
**Relates To**: ADR 002 (Stateless Architecture, superseded), spec 018 (Project-First Architecture)

## Context

SAM's project-first architecture requires per-project data storage for chat sessions, messages, activity events, and task status events. These are write-heavy, project-scoped data streams that benefit from isolation. Meanwhile, cross-project queries (dashboard, task lists) need a centralized query path.

The original stateless architecture (ADR 002) was superseded by Cloudflare D1 for workspace metadata. As the platform adds chat persistence and activity tracking, the storage architecture needs to accommodate:

1. **High-throughput writes**: Chat messages during active agent sessions (multiple messages per second)
2. **Per-project isolation**: No cross-project data leakage; independent scaling
3. **Real-time streaming**: WebSocket-based live updates for chat and activity feeds
4. **Cross-project queries**: Dashboard aggregations across all user projects
5. **Cost efficiency**: Minimal cost at idle; scale with usage

## Decision

Use a **hybrid D1 + Durable Object** architecture:

- **D1 (central)**: Platform metadata, user accounts, project records, task definitions, cross-project dashboard queries
- **Durable Objects with embedded SQLite (per-project)**: Chat sessions, chat messages, activity events, task status events, real-time WebSocket connections

Each project gets its own DO instance via `env.PROJECT_DATA.idFromName(projectId)`. The DO manages its own SQLite schema via constructor-based lazy migrations.

Summary data (last activity timestamp, active session count) is synced from DO to D1 asynchronously via a debounced callback, enabling cross-project dashboard queries without fan-out.

### Data Flow

```
Browser <-> API Worker <-> D1 (projects, tasks, users)
                |
                +-> Project DO (chat, activity, WebSocket)
                        |
                        +-> D1 (summary sync, debounced)
```

### Schema Ownership

| Data | Storage | Reason |
|------|---------|--------|
| Users, sessions, credentials | D1 | Auth queries, cross-user |
| Projects (metadata) | D1 | Cross-project dashboard |
| Tasks (definitions) | D1 | Cross-project task views |
| Workspaces, nodes | D1 | Cross-project lifecycle |
| Chat sessions | DO SQLite | Per-project, write-heavy |
| Chat messages | DO SQLite | Per-project, append-only |
| Activity events | DO SQLite | Per-project, append-only |
| Task status events | DO SQLite | Per-project audit trail |

## Consequences

### Positive

- **Zero-hop reads/writes** within a project DO (co-located compute + storage)
- **Native WebSocket support** via Hibernatable WebSockets ($0 idle cost)
- **Auto-provisioning**: DOs created on first access, no explicit database creation
- **Schema migrations** in DO constructor via `blockConcurrencyWhile()` — no external tooling
- **One binding** (`PROJECT_DATA`) vs up to 5,000 D1 bindings
- **3.75x cheaper storage** ($0.20/GB vs $0.75/GB for D1)
- **Natural isolation boundary** per project — no accidental cross-project data access

### Negative

- **No cross-DO queries**: Dashboard data requires D1 summary sync (seconds of staleness)
- **Two storage systems** to understand and maintain
- **DO migrations** are custom code (not Wrangler-managed like D1)
- **Debugging** requires understanding which data lives where

### Self-Hosting Implications

Self-hosters need:
- `PROJECT_DATA` Durable Object namespace binding in `wrangler.toml`
- SQLite storage class configured for the DO
- New configurable env vars for DO limits (see `.env.example`)

## Alternatives Considered

| Alternative | Rejected Because |
|-------------|-----------------|
| All data in D1 | Single-writer bottleneck for chat messages; no WebSocket support; higher storage cost |
| All data in DOs | Cross-project dashboard queries require fan-out to N DOs |
| Per-project D1 databases | Higher operational overhead (provisioning, binding management, migration orchestration); max 5,000 bindings per Worker |
| R2 for message storage | No SQL query capability; not suitable for structured data with indexes |

## References

- [Cloudflare DO SQLite](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- [Hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [DO Best Practices](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Control/Data Plane Pattern](https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/)
- `specs/018-project-first-architecture/research.md` — Full research and cost analysis
