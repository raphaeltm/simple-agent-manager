# Durable Objects in SAM

This document explains what Cloudflare Durable Objects are, why they're valuable, and how SAM uses them to solve specific architectural challenges.

## What Are Durable Objects?

Durable Objects (DOs) are a Cloudflare Workers primitive that provides **stateful, single-threaded, globally distributed objects** with built-in persistent storage. They solve the fundamental tension in serverless computing: Workers are stateless and ephemeral, but real applications need state.

Each DO instance:

- Has a **unique identity** derived from a deterministic ID
- Runs in a **single-threaded context** (no concurrent access, no race conditions)
- Has **private, persistent storage** (either key-value or embedded SQLite)
- Can accept **WebSocket connections** that survive hibernation
- Can set **alarms** that fire at future times, surviving eviction and restarts

You can create millions of DO instances. Cloudflare automatically decides where each one lives and can migrate them transparently.

## General Benefits

### Strong Consistency Without Infrastructure

Each DO instance is single-threaded — there is no concurrent access to worry about. Storage reads and writes are transactional and strongly consistent. This is the opposite of eventually-consistent systems like Workers KV, and you get it without managing a database server, connection pools, or distributed locks.

### Actor Model at the Edge

DOs implement the [actor model](https://en.wikipedia.org/wiki/Actor_model) natively. Each instance processes requests sequentially in its own isolated context, keyed by a deterministic ID. This maps naturally to per-user, per-session, per-project, and per-resource patterns — exactly the kind of boundaries real applications have.

### Zero-Cost Idle with Hibernatable WebSockets

DOs support WebSocket connections that hibernate when idle. The DO is evicted from memory, but the WebSocket stays open. When a message arrives, the DO is rehydrated and processes it. Real-time features cost nothing when nobody is actively sending data.

### Alarm-Based Scheduling

DOs can set alarms that fire at specified future times. Unlike `setTimeout()` in a Worker (which is lost on eviction), DO alarms are durable — they survive eviction, restarts, and even datacenter migrations. This enables reliable timeouts, cleanup routines, and multi-step workflows without external scheduling infrastructure.

### Embedded SQLite

DOs can use SQLite as their storage backend (declared via `new_sqlite_classes` in wrangler migrations). This gives each DO instance a full relational database with indexes, complex queries, and structured data modeling — a per-entity embedded database that lives alongside the compute.

### Automatic Write Coalescing

Multiple `put()` or `delete()` calls are automatically batched and written atomically. In a power failure, either all writes persist or none do. This is free correctness that would normally require explicit transaction management.

### No Region Management

Cloudflare determines the datacenter for each DO instance and can migrate objects between locations as needed. You design your storage model around your application's logical data model, not around regions or availability zones.

## SAM's Durable Object Architecture

SAM uses a **hybrid D1 + Durable Object architecture** (see [ADR 004](../adr/004-hybrid-d1-do-storage.md)):

- **D1** (central relational database): Users, projects, workspaces, nodes, tasks, credentials — anything needing cross-project queries, JOINs, or global views
- **Durable Objects** (per-entity): Chat messages, activity events, session state, lifecycle coordination — anything with high write throughput, real-time requirements, or entity-scoped state

Summary data flows from DOs back to D1 via debounced sync, so dashboards get aggregated views without querying every DO individually.

```
Browser <-> API Worker <-> D1 (projects, tasks, users, cross-project queries)
                |
                +-> ProjectData DO (chat, activity, WebSocket streaming)
                |       |
                |       +-> D1 (summary sync, debounced)
                |
                +-> NodeLifecycle DO (warm pool state machine, alarm-based cleanup)
                |       |
                |       +-> D1 (warm_since sync)
                |
                +-> TaskRunner DO (alarm-driven multi-step orchestration)
                |       |
                |       +-> NodeLifecycle DO (warm node claiming)
                |       +-> ProjectData DO (session creation)
                |
                +-> AdminLogs DO (real-time log broadcast via WebSocket)
```

## The Four Durable Objects

All DO implementations live in `apps/api/src/durable-objects/`. Each has a corresponding service wrapper in `apps/api/src/services/` providing typed RPC methods.

### 1. ProjectData — Per-Project Data Store

**Problem:** Chat messages arrive at high frequency (multiple per second per project). Writing every message to D1 would create write contention and latency. But cross-project queries still need to work for dashboards.

**Solution:** One DO per project, keyed by `env.PROJECT_DATA.idFromName(projectId)`, using embedded SQLite.

**SQLite tables:**

| Table | Purpose |
|-------|---------|
| `chat_sessions` | Session metadata, lifecycle status, message counts |
| `chat_messages` | Append-only streaming token log — each row is one streaming chunk from Claude Code, not a logical message. Consecutive same-role tokens (assistant, tool, thinking) are grouped into logical messages at the API and UI layers. The `sequence` field orders tokens within the same millisecond. |
| `activity_events` | Audit trail (workspace created, session stopped, etc.) |
| `task_status_events` | Task lifecycle transitions with actor tracking |
| `acp_sessions` | ACP session state machine with fork lineage |
| `acp_session_events` | ACP session state transition history |

**Key design choices:**

- **Hibernatable WebSockets** for real-time chat streaming at zero idle cost
- **Debounced D1 summary sync** (configurable via `DO_SUMMARY_SYNC_DEBOUNCE_MS`, default 5s) pushes last-activity timestamps and session counts to D1 so dashboards work without fan-out
- **ACP session state machine** (pending → assigned → running → completed/failed/interrupted) with heartbeat-based VM failure detection via DO alarms
- **Session forking** with parent lineage tracking for conversation branching

This is SAM's largest DO (~70KB of implementation) — effectively a per-project microservice.

**Service wrapper:** `apps/api/src/services/project-data.ts` — exports `createSession`, `persistMessage`, `persistMessageBatch`, `listSessions`, `getMessages`, `linkSessionToWorkspace`, `stopSession`, and more.

### 2. NodeLifecycle — Warm Pool State Machine

**Problem:** After a task completes, the VM is still running and configured. Destroying it immediately wastes provisioning cost. Leaving it running forever wastes money. You need coordinated lifecycle management with reliable, guaranteed cleanup.

**Solution:** One DO per node, keyed by `env.NODE_LIFECYCLE.idFromName(nodeId)`, managing a three-state machine:

```
active → warm → destroying
```

**Stored state:**

```typescript
interface StoredState {
  nodeId: string;
  userId: string;
  status: 'active' | 'warm' | 'destroying';
  warmSince: number | null;
  claimedByTask: string | null;
}
```

**Key design choices:**

- When a task finishes, the node is marked `warm` with an alarm set for the idle timeout (configurable via `NODE_WARM_TIMEOUT_MS`, default 30 minutes)
- New tasks atomically claim warm nodes via `tryClaim(taskId)` — single-threaded execution prevents two tasks from claiming the same node
- **Three-layer defense against orphaned VMs:** DO alarm + cron sweep + max lifetime
- Syncs `warm_since` back to D1 for cross-project warm node queries

The DO alarm is critical here. A `setTimeout()` in a Worker would be lost on eviction. The alarm guarantees that warm nodes are cleaned up even if no requests arrive for hours.

**Service wrapper:** `apps/api/src/services/node-lifecycle.ts` — exports `markIdle`, `markActive`, `tryClaim`, `getStatus`.

### 3. TaskRunner — Alarm-Driven Task Orchestration

**Problem:** Task execution is a multi-step process (select node → provision → create workspace → wait for agent → run). Workers' `waitUntil()` is unreliable for long-running orchestration — if the Worker is evicted mid-execution, progress is lost.

**Solution:** One DO per task, keyed by `env.TASK_RUNNER.idFromName(taskId)`, driving execution through idempotent steps via alarm callbacks:

```
node_selection → node_provisioning → node_agent_ready →
workspace_creation → workspace_ready → agent_session → running
```

**Key design choices:**

- **Each step is idempotent** — if the DO is evicted and the alarm re-fires, the step re-executes safely
- **Exponential backoff** for transient errors (configurable max retries, base/max delays)
- **Cross-DO coordination**: calls NodeLifecycle for warm node claiming, ProjectData for ACP session creation
- **Callback-driven readiness**: the VM agent signals the DO when workspace is ready, rather than polling

This replaced an earlier `waitUntil()` approach that lost state on Worker eviction. The alarm-driven pattern is the canonical way to build reliable multi-step workflows on Cloudflare Workers.

**Service wrapper:** `apps/api/src/services/task-runner-do.ts` — exports `startTaskRunnerDO`, `advanceTaskRunnerWorkspaceReady`, `getTaskRunnerStatus`.

### 4. AdminLogs — Real-Time Log Streaming

**Problem:** Admins need to see live platform logs without polling. A traditional approach would require a persistent WebSocket server — expensive to run 24/7 even when no admin is watching.

**Solution:** A singleton DO keyed by `env.ADMIN_LOGS.idFromName('admin-logs')`. Receives log events from a Tail Worker via POST, broadcasts to connected admin WebSocket clients.

**Key design choices:**

- **In-memory ring buffer** (configurable size via `OBSERVABILITY_STREAM_BUFFER_SIZE`, default 1000 entries) for log replay when new clients connect
- **Per-client filtering** by log level and search terms via `serializeAttachment()`
- **Hibernatable WebSockets** — when no admin is connected, the DO hibernates and costs nothing
- **Pause/resume** support per client

**Used directly** in `apps/api/src/routes/admin.ts` at the `/api/admin/logs/stream` WebSocket endpoint.

## Wrangler Configuration

All four DOs are declared in `apps/api/wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "PROJECT_DATA"
class_name = "ProjectData"

[[durable_objects.bindings]]
name = "NODE_LIFECYCLE"
class_name = "NodeLifecycle"

[[durable_objects.bindings]]
name = "ADMIN_LOGS"
class_name = "AdminLogs"

[[durable_objects.bindings]]
name = "TASK_RUNNER"
class_name = "TaskRunner"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ProjectData"]    # Embedded SQLite

[[migrations]]
tag = "v2"
new_classes = ["NodeLifecycle"]          # KV storage

[[migrations]]
tag = "v3"
new_classes = ["AdminLogs"]             # KV storage

[[migrations]]
tag = "v4"
new_classes = ["TaskRunner"]            # KV storage
```

Note: Only ProjectData uses `new_sqlite_classes` (embedded SQLite). The others use `new_classes` (plain KV storage), since their state is simple enough not to need relational queries.

## Configurable Parameters

All DO timeouts and limits are environment-configurable per [Principle XI (No Hardcoded Values)](../../.specify/memory/constitution.md):

| Component | Environment Variable | Default | Purpose |
|-----------|---------------------|---------|---------|
| NodeLifecycle | `NODE_WARM_TIMEOUT_MS` | 1,800,000 (30 min) | Idle timeout before warm node cleanup |
| NodeLifecycle | `NODE_LIFECYCLE_ALARM_RETRY_MS` | 60,000 (1 min) | Retry delay for D1 sync failures |
| TaskRunner | `TASK_RUNNER_STEP_MAX_RETRIES` | 3 | Max retries per orchestration step |
| TaskRunner | `TASK_RUNNER_RETRY_BASE_DELAY_MS` | 5,000 | Initial backoff delay |
| TaskRunner | `TASK_RUNNER_RETRY_MAX_DELAY_MS` | 60,000 | Maximum backoff delay |
| TaskRunner | `TASK_RUNNER_AGENT_POLL_INTERVAL_MS` | 5,000 | Poll interval for agent readiness |
| TaskRunner | `TASK_RUNNER_AGENT_READY_TIMEOUT_MS` | 600,000 (10 min) | Max wait for agent startup |
| ProjectData | `DO_SUMMARY_SYNC_DEBOUNCE_MS` | 5,000 | Debounce interval for D1 summary sync |
| AdminLogs | `OBSERVABILITY_STREAM_BUFFER_SIZE` | 1,000 | Ring buffer size for log replay |

## Why DOs Over Alternatives

| Need | Alternative | Why DO Wins |
|------|------------|-------------|
| Per-project chat storage | D1 (shared database) | DOs eliminate write contention — each project writes to its own isolated SQLite |
| Warm pool coordination | Redis or external state store | DOs are single-threaded — `tryClaim()` is atomic without distributed locks |
| Multi-step task orchestration | External queue (SQS, etc.) | DO alarms are durable and built-in — no external infrastructure |
| Real-time log streaming | Polling API | Hibernatable WebSockets cost $0 idle — no always-on server |
| Node cleanup timers | External cron service | DO alarms survive eviction — `setTimeout()` in Workers does not |

## Further Reading

- [ADR 004: Hybrid D1 + DO Storage Architecture](../adr/004-hybrid-d1-do-storage.md) — the decision record for this architecture
- [Cloudflare Durable Objects docs](https://developers.cloudflare.com/durable-objects/)
- [Durable Objects: Easy, Fast, Correct — Choose Three](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
- [SQLite in Durable Objects](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- [Hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
