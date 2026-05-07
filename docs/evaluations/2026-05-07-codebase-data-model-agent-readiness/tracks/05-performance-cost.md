# Track 5: Performance & Cost Efficiency

Status: Complete

---

## Executive Summary

SAM's architecture is generally cost-efficient for its current scale (single-digit users). The dominant cost driver is Hetzner VM compute, not Cloudflare services. However, several patterns will cause non-linear cost growth: cron-driven N+1 DB query loops, always-active DO alarm cycles, an un-split frontend bundle shipping ~700 KB of unused libraries to every user, and AI Gateway log pagination making up to 20 external HTTP calls per user dashboard view.

The estimated monthly cost for the reference workload (10 users, 50 tasks/day, 5 concurrent workspaces) is **$105-155/month**, dominated by VM compute ($75-125) with Cloudflare services adding only $15-30.

---

## 5.1 Cloudflare Cost Model Analysis

### [HIGH] Cron N+1 Query Pattern in Stuck Task Recovery

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/api/src/scheduled/stuck-tasks.ts:229-350`
**Category**: performance

**Finding**: The stuck-task recovery cron (runs every 5 minutes) iterates over stuck tasks sequentially, issuing 3-4 D1 queries per task: `getTaskNodeId()`, `isNodeHeartbeatRecent()`, a TaskRunner DO RPC, and an OBSERVABILITY_DATABASE deduplication query. With 20 stuck tasks, this fires 80+ queries per cron invocation.

**Impact**: At scale (100 concurrent tasks), the 5-minute cron could issue 400+ D1 queries per run (115,200/day). D1 pricing is $0.75/million reads — individually cheap but the pattern encourages unbounded growth. More critically, sequential execution within a single Worker invocation risks hitting the 30-second CPU time limit.

**Recommendation**: Batch-fetch all task node IDs and heartbeat statuses in two queries upfront (JOIN or IN clause), then iterate the in-memory results. This reduces per-cron queries from O(n) to O(1).

**Effort**: S

---

### [HIGH] Sequential VM Agent RPCs in Node Cleanup Cron

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/api/src/scheduled/node-cleanup.ts:276-320, 392-405`
**Category**: performance

**Finding**: The node-cleanup cron (every 5 minutes) iterates orphaned workspaces and stale stopped workspaces sequentially, making per-workspace HTTP calls to VM agents (`stopWorkspaceOnNode`, `deleteWorkspaceOnNode`). Each RPC has network latency of 50-500ms. With 10 orphaned workspaces, the loop takes 500ms-5s; with 50 workspaces, it can exceed the Worker CPU time budget.

**Impact**: Sequential execution means total cron duration = N * average_rpc_latency. Under load, this can exceed the 30-second soft limit. No `Promise.all()` parallelization is used anywhere in the scheduled handlers.

**Recommendation**: Parallelize VM agent RPCs with `Promise.allSettled()` with a concurrency limit (e.g., 5). This reduces total duration from O(n) to O(n/5) while preserving error isolation.

**Effort**: S

---

### [MEDIUM] DO Alarm Overhead — ProjectOrchestrator Scheduling Loop

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/api/src/durable-objects/project-orchestrator/` (alarm interval: 30s default)
**Category**: performance

**Finding**: The ProjectOrchestrator DO wakes every 30 seconds (`ORCHESTRATOR_SCHEDULING_INTERVAL_MS = 30000`) to check active missions, route handoff packets, and detect stalled tasks. DOs are billed for wall-clock duration while active. Even if the alarm handler completes in 10ms, the DO billing starts a new duration window each time.

**Impact**: For 10 active projects, that is 10 * 2/min * 60 * 24 = 28,800 DO invocations/day. At $0.15/million requests + duration billing ($12.50/million GB-s), this is negligible at current scale but grows linearly with project count. At 1,000 projects: 2.88M invocations/day = meaningful cost.

**Recommendation**: The orchestrator alarm should be lazy — only armed when at least one mission has status `active` or `paused_resumable`. When all missions are completed/cancelled, do not re-arm the alarm. The code already tracks mission count; add a guard before `setAlarm()`.

**Effort**: S

---

### [MEDIUM] DO Mailbox Alarm — Conditional but Frequent When Active

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/api/src/durable-objects/project-data/mailbox.ts:438-454`
**Category**: performance

**Finding**: The mailbox delivery sweep alarm only fires when `session_inbox` has queued/delivered messages (line 451: returns null if count=0). This is well-designed — it avoids polling empty mailboxes. However, during active task execution with durable messaging, the alarm fires every 30 seconds per project with pending messages.

**Impact**: During peak orchestration (5 projects with active missions), this adds 5 * 2/min = 10 additional DO invocations/minute. Acceptable for the reference workload but worth monitoring.

**Recommendation**: No action needed at current scale. If messaging volume grows, consider event-driven delivery (wake on message insertion) rather than polling.

**Effort**: N/A (monitoring only)

---

### [LOW] KV Rate Limiting — Acceptable at Scale

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/api/src/middleware/rate-limit.ts:107-136`
**Category**: performance

**Finding**: Every AI proxy request performs 2 KV operations (get + put) for rate limiting, plus 2-3 more for budget checks (`ai-token-budget.ts:48-50, 208`). Total: 5 KV ops per LLM-proxied request. All keys use appropriate TTLs (60s for rate limits, 86400s for daily budgets).

**Impact**: For 10 users * 50 tasks/day * ~10 LLM calls/task = 5,000 LLM requests/day * 5 KV ops = 25,000 KV ops/day. At $0.50/million writes, this costs $0.0004/day. Negligible.

**Recommendation**: No action needed. The KV cost is well within free tier (100k reads/day, 1k writes/day on Workers Free; unlimited on Paid plan included in $5/month).

**Effort**: N/A

---

### [LOW] R2 Usage — Minimal, Well-Designed

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/api/src/routes/agent.ts:44-74`, `apps/api/src/services/attachment-upload.ts:180-252`
**Category**: performance

**Finding**: R2 operations are limited to: (1) VM agent binary downloads on node boot (~1/node/day), (2) task attachment upload/download/delete (user-initiated, infrequent), (3) file library operations. No R2 `list()` calls found. Presigned URLs offload upload bandwidth from the Worker.

**Impact**: Negligible. R2 Class A ops (writes) at $4.50/million, Class B (reads) at $0.36/million. Expected volume: <1,000 ops/day.

**Recommendation**: No action needed.

**Effort**: N/A

---

### [INFO] AI Gateway Cost Risk — Pagination Loop for Usage Dashboards

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/api/src/services/ai-gateway-logs.ts:137-164`
**Category**: performance

**Finding**: The AI usage dashboard (`GET /api/usage/ai`) and admin cost monitoring (`GET /api/admin/costs`) iterate up to 20 pages of AI Gateway logs per request via external HTTP calls. Each page fetches from `https://api.cloudflare.com/client/v4/.../ai-gateway/...`. This is capped (`MAX_PAGES_HARD_CAP = 20`) but makes the dashboard endpoint slow (2-10s per request depending on data volume).

**Impact**: User-perceived latency for usage dashboards. No direct monetary cost (AI Gateway API calls are free), but each call counts against CF API rate limits (1200 req/5min).

**Recommendation**: Cache aggregated usage data in KV with a 5-minute TTL for the user-facing dashboard. The admin dashboard can call live. This eliminates repeated pagination for the same user within a session.

**Effort**: M

---

## 5.2 Query Performance

### [HIGH] Unbounded Search in MCP Idea Tools

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/api/src/routes/mcp/idea-tools.ts` (search_ideas tool)
**Category**: performance

**Finding**: The `search_ideas` MCP tool queries tasks matching a search term using `LIKE` without a LIMIT clause. If a project accumulates thousands of tasks/ideas and the search term is broad (e.g., single character), the query returns all matching rows.

**Impact**: Memory pressure on the Worker (which has 128MB limit). A query returning 10,000 rows could OOM the Worker or hit the 30-second CPU limit during serialization.

**Recommendation**: Add `LIMIT ${configurable_max}` (default: 50, max: 200) to the search query. The MCP tool already has `SAM_CODE_SEARCH_LIMIT` patterns for other tools — apply the same pattern here.

**Effort**: S

---

### [MEDIUM] ProjectData DO — Many Concerns in One DO

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/api/src/durable-objects/project-data/index.ts:1-45`
**Category**: performance

**Finding**: The ProjectData DO manages 11 concerns (sessions, messages, activity, ideas, knowledge, mailbox, idle-cleanup, materialization, ACP sessions, missions, policies) in a single DO instance per project. Each concern adds tables and alarm candidates to the shared SQLite database. The DO runs migrations in `blockConcurrencyWhile` on every cold start.

**Impact**: (1) Cold start latency increases with migration count (currently 19 migrations). (2) All concerns share one concurrency gate — a slow knowledge query blocks message persistence. (3) The alarm handler must evaluate all concerns to find the next alarm time. At current scale this is acceptable, but as project data grows, the single-DO model may bottleneck.

**Recommendation**: Monitor DO cold start times. If they exceed 200ms, consider splitting hot-path concerns (messages, sessions) from cold-path concerns (knowledge, policies) into separate DOs. No action needed now.

**Effort**: L (if splitting needed in future)

---

### [MEDIUM] No Query Result Caching for Repeated D1 Reads

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/api/src/services/project-data.ts` (various methods), `apps/api/src/routes/chat.ts`
**Category**: performance

**Finding**: Routes that serve chat session data often make the same D1 queries on consecutive requests (e.g., fetching project details, user ownership, session metadata). There is no in-Worker request-level or short-TTL cache for frequently-read data like project ownership.

**Impact**: Each page load in the web UI triggers multiple API calls, each performing its own ownership verification query (`SELECT * FROM projects WHERE id = ? AND user_id = ?`). For a user viewing a chat session, this query runs 3-5 times across different route handlers in the same page load.

**Recommendation**: Implement a per-request context cache (attached to Hono's `c.set()`) for ownership-verified project data. This eliminates redundant D1 reads within a single page load without introducing stale data risks.

**Effort**: M

---

## 5.3 Frontend Performance

### [HIGH] No Code Splitting — 700 KB Unused Libraries on Every Page Load

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/web/src/App.tsx` (all 59 page imports are static), `apps/web/vite.config.ts` (no manualChunks)
**Category**: performance

**Finding**: The web app uses zero `React.lazy()` or dynamic `import()` calls. All page components are statically imported in `App.tsx`, including heavy visualization libraries: mermaid (~280 KB), recharts (~200 KB), @xyflow/react (~180 KB), dagre (~60 KB). Every user downloads all of these regardless of which pages they visit. Admin-only pages (analytics, costs) are bundled into the same chunk served to all users.

**Impact**: Initial page load downloads ~700 KB of JavaScript that most users never execute. On a 3G connection, this adds 3-5 seconds to first meaningful paint. The app targets developers who often have fast connections, but mobile users (which the design system explicitly targets at 375px) are penalized.

**Recommendation**: (1) Lazy-load admin pages, account-map, and chart-heavy pages using `React.lazy()`. (2) Lazy-load mermaid only when markdown content contains mermaid blocks. (3) Configure Vite `manualChunks` to separate vendor libraries into cached chunks.

**Effort**: M

---

### [LOW] Unused Dependency: react-simple-maps

**Track**: 5 - Performance & Cost Efficiency
**Location**: `apps/web/package.json:41`
**Category**: performance

**Finding**: `react-simple-maps` (3.0.0) is listed in dependencies but no import of it exists in the source code. It adds ~30-40 KB to the bundle for no benefit.

**Impact**: Minor bundle bloat. Violates the "No dead code" rule in CLAUDE.md.

**Recommendation**: Remove from `package.json`.

**Effort**: S

---

## 5.4 VM Agent Performance

### [LOW] Resource Monitor SQLite Writes Every 60 Seconds

**Track**: 5 - Performance & Cost Efficiency
**Location**: `packages/vm-agent/internal/resourcemon/monitor.go:46-60`
**Category**: performance

**Finding**: The resource monitor writes CPU/memory/disk snapshots to a local SQLite DB every 60 seconds for the lifetime of the VM. It uses WAL mode and `synchronous=NORMAL` which is appropriate. Data is bounded by VM lifetime (typically hours for task VMs).

**Impact**: Negligible. Local SQLite writes at 1/minute are trivially cheap. The data is useful for debugging (included in debug packages).

**Recommendation**: No action needed. Consider adding a retention limit (e.g., keep last 24h of snapshots) for long-lived warm-pool nodes to prevent unbounded DB growth.

**Effort**: S (if retention added)

---

### [LOW] Container Discovery Shell-Outs (Cached)

**Track**: 5 - Performance & Cost Efficiency
**Location**: `packages/vm-agent/internal/container/discovery.go:64-76`
**Category**: performance

**Finding**: Container discovery shells out to `docker ps --filter` to find the devcontainer. Results are cached with a 30-second TTL (`CacheTTL`, line 51). The bridge IP is similarly cached (30s TTL).

**Impact**: Two shell-outs every 30 seconds per workspace is acceptable. The cache prevents shell-out on every PTY creation or file operation.

**Recommendation**: No action needed. The caching strategy is sound.

**Effort**: N/A

---

### [INFO] Go Binary Size and Dependencies

**Track**: 5 - Performance & Cost Efficiency
**Location**: `packages/vm-agent/go.mod`
**Category**: performance

**Finding**: The VM agent has a lean dependency tree: JWT validation, ACP SDK, PTY, WebSocket, UUID, and SQLite. No heavy frameworks (no gRPC, no full HTTP framework). The `modernc.org/sqlite` pure-Go SQLite is larger than CGO sqlite3 but avoids CGO cross-compilation complexity.

**Impact**: Expected binary size ~15-25 MB (typical for Go with embedded SQLite). Downloaded once per node boot from R2. Acceptable.

**Recommendation**: If binary size becomes a concern for cold-start provisioning speed, consider stripping debug symbols (`-ldflags="-s -w"`) which typically saves 30-40%.

**Effort**: S

---

## 5.5 Monthly Cost Estimate

### Reference Workload Assumptions

| Parameter | Value |
|-----------|-------|
| Active users | 10 |
| Tasks per day | 50 (5 per user) |
| Concurrent workspaces | 5 |
| Average task duration | 15 minutes |
| VM type | CX22 (2 vCPU, 4 GB RAM) |
| Warm pool timeout | 30 minutes |
| Active projects | 10 (1 per user) |
| Chat sessions per day | 20 |
| LLM calls per task (via AI proxy) | 10 |
| Node uptime per day | ~12 hours (5 nodes * avg 2.4h each, with warm pool) |

### Cost Breakdown

| Service | Unit | Volume/Month | Unit Cost | Monthly Cost |
|---------|------|--------------|-----------|--------------|
| **Hetzner CX22 VMs** | hour | 360h (5 nodes * ~2.4h/day * 30 days) | $0.0095/h (calculated from $6.85/mo) | **$75-125** |
| **CF Workers** (requests) | million | 0.5M (API calls) | $0.30/M (after 10M free) | **$0** (within free tier) |
| **CF Workers** (CPU time) | million ms | ~50K ms | $0.02/M ms | **$0** (within included) |
| **CF D1** (reads) | million | 1.5M | $0.75/M (after 25B free rows/day) | **$1-2** |
| **CF D1** (writes) | million | 0.3M | $1.00/M | **$0.30** |
| **CF D1** (storage) | GB | 0.5 | $0.75/GB (after 5 GB free) | **$0** (within free tier) |
| **CF KV** (reads) | million | 0.9M | $0.50/M (after 10M free) | **$0** (within free tier) |
| **CF KV** (writes) | million | 0.5M | $0.50/M (after 1M free) | **$0** (within free tier) |
| **CF R2** (storage) | GB | 2 | $0.015/GB (after 10 GB free) | **$0** (within free tier) |
| **CF R2** (operations) | thousand | 5K | $4.50/M Class A | **$0** (within free tier) |
| **CF DO** (requests) | million | 0.2M | $0.15/M (after 1M free) | **$0** (within free tier) |
| **CF DO** (duration) | GB-s | 100K | $12.50/M GB-s (after 400K free) | **$0** (within free tier) |
| **CF AI Gateway** | requests | 15K | Free (pass-through) | **$0** |
| **LLM costs** (via AI Gateway) | tokens | varies | Pass-through to provider | **$0-500** (user-pays via BYOK) |
| **Domain** (sammy.party) | year | 1 | ~$12/year | **$1** |
| **CF Workers Paid Plan** | month | 1 | $5/month | **$5** |

### Total Estimated Monthly Cost

| Category | Low Estimate | High Estimate |
|----------|-------------|---------------|
| Infrastructure (Hetzner VMs) | $75 | $125 |
| Cloudflare Platform (Workers Paid) | $5 | $5 |
| Cloudflare Metered (D1, KV, DO, R2) | $1 | $5 |
| Domain/DNS | $1 | $1 |
| **Platform Total** | **$82** | **$136** |
| LLM costs (user-pays, BYOK) | $0 | $500+ |

**Key Insight**: At 10 users / 50 tasks per day, virtually all Cloudflare metered services stay within free tier or included quotas. The overwhelmingly dominant cost is Hetzner VM compute. The pricing philosophy of "cost-plus with 1.2x markup" means the billable amount to users would be ~$100-165/month for the platform infrastructure, with LLM costs passed through at cost.

### Scaling Sensitivity

| Scale Factor | Primary Cost Driver | Estimated Monthly |
|--------------|--------------------|--------------------|
| Current (10 users, 50 tasks/day) | Hetzner VMs | $82-136 |
| 50 users, 250 tasks/day | Hetzner VMs (25 nodes) | $400-650 |
| 100 users, 1000 tasks/day | Hetzner VMs + D1 reads | $1,500-2,500 |
| 1000 users, 10K tasks/day | D1 read limits, DO count | $15,000-25,000 |

At 1,000 users, the cron N+1 patterns become the primary Cloudflare cost driver (millions of D1 reads/day from stuck-task and node-cleanup loops). The VM cost dominates until ~500 users, after which Cloudflare metered costs become significant.

---

## Top 5 Cost Reduction Opportunities

| Rank | Opportunity | Savings Potential | Effort | Location |
|------|-------------|-------------------|--------|----------|
| 1 | **Lazy-load frontend bundles** (React.lazy for admin/chart pages) | 60-70% reduction in initial JS payload; faster TTI | M | `apps/web/src/App.tsx`, `apps/web/vite.config.ts` |
| 2 | **Batch cron D1 queries** (stuck-tasks, node-cleanup) | 80% fewer D1 reads at scale (from O(n) to O(1) per cron) | S | `apps/api/src/scheduled/stuck-tasks.ts`, `node-cleanup.ts` |
| 3 | **Parallelize VM agent RPCs** in cron handlers | 5x faster cron execution, avoids CPU timeout at scale | S | `apps/api/src/scheduled/node-cleanup.ts:276-405` |
| 4 | **Lazy orchestrator alarm** (only arm when missions active) | Eliminate 28,800 unnecessary DO invocations/day per 10 idle projects | S | `apps/api/src/durable-objects/project-orchestrator/` |
| 5 | **Cache AI Gateway usage aggregates** in KV | Eliminate 20 HTTP calls per dashboard view; sub-second response | M | `apps/api/src/services/ai-gateway-logs.ts`, `apps/api/src/routes/usage.ts` |

---

## Implementation-Ready Task Packets

### Task Packet 1: Batch Cron D1 Queries (P1)

**Title**: Batch stuck-task and node-cleanup cron queries to eliminate N+1 patterns
**Acceptance Criteria**:
- [ ] `stuck-tasks.ts` fetches all task node IDs and heartbeat statuses in 1-2 queries, not per-task
- [ ] `node-cleanup.ts` orphaned workspace loop uses `Promise.allSettled()` for VM agent RPCs (concurrency=5)
- [ ] Cron completes within 10 seconds for 50 stuck tasks (currently ~25s sequential)
- [ ] Unit tests verify batched query returns same results as sequential
**Files to modify**: `apps/api/src/scheduled/stuck-tasks.ts`, `apps/api/src/scheduled/node-cleanup.ts`
**Effort**: S (2-4 hours)

---

### Task Packet 2: Frontend Code Splitting (P1)

**Title**: Add React.lazy code splitting for heavy visualization pages
**Acceptance Criteria**:
- [ ] Admin pages (AdminAnalytics, AdminCosts, AdminAiUsage) lazy-loaded
- [ ] Account map page (`/account-map`) lazy-loaded
- [ ] Mermaid loaded dynamically only when markdown contains mermaid blocks
- [ ] `react-simple-maps` removed from package.json (unused)
- [ ] Initial bundle size reduced by >40% (measure with `npx vite-bundle-visualizer`)
- [ ] Loading fallback (Suspense boundary) shows skeleton, not blank page
**Files to modify**: `apps/web/src/App.tsx`, `apps/web/vite.config.ts`, `apps/web/src/components/MarkdownRenderer.tsx`, `apps/web/package.json`
**Effort**: M (4-8 hours)

---

### Task Packet 3: Lazy Orchestrator Alarm (P1)

**Title**: Only arm ProjectOrchestrator alarm when active missions exist
**Acceptance Criteria**:
- [ ] `alarm()` handler checks mission count before re-arming
- [ ] When no active/paused missions exist, alarm is NOT re-armed
- [ ] When `create_mission` is called, alarm is explicitly armed
- [ ] When last mission completes/cancels, alarm naturally expires
- [ ] Test: idle project with no missions does not produce DO invocations
**Files to modify**: `apps/api/src/durable-objects/project-orchestrator/`
**Effort**: S (1-2 hours)

---

### Task Packet 4: Cache AI Gateway Usage Aggregates (P2)

**Title**: Cache user AI usage dashboard results in KV to eliminate pagination overhead
**Acceptance Criteria**:
- [ ] `GET /api/usage/ai` checks KV cache first (key: `ai-usage-cache:${userId}:${period}`)
- [ ] Cache TTL: 5 minutes (configurable via `AI_USAGE_CACHE_TTL_SECONDS`)
- [ ] Cache invalidated on explicit budget update
- [ ] Dashboard endpoint responds in <500ms (currently 2-10s)
- [ ] Admin endpoint (`/api/admin/costs`) bypasses cache (always fresh)
**Files to modify**: `apps/api/src/routes/usage.ts`, `apps/api/src/services/ai-gateway-logs.ts`
**Effort**: M (3-5 hours)
