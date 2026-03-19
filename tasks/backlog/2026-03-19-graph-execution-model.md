# Graph-Based Task Execution Model

**Created**: 2026-03-19
**Status**: Backlog
**Priority**: Medium (exploratory — not ready for implementation yet)
**Estimated Effort**: Very Large
**Origin**: Brainstorming session on task UX/UI redesign (session `ab65c5e4`, task `01KM27SG248RVMHYTF96HK8SKB`)
**Design Session**: 2026-03-19 chat session `7a44ecbf` — explored DO architecture, completion model, execution modes, run ownership

## Summary

Design and build a graph-based execution model where a promoted idea can be decomposed into a DAG of sub-tasks with dependencies, parallel execution, and dynamic replanning. This is the execution backbone that makes the Ideas system (see `2026-03-19-ideas-page-and-ideation-system.md`) powerful for complex, multi-step work.

## Problem Statement

Today, task execution is flat: one task → one agent → one workspace. For anything non-trivial, users manually decompose work into separate tasks and run them sequentially. Agents can use `dispatch_task` to spawn sub-tasks, but there's no dependency tracking, no parallel coordination, and no way for downstream tasks to wait on upstream outputs.

The `task_dependencies` table already exists in the schema (with `taskId` + `dependsOnTaskId` composite key) but is purely informational — the task runner doesn't enforce or schedule based on it.

## Two Execution Models Considered

### Fan-Out / Fan-In (Tree)

The more common pattern in existing systems:
1. Orchestrator agent starts
2. Decomposes into N sub-tasks, dispatches them
3. Sub-tasks execute (possibly spawning their own sub-tasks)
4. Results funnel back to orchestrator
5. Orchestrator synthesizes and produces final output

**Pros**: Simple mental model, clear hierarchy, orchestrator maintains coherence.
**Cons**: Rigid — the orchestrator decides the plan upfront. If sub-task 3 discovers the plan needs to change, it can't easily restructure the graph. Information flows up/down the tree but not laterally between siblings.

### Mutable DAG (Graph)

Each node in the graph can:
1. Execute its work
2. Declare outputs
3. Discover that new work is needed and add nodes/edges to the graph
4. Signal completion so downstream nodes can start

**Pros**: More flexible — the execution plan evolves as agents learn. Matches reality better: you often don't know the full plan until you start. Leverages SAM's VM architecture — each node is a real workspace with full autonomy.
**Cons**: Harder to reason about. Risk of unbounded graph growth. Need clear termination conditions.

### Decision

The mutable DAG is more interesting and better suited to SAM's architecture. SAM spins up real VMs with full execution environments — each graph node gets genuine autonomy rather than being a function call in an orchestrator. The graph can adapt as agents discover the real shape of the work.

However, the fan-out/fan-in pattern should be a natural subset — a graph where no node adds new nodes is effectively a tree.

## Architecture Design

### DO Hierarchy

```
GraphRunner DO (scheduling, per orchestration run, keyed by runId)
  └── TaskRunner DOs (execution, per task, keyed by taskId) — existing, unchanged
        └── NodeLifecycle DOs (VM management, per node) — existing, unchanged
```

The GraphRunner is pure scheduling logic — it doesn't touch infrastructure. TaskRunner keeps doing what it already does (node selection, workspace creation, agent session). GraphRunner decides *when* to start each TaskRunner based on the dependency graph.

### GraphRunner DO

One instance per orchestration run, instantiated via `env.GRAPH_RUNNER.idFromName(runId)`.

```typescript
// DO storage (survives restarts, survives Worker recycling)
interface GraphRunnerState {
  runId: string;
  rootTaskId: string;
  projectId: string;
  userId: string;
  mode: 'plan-first' | 'immediate';
  phase: 'planning' | 'executing' | 'completing' | 'done' | 'failed';

  // Execution tracking — the graph edges live in D1 (task_dependencies),
  // but the DO caches which tasks are active for fast alarm-driven checks
  activeTaskIds: string[];
  completedTaskIds: string[];
  failedTaskIds: string[];
}
```

On each alarm tick:
1. Query D1 for tasks in this run + their dependency edges
2. Compare against active/completed/failed sets
3. Find newly unblocked tasks (all dependencies satisfied)
4. Spawn TaskRunner DOs for each
5. If nothing running and nothing unblockable → run is done (or stuck)

### Run Instantiation Flow

```
User says "run this idea"
        │
        ▼
  API route: POST /api/projects/:id/runs
  Creates orchestration_run row in D1
  Instantiates GraphRunner DO:
    const id = env.GRAPH_RUNNER.idFromName(runId);
    const stub = env.GRAPH_RUNNER.get(id);
    await stub.start({ runId, rootTaskId, mode });
        │
        ├── mode: 'plan-first'
        │     GraphRunner spawns a single "planner" TaskRunner
        │     Planner agent reads idea + project context
        │     Planner uses MCP tools to create sub-tasks + dependency edges
        │     Planner calls complete_task → GraphRunner reads the resulting graph
        │     GraphRunner starts executing the graph
        │
        └── mode: 'immediate'
              GraphRunner starts root tasks directly
              Agents add nodes/edges as they discover work (mutable DAG)
              Graph evolves organically during execution
```

**Mode selection heuristic** (system default, user can override):
- Idea has no sub-tasks defined → default `plan-first`
- Idea already has sub-tasks with dependency edges → default `immediate`

### Completion Notification: Callback + Reconciliation

**Design decision**: callbacks for speed, alarm polling as consistency check. Same pattern as VM heartbeat + NodeLifecycle alarm.

**Fast path — DO-to-DO callback**:
When a TaskRunner finishes, it calls `graphRunner.taskCompleted(taskId, status, outputs)` directly. The `orchestration_run_id` on the task row tells the TaskRunner which GraphRunner to notify. GraphRunner immediately evaluates unblocked tasks and spawns them.

**Safety net — reconciliation alarm** (every ~30s, configurable via `GRAPH_RUNNER_RECONCILE_INTERVAL_MS`):
GraphRunner reads all tasks for its run from D1, compares D1 status vs. its in-memory tracking. Catches:
- Dropped callbacks (network blip between DOs — rare on CF but possible)
- Out-of-band completions (agent called `complete_task` but TaskRunner crashed before sending callback)
- Stale state after DO eviction (GraphRunner rehydrates from storage, needs to catch up)

**Callback payload**:
```typescript
interface TaskCompletionCallback {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  outputs?: {
    summary?: string;           // what the agent did
    branch?: string;            // git branch with changes
    prUrl?: string;             // PR if created
    artifacts?: Record<string, string>;  // named outputs for downstream context
  };
}
```

### Run Ownership

**Design decision**: one run owns one graph. A task belongs to exactly one run once execution starts.

- `orchestration_run_id` on tasks table: `NULL` = unattached idea/draft, non-NULL = owned by that run
- A task with a run ID can't be claimed by another run
- Re-runs create a *new* run (old run = historical record), don't retry the same run
- This gives clean separation between "the idea and its decomposition" vs. "a specific execution attempt"

### Graph State Machine

```
[idea promoted to 'ready']
        │
        v
   [plan node]  ← optional: only in plan-first mode
        │
        v
   ┌─────────────────────────────────┐
   │          Execution Graph         │
   │                                  │
   │   [node A] ──→ [node D] ──→     │
   │       │                  │      │
   │   [node B] ──→ [node E] ──→ [node F: merge/deploy]
   │                  ↑              │
   │   [node C] ──────┘              │
   │                                  │
   │   (node C discovers new work)    │
   │   [node C] adds [node G] ──→ [node E]  │
   │                                  │
   └─────────────────────────────────┘
```

### Node Specification

Each node in the graph should declare:
- **Inputs**: what data/context it needs from upstream nodes (or the original idea)
- **Outputs**: what it produces that downstream nodes need
- **Completion signal**: explicit "I'm done, here's my output" (not timeout-based)

### Completion Detection

Three layers, in order of preference:

1. **Explicit completion**: The agent calls `complete_task` MCP tool with its outputs. This is the ideal path.

2. **LLM-based manager check**: A scheduler/supervisor periodically reads the last few messages from a running session and asks an LLM: "Is this agent done? Respond yes/no." This handles agents that forget to call `complete_task`.
   - **Important caveat**: Agents using sub-agents sometimes have buffered output. Sending a follow-up message ("have you finished?") can cause the agent to release buffered content rather than give a real answer. May need to send multiple follow-up messages and look for a consistent "yes I'm done" signal.

3. **Timeout-based fallback**: If no activity for X minutes, mark as stalled. This is the safety net, not the primary mechanism.

### Parallel Execution

When a node completes, the GraphRunner checks which downstream nodes now have all their dependencies satisfied and starts them in parallel. This uses the existing `task_dependencies` table:

```
node D depends on [node A]           → starts when A completes
node E depends on [node B, node C]   → starts when BOTH B and C complete
node F depends on [node D, node E]   → final merge, starts when D and E complete
```

The task runner already handles node provisioning and workspace creation. Parallel execution means multiple tasks can be `in_progress` simultaneously — each on its own workspace/VM.

### Dynamic Graph Mutation

An executing node can:
- Add new nodes to the graph (via an MCP tool or API call)
- Add new dependency edges
- NOT remove or modify already-completed nodes
- NOT create cycles (enforce DAG property via existing `wouldCreateTaskDependencyCycle()`)

This is the key difference from fan-out/fan-in: any node can reshape the remaining work, not just the root orchestrator.

### Context Propagation

When a node starts, it receives:
- The original idea description and any brainstorming context
- Outputs declared by its upstream dependencies (via `artifacts` in the completion callback)
- Optionally, summaries of what other nodes have done (for situational awareness)

Open question: how much context is too much? A deep graph could accumulate enormous context. May need summarization at each step.

## What Exists Today

| Component | Status | Gap |
|-----------|--------|-----|
| `task_dependencies` table | Schema exists | Not enforced by task runner |
| `parentTaskId` on tasks | Schema exists | Used for dispatch lineage, not graph structure |
| `dispatch_task` MCP tool | Working | Creates independent tasks, no dependency edges |
| `complete_task` MCP tool | Working | Best-effort, agents sometimes don't call it |
| Task runner DO | Working | Flat execution only — one task, one workspace |
| Warm node pooling | Working | Can reuse nodes for graph node execution |
| `task-graph.ts` cycle detection | Working | Used only for manual task runs, not by TaskRunner |
| `task-graph.ts` blocked-task check | Working | Used only for manual task runs |
| `orchestration_runs` table | **Missing** | Proposed in vision doc, never created |
| `orchestration_run_id` on tasks | **Missing** | No run grouping for tasks |
| GraphRunner DO | **Missing** | No graph-aware scheduler |
| TaskRunner → GraphRunner callback | **Missing** | TaskRunner has no awareness of runs |

## Implementation Phases

### Phase 1: Foundation — GraphRunner DO + Run Ownership
- Create `orchestration_runs` table in D1
- Add `orchestration_run_id` column to tasks table
- Build GraphRunner DO: alarm-driven scheduler that reads `task_dependencies` and spawns TaskRunner DOs when dependencies are satisfied
- Add callback hook in TaskRunner: notify GraphRunner on task completion
- Add reconciliation alarm in GraphRunner (poll D1 as safety net)
- API route: `POST /api/projects/:id/runs` to create a run and instantiate GraphRunner
- Wire existing `task-graph.ts` utilities (`isTaskBlocked`, `getBlockedTaskIds`) into GraphRunner scheduling logic
- Support `immediate` mode only (graph must be pre-built)

### Phase 2: Orchestrated Decomposition (plan-first mode)
- "Plan" step that takes an idea and produces a task graph
- Agent-driven: planner agent reads idea + brainstorming context, uses MCP tools to create sub-tasks + edges
- Human reviews and approves the graph before execution starts
- GraphRunner supports `plan-first` mode: spawn planner, wait for completion, then execute resulting graph
- System-level mode selection heuristic (no sub-tasks → plan-first, sub-tasks exist → immediate)

### Phase 3: Dynamic Graph Mutation
- MCP tools for executing agents to add nodes/edges mid-run (`add_graph_node`, `add_graph_edge`)
- GraphRunner handles graph changes during execution (re-evaluate unblocked tasks on mutation)
- Cycle detection on every edge addition (already exists in `task-graph.ts`)
- Guards: max nodes per run, max depth, prevent mutation of completed subgraphs
- LLM-based completion detection as fallback for agents that don't call `complete_task`

### Phase 4: Context and Output Propagation
- Tasks declare typed outputs via `artifacts` field on completion callback
- Downstream tasks receive upstream `artifacts` as input context when started
- Summarization for deep graphs (avoid context bloat)
- Original idea description + brainstorming context threaded through all nodes

## Open Questions

### Explored but not yet decided
- **Context propagation depth**: How much upstream context is too much? Summarize at each hop? Only pass direct parent outputs? Configurable per-node?
- **Graph mutation MCP tools**: Exact tool signatures for `add_graph_node` / `add_graph_edge`. Should agents be able to remove pending (not-yet-started) nodes? What about re-prioritizing?
- **Planner agent design**: What prompt/profile produces good task decompositions? How does it know the right granularity? Does it have access to the codebase or just the idea description?
- **Failure semantics**: If node C fails, what happens to downstream nodes D and E? Options: mark subgraph as blocked (let user decide), auto-retry on new workspace, configurable per-run failure policy (`fail-fast` vs. `continue-on-failure` vs. `retry-N-times`)
- **Git coordination**: Multiple agents working on the same repo. Options: (a) orchestrator merges all task branches, (b) stacked PRs per task, (c) trunk-based with rebasing. Recommendation from vision doc: (a) for orchestrated runs, (b) for direct delegation.

### Fundamental
- **Termination**: How do we know the whole graph is done? When all leaf nodes (no outgoing edges) are complete? What if a node keeps adding more work? Need a max-nodes-per-run limit as a hard stop.
- **Cost control**: Unbounded graph growth means unbounded VM costs. Need limits: max nodes per run, max total execution time, max parallel workers. Configurable via `GRAPH_RUNNER_MAX_NODES`, `GRAPH_RUNNER_MAX_DURATION_MS`, `GRAPH_RUNNER_MAX_PARALLEL`.
- **Visibility**: How does the user see what's happening? Live-updating graph visualization? Timeline view? List with status indicators? Should integrate with the Ideas page redesign.
- **Agent capability**: Can current agents (Claude Code, Codex) actually produce useful structured outputs and respond to "are you done?" queries reliably? Needs empirical testing.

## Related

- `tasks/backlog/2026-03-19-ideas-page-and-ideation-system.md` — the Ideas system that feeds into this execution model
- `tasks/backlog/2026-03-09-task-resource-requirements.md` — resource requirements per task node
- `tasks/backlog/2026-03-14-unified-session-task-workspace-state-machine.md` — state machine unification
- `docs/design/orchestration-platform-vision.md` — full orchestration platform vision (Feb 2026)
- `docs/notes/2026-03-08-orchestrator-maturity-assessment.md` — gap analysis, SAM at Level 2 of 5
- `apps/api/src/services/task-graph.ts` — existing DAG cycle detection + blocked-task checks
- `apps/api/src/durable-objects/task-runner.ts` — current flat task execution DO
- `specs/021-task-chat-architecture/` — current task execution architecture
- `specs/027-do-session-ownership/` — ACP session lifecycle, heartbeats, fork lineage
