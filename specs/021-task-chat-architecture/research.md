# Research: Task-Driven Chat Architecture & Autonomous Workspace Execution

**Date**: 2026-02-24
**Spec**: [spec.md](./spec.md)

## Executive Summary

This research resolves all technical unknowns for spec 021. Five parallel research tracks were conducted: VM agent ACP session internals, task runner/provisioning flow, web UI architecture, Go message persistence patterns, and warm node pooling strategies. All decisions below are grounded in codebase analysis and industry prior art.

---

## Decision 1: VM Agent Message Persistence Architecture

**Decision**: SQLite-backed Transactional Outbox Pattern with batched HTTP POST to control plane API.

**Rationale**:
- The vm-agent already depends on `modernc.org/sqlite` v1.45.0 (pure Go, no CGo) for session persistence. Adding an outbox table to the existing SQLite database provides crash recovery with zero new dependencies for storage.
- Messages survive SIGKILL because they are written to WAL-mode SQLite before being sent.
- The existing `errorreport.Reporter` (`packages/vm-agent/internal/errorreport/reporter.go`) uses an identical pattern (in-memory queue + periodic flush + batch POST) but without persistence or retry. The message reporter extends this with SQLite durability and exponential backoff.
- The `BootLogReporter` (`packages/vm-agent/internal/bootlog/reporter.go`) demonstrates the dual-path pattern (local broadcast + HTTP relay) and graceful degradation when no token is available.

**Alternatives Considered**:
| Alternative | Why Rejected |
|---|---|
| In-memory channel only | No crash safety; messages lost on SIGKILL/OOM |
| `tidwall/wal` (append-only log) | Lacks SELECT/DELETE semantics needed for "read pending, send, mark done" |
| `maragudk/goqite` (SQLite queue) | SQS-like semantics are overkill; message rate (tens-hundreds/session) doesn't need visibility timeouts |
| Direct POST per message | Poor network efficiency; doesn't handle bursts during active AI chat |

**Prior Art**:
- OpenTelemetry Collector: persistent queue via bbolt + QueueBatch → RetrySender → exporter chain
- Fluent Bit: chunk-based filesystem buffering with scheduler retry
- Grafana Promtail: per-tenant batch accumulation with BatchWait/BatchSize

---

## Decision 2: HTTP Retry Library

**Decision**: `cenkalti/backoff/v5` (MIT license, ~3,900 stars, v5.0.0, Jul 2025)

**Rationale**:
- Pure backoff algorithm decoupled from HTTP transport. For a queue consumer that manages its own retry loop, this gives the right abstraction without coupling retry logic to individual HTTP requests.
- Context-aware cancellation (critical for graceful shutdown).
- Used internally by OpenTelemetry Collector.
- MIT license, zero transitive dependencies.
- Only 1 new dependency added to `go.mod`.

**Alternatives Considered**:
| Alternative | Why Rejected |
|---|---|
| `hashicorp/go-retryablehttp` v0.7.8 | MPL-2.0 license; designed as drop-in HTTP client replacement, not for queue consumer retry loops |
| Standard library custom retry | More boilerplate; no jitter or context-aware retry built-in |

**Configuration** (all configurable via env vars per Principle XI):
- `MSG_RETRY_INITIAL_INTERVAL`: 1s (default)
- `MSG_RETRY_MAX_INTERVAL`: 30s (default)
- `MSG_RETRY_MAX_ELAPSED_TIME`: 5min (default)

---

## Decision 3: Message Batching Strategy

**Decision**: Time-or-size batching with near-real-time defaults.

| Parameter | Default | Env Var |
|---|---|---|
| Max wait between flushes | 2 seconds | `MSG_BATCH_MAX_WAIT_MS` |
| Max messages per batch | 50 | `MSG_BATCH_MAX_SIZE` |
| Max bytes per batch | 64 KB | `MSG_BATCH_MAX_BYTES` |
| Max outbox size | 10,000 messages | `MSG_OUTBOX_MAX_SIZE` |

**Rationale**:
- **2-second max wait** provides near-real-time viewing on the project page while still batching multiple rapid messages (tool calls, streaming assistant responses).
- **50 message threshold** handles bursts during active AI chat without waiting for the timer.
- **64 KB byte limit** prevents oversized payloads from causing HTTP timeouts.
- **10,000 outbox limit** prevents unbounded disk growth if the API is unreachable for extended periods.

**Error Classification** (from Promtail pattern):
- Retry: 429, 500, 502, 503, 504, connection errors, DNS failures, timeouts
- Discard (permanent): 400, 401, 403, 404, 409 (bugs in sender, not transient)

**Partial Failure Handling**: If a batch POST fails, the entire batch stays in the SQLite outbox for retry. No partial success parsing. The API endpoint is idempotent via message_id deduplication.

---

## Decision 4: Warm Node Idle Timeout

**Decision**: Durable Object Alarms (primary) + Cron Trigger sweep (secondary safety net).

**Rationale**:
- DO Alarms have guaranteed at-least-once execution with automatic retries (exponential backoff, up to 6 retries).
- Each DO is single-threaded, eliminating race conditions between `markIdle()` and `markActive()`.
- `setAlarm()` overwrites existing alarms, making timeout reset trivial on new activity.
- DO can hibernate while waiting for the alarm, incurring zero duration charges.
- Alarms persist in DO storage, surviving DO eviction.

**Alternatives Considered**:
| Alternative | Why Rejected |
|---|---|
| Cron trigger only | 1-5 minute polling granularity; imprecise timing; cross-tenant D1 queries |
| Heartbeat-based detection | Previously disabled in SAM due to unreliability; two failure domains (VM + API); clock drift risk |
| D1 polling with warm_since column | Requires separate mechanism for the timeout; two sources of truth |

**Three-Layer Defense**:
1. **Layer 1 (Precise)**: DO alarm fires exactly N minutes after node becomes idle. Handles 99%+ of cases.
2. **Layer 2 (Sweep)**: Cron trigger every 15 minutes catches anything Layer 1 missed.
3. **Layer 3 (Hard ceiling)**: Maximum auto-provisioned node lifetime prevents unbounded cost (default 4 hours, configurable via `MAX_AUTO_NODE_LIFETIME_MS`).

**Prior Art**:
- AWS Lambda: 15-45 minute warm execution environments
- Google Cloud Run: 15-minute idle instance retention
- Fly.io: proxy-driven 5-minute autostop with autorestart

---

## Decision 5: Concurrent Node Claiming

**Decision**: Durable Object as single-threaded coordinator via `tryClaim(taskId)` method.

**Rationale**:
- Same DO (NodeLifecycle) that manages the idle alarm also handles node claiming. One atomic component for both concerns.
- DOs process requests serially. If two tasks call `tryClaim()` simultaneously, one executes first and transitions status to "active"; the second sees the changed status and returns false.
- Analogous to Kubernetes scheduling: serial scheduling cycles prevent double allocation, optimistic concurrency for binding.

**Alternatives Considered**:
| Alternative | Why Rejected |
|---|---|
| D1 `UPDATE ... WHERE status='warm'` | Sufficient for low concurrency but creates two sources of truth (D1 + DO) for node state |
| CAS with version column | Functionally equivalent to WHERE clause for SQLite; unnecessary complexity |

**Integration**: The node selector in `selectNodeForTaskRun()` is updated to:
1. Query D1 for running/warm nodes (existing pattern)
2. For warm nodes, call `nodeLifecycleDO.tryClaim(taskId)` — first one wins
3. If no warm node claimed, auto-provision new node

---

## Decision 6: New Durable Object Class — NodeLifecycle

**Decision**: Create a new `NodeLifecycle` Durable Object class keyed by node ID.

**Storage Schema**:
- `nodeId`: string
- `userId`: string
- `status`: 'active' | 'warm' | 'destroying'
- `claimedByTask`: string | null
- `warmSince`: ISO 8601 timestamp | null

**Methods**:
- `markIdle(nodeId, userId)`: Set status='warm', schedule alarm
- `markActive()`: Set status='active', cancel alarm
- `tryClaim(taskId)`: Atomic check-and-transition, returns boolean
- `alarm()`: Verify still warm, initiate node destruction

**Infrastructure Requirements** (Principle XII):
- Add `NodeLifecycle` binding to `wrangler.toml`
- Add DO namespace to Pulumi stack
- Update self-hosting docs

---

## Decision 7: Chat Session Creation Flow

**Decision**: Chat sessions created during workspace provisioning, with session ID passed to VM agent via cloud-init environment variables.

**For task-triggered workspaces**:
1. `executeTaskRun()` creates a chat session in ProjectData DO: `createSession(workspaceId, taskTitle, taskId)`
2. Session ID passed via cloud-init: `CHAT_SESSION_ID` env var
3. VM agent reads session ID on startup and uses it for all message persistence

**For manually-created workspaces**:
1. `POST /workspaces` creates a chat session if `projectId` is set: `createSession(workspaceId, null, null)`
2. Session ID passed via cloud-init same as above
3. If no `projectId`, no session created (standalone workspace, no persistence)

**Rationale**: The session ID must exist before the VM boots so the agent knows where to persist messages from the very first prompt.

---

## Decision 8: API Endpoint Design

**Decision**: `POST /api/workspaces/:workspaceId/messages` for batch message persistence.

**Authentication**: Existing callback JWT (workspace-callback audience, 24hr expiry). The VM agent already uses this for ready signals, heartbeats, git tokens, boot logs, and error reports.

**Request Body**:
```json
{
  "messages": [
    {
      "messageId": "uuid-v4",
      "sessionId": "chat-session-id",
      "role": "assistant",
      "content": "...",
      "toolMetadata": { "tool": "Edit", "target": "src/main.ts", "status": "success" },
      "timestamp": "2026-02-24T12:00:00.000Z"
    }
  ]
}
```

**Response**: `200 OK` with `{ "persisted": 5, "duplicates": 0 }` (idempotent via messageId).

**Why workspace-scoped, not project-scoped**: The callback JWT contains the workspace ID claim, not the project ID. Keeping the endpoint workspace-scoped matches the existing auth model. The API handler resolves the project via the workspace record.

---

## Decision 9: Cloud-Init Extension

**Decision**: Add `PROJECT_ID` and `CHAT_SESSION_ID` to `CloudInitVariables` and the generated cloud-config.

**Current variables**: `nodeId`, `hostname`, `controlPlaneUrl`, `jwksUrl`, `callbackToken`, `logJournal*`

**New variables**: `projectId` (nullable), `chatSessionId` (nullable)

**Passed to VM agent as environment variables in the systemd service**:
```
Environment=PROJECT_ID={{project_id}}
Environment=CHAT_SESSION_ID={{chat_session_id}}
```

**Rationale**: These are known at workspace creation time and are immutable for the workspace's lifetime. Environment variables in the systemd service are the simplest delivery mechanism, consistent with existing patterns.

---

## Decision 10: Browser-Side Persistence Deprecation

**Decision**: Remove browser-side message persistence code; browser becomes read-only for chat history.

**Current flow**: Browser connects to VM agent via ACP WebSocket → receives session/update messages → browser POSTs to control plane via `chat-persistence.ts`

**New flow**: VM agent hooks `sessionHostClient.SessionUpdate()` → writes to SQLite outbox → flushes to control plane API → ProjectData DO persists. Browser reads via DO REST API or DO WebSocket.

**Migration approach**: Phase 1 adds the VM agent persistence path first. Browser persistence is removed only after VM agent persistence is verified working. During transition, both paths may coexist briefly (idempotency via message_id prevents duplicates).

---

## Sources

### Codebase Analysis
- `packages/vm-agent/internal/acp/session_host.go` — SessionHost, sessionHostClient callbacks
- `packages/vm-agent/internal/errorreport/reporter.go` — Batch+flush HTTP reporter pattern
- `packages/vm-agent/internal/bootlog/reporter.go` — Dual-path reporter pattern
- `packages/vm-agent/internal/persistence/store.go` — Existing SQLite persistence
- `apps/api/src/services/task-runner.ts` — Task execution orchestration
- `apps/api/src/services/nodes.ts` — Node provisioning and cleanup
- `apps/api/src/services/node-selector.ts` — Node selection logic
- `apps/api/src/durable-objects/project-data.ts` — ProjectData DO with chat persistence
- `apps/api/src/services/chat-persistence.ts` — Current browser-side persistence
- `packages/cloud-init/src/generate.ts` — Cloud-init template generation
- `apps/api/src/services/jwt.ts` — JWT signing/verification

### External References
- [cenkalti/backoff v5 - GitHub](https://github.com/cenkalti/backoff) (MIT, ~3,900 stars)
- [OpenTelemetry Collector Resiliency](https://opentelemetry.io/docs/collector/resiliency/)
- [Fluent Bit Scheduling and Retries](https://docs.fluentbit.io/manual/administration/scheduling-and-retries)
- [Grafana Promtail client.go](https://github.com/grafana/loki/blob/main/clients/pkg/promtail/client/client.go)
- [Cloudflare Durable Objects Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Cloudflare Durable Object Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [AWS Lambda Execution Environments](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)
- [Kubernetes Scheduler Internals](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)
- [VictoriaMetrics Graceful Shutdown Patterns](https://victoriametrics.com/blog/go-graceful-shutdown/)
