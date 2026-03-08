# Orchestrator Maturity Assessment

> **Date**: 2026-03-08
> **Status**: Research document
> **Purpose**: Assess how close SAM is to being a true agent orchestrator, identify gaps, and map parallels to production orchestration systems (Kubernetes, Nomad, Temporal, Argo Workflows).

---

## Executive Summary

SAM has evolved from a workspace manager to a single-agent task executor with an MCP server for agent check-in. The foundation is solid: alarm-driven TaskRunner DO, warm node pooling, task dependency graph, and MCP-based agent communication. However, **significant gaps remain** before the system can reliably support multi-agent orchestration where agents delegate sub-tasks, receive child results, and coordinate autonomously.

**Current maturity: Level 2 of 5** (single-agent task execution with reliable callbacks).

The biggest gaps are:
1. **No agent-spawns-agent capability** — agents can't create or delegate sub-tasks via MCP
2. **No child-to-parent result propagation** — parent agents can't receive structured results from children
3. **No orchestration run concept** — no first-class grouping of related tasks
4. **No failure recovery at task level** — failed tasks require manual retry
5. **No inter-agent messaging** — agents in the same project are fully isolated

---

## What Exists Today

### MCP Server (`apps/api/src/routes/mcp.ts`)

A JSON-RPC 2.0 HTTP endpoint on the Cloudflare Worker exposing three tools:

| Tool | Purpose | Auth |
|------|---------|------|
| `get_instructions` | Bootstrap agent with task context, project info, behavioral guidance | MCP token (KV) |
| `update_task_status` | Record incremental progress as activity events | MCP token (KV) |
| `complete_task` | Mark task done, store summary, revoke token | MCP token (KV) |

**Token lifecycle**: Generated per-task in `TaskRunner.handleAgentSession()`, stored in KV with 2h TTL (`mcp:{uuid}`), validated (not consumed) on each call, revoked on `complete_task`.

**Injection path**: Token + MCP server URL passed to VM agent at `POST /workspaces/:id/agent-sessions/:sessionId/start`, injected into Claude Code's ACP session as an `mcpServers` config.

### TaskRunner Durable Object (`apps/api/src/durable-objects/task-runner.ts`)

Alarm-driven state machine (one DO per task) that orchestrates the full provisioning-to-execution pipeline:

```
node_selection → node_provisioning → node_agent_ready → workspace_creation → workspace_ready → agent_session → running
```

**Key properties**:
- **Idempotent step handlers** — safe to retry after crashes
- **Exponential backoff** — transient failures retried with jitter (base 5s, max 60s)
- **Callback-driven advancement** — `workspace_ready` step uses callback from VM agent, not polling
- **D1 breadcrumbs** — `executionStep` persisted for frontend visibility and crash recovery

### Task Dependency Graph (`apps/api/src/services/task-graph.ts`)

- Tasks can declare `dependsOnTaskId` relationships
- DAG cycle detection prevents invalid edges
- Blocked tasks can't transition to executable statuses
- Parent-child via `parentTaskId` column (exists in schema, not yet fully leveraged)

### Warm Node Pooling (`apps/api/src/durable-objects/node-lifecycle.ts`)

- Nodes transition: active → warm (30 min timeout) → destroying
- `tryClaim()` atomically claims warm nodes for new tasks
- Three-layer defense against orphans: DO alarm + cron sweep + max lifetime cap (24h)
- Node selector prefers warm nodes → existing with capacity → new provisioning

### Agent Session Management (`packages/vm-agent/`)

- ACP protocol over JSON-RPC 2.0 / NDJSON (agent ↔ VM agent via stdio)
- `orderedPipe` serializes streaming notifications to prevent token reordering
- Message outbox pattern: SQLite on VM → batch flush to API → ProjectData DO
- Callback retry with exponential backoff (1s→30s, 5 attempts, 2m max)

---

## What's Missing: Gap Analysis

### Gap 1: Agent-Spawns-Agent (CRITICAL)

**The problem**: An agent executing a complex task cannot decompose it and delegate sub-tasks to other agents. All task decomposition happens at the control plane level (human-defined).

**What exists**: The orchestration vision doc (`docs/design/orchestration-platform-vision.md`) specifies MCP tools for delegation (`sam_create_subtask`, `sam_delegate_task`, `sam_get_task`, `sam_list_tasks`). None are implemented.

**What's needed**:
- New MCP tools: `sam_create_subtask(parent_task_id, description, context)`, `sam_delegate_task(task_id, agent_profile?)`, `sam_get_task(task_id)`, `sam_list_tasks(filters)`
- MCP token scoping: child tasks get tokens linked to the parent's orchestration run
- TaskRunner integration: creating a sub-task triggers a new TaskRunner DO for the child
- Guardrails: max depth (default 3), max workers per run (default 5), rate limiting on delegation calls

**Parallel in production orchestrators**:
- **Kubernetes**: Native Jobs don't support spawning child Jobs. Argo Workflows adds DAG support with first-class step dependencies and artifact passing. K8s v1.35 `managedBy` (GA) enables external controllers to own Job reconciliation.
- **Nomad**: Parameterized batch jobs + `job dispatch` create child instances with unique IDs that callers track "like a future or promise." Metadata propagation via `NOMAD_META_*` env vars. 16 KiB payload limit per dispatch.
- **Temporal**: Activities within Workflows are the delegation primitive. Child Workflows enable multi-level delegation with full context passing via typed parameters. Automatic retry with exponential backoff at the Activity level.

### Gap 2: Child-to-Parent Result Propagation (CRITICAL)

**The problem**: When a child task completes, the parent agent has no way to receive the result. The `complete_task` tool stores an `outputSummary` (2000 chars max) and `outputBranch` in D1, but there's no MCP tool for a parent to query it.

**What exists**: Task model has `outputSummary`, `outputBranch`, `outputPrUrl` columns. No query endpoint exposed via MCP.

**What's needed**:
- MCP tool: `sam_get_task(task_id)` returning full task including status, outputs, error details
- Structured output: Add `outputData` JSON column for rich results (file lists, metrics, decisions) beyond the 2000-char summary
- Polling pattern: Parent agent polls child status with exponential backoff via MCP
- Context size limit: validate output payload (e.g., 50 KB max) to prevent abuse

**Parallel in production orchestrators**:
- **Kubernetes/Argo**: Steps pass data via parameters (small values) or artifacts (files in S3/GCS). Argo supports `{{steps.step-name.outputs.result}}` template substitution.
- **Nomad**: Child job status tracked by dispatched Job ID. Parent queries allocation status via Nomad API. No built-in result passing — uses shared storage (Consul KV, artifact stager).
- **Temporal**: Activities return typed values directly to the calling Workflow. Context flows through a shared dictionary maintained across execution. Workflow Queries allow external systems to inspect intermediate state.

### Gap 3: Orchestration Runs (MAJOR)

**The problem**: No first-class concept grouping related tasks into a coordinated execution. Tasks are independent entities with optional dependencies but no "run" identity.

**What exists**: Vision doc specifies `orchestration_runs` and `run_tasks` tables. The task model has `orchestration_run_id` in the vision but not yet in the schema.

**What's needed**:
- Schema: `orchestration_runs` table (id, project_id, mode, status, config, lead_workspace_id)
- Schema: `run_tasks` linking table
- Task column: `orchestration_run_id` (nullable FK)
- Two modes: `direct` (user delegates, no orchestrator) and `orchestrated` (lead workspace coordinates workers)
- Run-level operations: cancel run → cascade cancel all children; query all tasks in run
- Run dashboard: tree view of tasks with real-time status

**Parallel in production orchestrators**:
- **Kubernetes/Argo**: Argo Workflow is the run concept. Contains a DAG of templates (steps). Status tracked at workflow level with per-step status.
- **Nomad**: Job is the run concept. Contains task groups with tasks. Evaluation + Allocation tracking provides per-run visibility.
- **Temporal**: Workflow Execution is the run concept. Maintains exclusive local state. Supports child workflows for multi-level runs. Full event history replay for debugging.

### Gap 4: Failure Recovery (MAJOR)

**The problem**: Failed tasks require manual intervention. No automatic retry at the task level, no circuit breakers, no configurable failure policies.

**What exists**: TaskRunner has step-level retry with exponential backoff. Stuck-task cron catches abandoned tasks. But once a task reaches `failed` status, recovery is manual.

**What's needed**:
- Task schema: `maxRetries`, `retryCount`, `nextRetryAt`
- Configurable failure policies per run: `fail-fast` (abort on first failure), `continue-on-failure` (complete independent tasks)
- Circuit breaker: track failure patterns per user/node, auto-disable after threshold
- Partial result preservation: failed task's branch preserved for manual recovery
- Parent visibility: parent agent can see child failure reason and decide remediation

**Parallel in production orchestrators**:
- **Kubernetes**: Jobs have `backoffLimit` (retry count) and `activeDeadlineSeconds` (hard timeout). Node failure → pod rescheduled. Success policies (GA v1.33) allow marking jobs succeeded even with partial failures.
- **Nomad**: `restart` block with `attempts`, `interval`, `delay`, `mode` (fail/delay). Allocation rescheduling on node failure. `max_client_disconnect` for network partition handling.
- **Temporal**: Activity-level automatic retry with exponential backoff (infinite by default). Workflow-level timeouts. Saga pattern for compensating transactions on failure.

### Gap 5: Inter-Agent Messaging (MEDIUM)

**The problem**: Agents executing tasks within the same run can't communicate. Each agent operates in complete isolation.

**What exists**: Agents share git (implicit coordination via branches). No explicit message passing.

**What's needed**:
- Schema: `agent_messages` table (run_id, from_workspace_id, to_workspace_id, message, priority, read_at)
- MCP tools: `sam_send_message(target_workspace_id, message)`, `sam_read_messages(since?, limit?)`
- Broadcast: `sam_broadcast(run_id, message)` for orchestrator-to-all-workers
- Polling initially (1-5s latency acceptable); SSE upgrade path if needed
- Message TTL: auto-expire after 7 days to prevent DB bloat

**Parallel in production orchestrators**:
- **Kubernetes**: Sidecar pattern, Service DNS, shared volumes. No built-in inter-pod messaging.
- **Nomad**: Consul KV for shared state. Service mesh for direct communication.
- **Temporal**: Signals for async message delivery to running Workflows. Queries for read-only state inspection. Both are first-class primitives.

### Gap 6: Agent Profiles & Custom Delegation (MEDIUM)

**The problem**: All agents use the same configuration (agent type, model, permissions). No way to specialize agents for different roles.

**What exists**: Vision doc specifies `agent_profiles` table and `.sam/config.json` with role definitions (planner, implementer, reviewer). Not implemented.

**What's needed**:
- Schema: `agent_profiles` table (project-scoped or org-global)
- Profile selection: `sam_create_subtask` and `sam_delegate_task` accept `agent_profile` parameter
- Session bootstrap: model, permission mode, system prompt append injected into ACP session based on profile
- Built-in defaults: planner (Opus, plan mode), implementer (Sonnet, acceptEdits), reviewer (Opus, read-only)

### Gap 7: Health Monitoring During Execution (LOW)

**The problem**: After the agent starts (`running` step), the TaskRunner sets no further alarms. If the agent crashes, the task hangs indefinitely.

**What exists**: `complete_task` MCP call is the only completion signal. No heartbeat during execution.

**What's needed**:
- Agent heartbeat: periodic `update_task_status` calls serve as implicit heartbeat
- TaskRunner watchdog: alarm during `running` phase (e.g., every 5 min) checks last heartbeat timestamp
- Timeout enforcement: `TASK_MAX_EXECUTION_TIME_MS` (default 60 min), configurable per agent profile
- On timeout: mark task failed, optionally retry based on policy

---

## Lessons from Production Orchestrators

### Kubernetes: Declarative Desired State

**Core insight**: Kubernetes doesn't execute workflows — it continuously reconciles *desired state* with *actual state*. Controllers watch for deviations and take corrective action.

**SAM parallel**: The TaskRunner DO is already somewhat reconciliation-based (idempotent steps that check current state before acting). But it's imperative (step 1 → step 2 → step 3) rather than declarative. A more Kubernetes-like approach would define the *desired end state* of a task and let the controller figure out how to get there.

**Applicable patterns**:
- **Resource versioning**: Add a `revision` field to tasks for optimistic concurrency. Prevents stale updates from out-of-order callbacks.
- **Labels and selectors**: Tasks could have labels (`type: implementation`, `priority: high`) that drive scheduling decisions, rather than explicit step handlers for each scenario.
- **Admission control**: Validate task creation against quotas (max concurrent tasks, max depth) before accepting, like K8s admission webhooks.
- **Watch semantics**: Instead of polling `sam_get_task()`, a parent agent could "watch" a task for status changes via long-poll or SSE, similar to the K8s Watch API.

### Nomad: Dispatch as First-Class Primitive

**Core insight**: Nomad's `job dispatch` creates a unique child job from a parameterized template. The caller receives a dispatch ID and can track the child's allocation lifecycle. Metadata flows down via `NOMAD_META_*` environment variables.

**SAM parallel**: This maps directly to the `sam_delegate_task` pattern. Key Nomad design decisions worth adopting:

- **Parameterized templates**: Define task templates with required/optional metadata fields. Delegation fills in the parameters.
- **Unique dispatch IDs**: Each delegation gets a trackable ID (SAM already has task IDs).
- **Payload delivery**: Nomad writes dispatch payload to a file the task can read at startup. SAM could write parent context to a well-known path in the workspace.
- **Parent-child relationship**: Nomad tracks which dispatched jobs came from which parent. SAM's `parentTaskId` serves this role.

**Key limitation to avoid**: Nomad's 16 KiB payload limit. SAM should use a shared context store (KV or D1) rather than inlining large contexts.

### Temporal: Durable Execution & Typed Context

**Core insight**: Temporal guarantees that Workflow code runs to completion regardless of failures. It achieves this through event sourcing — every state change is recorded, and on failure, the Workflow replays from the event log.

**SAM parallel**: The TaskRunner DO provides some durability (alarm-driven, state persisted in DO storage + D1). But it doesn't have Temporal's replay semantics. Key patterns worth adopting:

- **Durable context dictionary**: Temporal Workflows maintain a shared context object that Activities populate. SAM could maintain a `contextData` JSON field on tasks that child agents extend and parent agents read.
- **Typed result passing**: Activities return typed values to the Workflow. SAM's `complete_task` should accept structured JSON output, not just a string summary.
- **Child Workflows**: Temporal's first-class child workflow support is the exact pattern SAM needs for agent-spawns-agent. The parent workflow can await, timeout, or cancel child workflows.
- **Signals for messaging**: Temporal Signals deliver async messages to running Workflows. This is a cleaner primitive than polling-based inter-agent messaging.
- **Saga pattern**: For orchestration runs that need cleanup on failure, Temporal's compensating transaction pattern (undo step N-1 when step N fails) provides a template.

**Key architectural insight**: Temporal separates *orchestration logic* (the Workflow, which is deterministic and replayable) from *side effects* (Activities, which interact with the real world). SAM could adopt a similar separation: the TaskRunner handles orchestration (deterministic state machine), while agent execution is the "activity" (non-deterministic, may fail).

### Argo Workflows: DAG-Native Design

**Core insight**: Argo treats the DAG as a first-class workflow definition, not an afterthought. Steps declare dependencies, and the engine resolves parallelism automatically.

**SAM parallel**: SAM has `task_dependencies` in the schema and cycle detection in `task-graph.ts`. But the DAG isn't deeply integrated into execution — it's more of a constraint check than a scheduling engine.

**Applicable patterns**:
- **Template-based steps**: Argo defines reusable templates that DAG nodes reference. SAM's agent profiles + prompt templates could serve the same role.
- **Artifact passing**: Argo stores step outputs as artifacts (files in object storage) that downstream steps reference by name. SAM could use R2 for large artifacts or KV for small structured data.
- **Conditional execution**: Argo steps can have `when` conditions based on upstream results. SAM could support conditional task execution based on parent output.
- **Exit handlers**: Argo runs cleanup steps regardless of success/failure. SAM's orchestration runs need equivalent cleanup (delete workspaces, push final branches).

---

## Architecture Comparison Matrix

| Capability | Kubernetes | Nomad | Temporal | Argo | SAM (Current) | SAM (Target) |
|------------|-----------|-------|----------|------|---------------|--------------|
| **Task primitive** | Pod/Job | Job/Allocation | Workflow/Activity | Step/DAG node | Task + TaskRunner DO | Task + Orchestration Run |
| **Scheduling** | Complex bin-packing | Multi-region, constraints | Task Queues | Per-step | First-fit warm pool | Constraint-based with profiles |
| **Dependencies** | Init containers, operators | Service constraints | Child Workflows | DAG edges | `task_dependencies` table | DAG + automatic scheduling |
| **Result passing** | Shared volumes, ConfigMaps | Consul KV, artifacts | Typed Activity returns | Parameters + artifacts | `outputSummary` (string) | `outputData` (JSON) + KV |
| **Failure recovery** | Restart policy, rescheduling | Restart block, reschedule | Auto-retry + Saga | Retry + exit handlers | Manual retry | Configurable policy per run |
| **Inter-task messaging** | Service DNS, sidecars | Consul KV | Signals + Queries | None (artifact-based) | None | MCP message passing |
| **Observability** | Events, metrics, traces | Telemetry, structured logs | Event History replay | Step status + logs | Activity events, task status | Run dashboard + event log |
| **Multi-tenancy** | Namespaces, RBAC | Namespaces, ACLs | Namespaces | SSO, RBAC | User-scoped | Org-scoped (planned) |
| **Context management** | ConfigMaps, Secrets | Meta vars, payload | Workflow state | Parameters | Initial prompt only | Inherited context + shared KV |

---

## Recommended Path Forward

### Phase 1: Agent-Spawns-Agent (Highest Impact)

**Estimated effort**: 2-3 weeks

Add the core delegation tools to the MCP server:

1. **`sam_create_subtask`**: Create child task with parent context, description, and optional agent profile
2. **`sam_delegate_task`**: Trigger TaskRunner DO for a task (provisions workspace, starts agent)
3. **`sam_get_task`**: Query task status + outputs (enables parent polling)
4. **`sam_list_tasks`**: List tasks filtered by status, parent, run

**Key design decisions**:
- **Context injection**: Add `contextData` JSON column to tasks. Parent populates with analysis, constraints, file lists. Child's initial prompt synthesizes task description + inherited context.
- **Result delivery**: Pull model (parent polls `sam_get_task`). Simpler than push, sufficient for most patterns. Upgrade to webhook/SSE later if latency matters.
- **Guardrails**: max depth = 3, max workers per run = 5, max sub-tasks per parent = 10 (all configurable via `.sam/config.json`).

**What this unlocks**: An orchestrator agent can analyze a codebase, decompose work into sub-tasks, delegate each to specialized agents, and merge results. The fundamental "supervisor pattern" from multi-agent research.

### Phase 2: Orchestration Runs + Failure Policies

**Estimated effort**: 2-3 weeks

1. **`orchestration_runs` table**: Groups related tasks, tracks run-level status
2. **Run modes**: `direct` (user triggers delegation) and `orchestrated` (lead workspace coordinates)
3. **Failure policies**: `fail-fast` vs `continue-on-failure` per run
4. **Cascade cancellation**: Cancel run → cancel all child tasks
5. **Task-level retry**: `maxRetries` + `retryCount` on tasks table, automatic retry on failure

### Phase 3: Agent Profiles + Customization

**Estimated effort**: 1-2 weeks

1. **`agent_profiles` table**: Define roles with model, permission mode, system prompt
2. **Profile selection**: `sam_delegate_task` accepts profile parameter
3. **Session bootstrap**: Profile-specific config injected into ACP session
4. **Built-in profiles**: planner, implementer, reviewer, tester

### Phase 4: Inter-Agent Messaging + Observability

**Estimated effort**: 2-3 weeks

1. **`agent_messages` table**: Scoped to orchestration runs
2. **MCP tools**: `sam_send_message`, `sam_read_messages`, `sam_broadcast`
3. **Orchestration event log**: Structured events for all run actions
4. **Run dashboard**: Tree view of tasks, real-time status, event timeline
5. **Health monitoring**: Heartbeat-based watchdog during agent execution

### Phase 5: Advanced Patterns

**Estimated effort**: 3-4 weeks (ongoing)

1. **Conditional execution**: Tasks with `when` conditions based on parent output
2. **Artifact storage**: R2-backed large output sharing between tasks
3. **Scheduling policies**: Priority queues, resource constraints, affinity rules
4. **External integrations**: GitHub Issues → SAM Task import, Linear sync
5. **Organizations + multi-tenancy**: Shared infrastructure, RBAC, billing

---

## Open Design Questions

### 1. Context Size vs. Cost Tradeoff

How much context should a child agent receive? Full project CLAUDE.md + parent analysis could be 10-50KB of prompt tokens. Minimal context risks the child missing constraints and redoing work.

**Proposed approach**: The orchestrator decides per-task. The `contextData` field is optional — a planner agent crafts focused context for each child.

### 2. Polling vs. Push for Result Delivery

Parent agents polling `sam_get_task()` adds latency (1-5s per poll cycle) and API load. Push (webhook/SSE) is lower latency but more complex.

**Proposed approach**: Polling for Phase 1. The MCP tool can include a `wait_timeout` parameter for long-poll semantics (block for up to N seconds if task still running). Upgrade to SSE in Phase 4 if latency becomes a bottleneck.

### 3. Git Coordination for Multi-Agent Runs

When 5 agents push to different branches of the same repo, who merges?

**Proposed approach**: Orchestrator merges for `orchestrated` runs (lead workspace pulls all branches). Stacked PRs for `direct` delegation (each task creates its own PR).

### 4. Durable Execution: DO vs. Temporal

Should SAM adopt Temporal-style event sourcing for orchestration, or continue with the current DO + alarm approach?

**Assessment**: The DO + alarm approach is sufficient for the near term. It provides durability (survives Worker restarts), idempotency (safe retries), and is already battle-tested. Temporal's replay semantics would add complexity without clear benefit until SAM reaches Phase 5 scale. Re-evaluate if orchestration runs regularly exceed 50+ tasks or span hours.

### 5. Budget Enforcement

How to prevent runaway costs from recursive delegation?

**Proposed approach**: Per-run budget cap (total VM-minutes). Tracked in `orchestration_runs.config`. MCP delegation tools check budget before creating workspaces. Alert threshold at 80% of budget. Hard stop at 100%.

---

## Summary: Distance to True Orchestrator

| Capability | Status | Gap to Close |
|------------|--------|-------------|
| Single-agent task execution | Done | - |
| Alarm-driven TaskRunner DO | Done | - |
| Task dependency graph | Done | Needs DAG-driven scheduling |
| MCP server with basic tools | Done | Needs delegation + query tools |
| Warm node pooling | Done | - |
| Message persistence | Done | Needs cross-task aggregation |
| Agent-spawns-agent | Not started | Phase 1 (critical) |
| Child result propagation | Not started | Phase 1 (critical) |
| Orchestration runs | Not started | Phase 2 |
| Failure policies | Not started | Phase 2 |
| Agent profiles | Not started | Phase 3 |
| Inter-agent messaging | Not started | Phase 4 |
| Health monitoring/watchdog | Not started | Phase 4 |
| Conditional execution | Not started | Phase 5 |
| Organizations/multi-tenancy | Not started | Phase 5 |

**Bottom line**: SAM has ~40% of what's needed for true orchestration. The foundation (TaskRunner DO, MCP server, task dependencies, warm pool) is production-grade. The coordination layer (delegation, result passing, run management, failure handling) is entirely missing. Phase 1 alone would unlock the core value proposition — agents delegating to agents — and could be built in 2-3 weeks on the existing infrastructure.

---

## References

### SAM Internal
- [Orchestration Platform Vision](../design/orchestration-platform-vision.md) — full design doc for the target architecture
- [Task Delegation System Analysis](task-delegation-system-analysis.md) — analysis of the current task execution system
- [MCP Server Implementation](../../apps/api/src/routes/mcp.ts) — current MCP endpoint
- [TaskRunner DO](../../apps/api/src/durable-objects/task-runner.ts) — alarm-driven task orchestration
- [Task Graph Service](../../apps/api/src/services/task-graph.ts) — dependency management
- [Node Lifecycle DO](../../apps/api/src/durable-objects/node-lifecycle.ts) — warm pool state machine

### External Orchestration Systems
- [Kubernetes Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/) — native batch job primitives
- [Argo Workflows](https://argoproj.github.io/workflows/) — DAG-based workflow engine for Kubernetes
- [K8s v1.35 Job ManagedBy GA](https://kubernetes.io/blog/2025/12/18/kubernetes-v1-35-job-managedby-for-jobs-goes-ga/) — external controller delegation
- [K8s v1.33 Job Success Policy GA](https://kubernetes.io/blog/2025/05/15/kubernetes-1-33-jobs-success-policy-goes-ga/) — partial failure handling
- [Nomad Parameterized Jobs](https://developer.hashicorp.com/nomad/docs/job-specification/parameterized) — dispatch-based child task creation
- [Nomad Job Dispatch](https://developer.hashicorp.com/nomad/commands/job/dispatch) — CLI for creating child job instances
- [Temporal Durable Execution](https://temporal.io/) — workflow-as-code with automatic retry and replay
- [Temporal Multi-Agent Architectures](https://temporal.io/blog/using-multi-agent-architectures-with-temporal) — agent routing and task delegation patterns
- [Temporal Workflow Execution](https://docs.temporal.io/workflow-execution) — durable execution mechanics
- [Temporal Design Patterns](https://docs.temporal.io/evaluate/use-cases-design-patterns) — Saga, state machine, and orchestration patterns
