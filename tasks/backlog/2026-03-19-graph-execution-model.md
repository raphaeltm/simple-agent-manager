# Graph-Based Task Execution Model

**Created**: 2026-03-19
**Status**: Backlog
**Priority**: Medium (exploratory — not ready for implementation yet)
**Estimated Effort**: Very Large
**Origin**: Brainstorming session on task UX/UI redesign (session `ab65c5e4`, task `01KM27SG248RVMHYTF96HK8SKB`)

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

## Architecture Sketch

### Graph State Machine

```
[idea promoted to 'ready']
        │
        v
   [plan node]  ← optional: an agent that decomposes the idea into a graph
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

When a node completes, the scheduler checks which downstream nodes now have all their dependencies satisfied and starts them in parallel. This uses the existing `task_dependencies` table:

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
- NOT create cycles (enforce DAG property)

This is the key difference from fan-out/fan-in: any node can reshape the remaining work, not just the root orchestrator.

### Context Propagation

When a node starts, it receives:
- The original idea description and any brainstorming context
- Outputs declared by its upstream dependencies
- Optionally, summaries of what other nodes have done (for situational awareness)

Open question: how much context is too much? A deep graph could accumulate enormous context. May need summarization at each step.

## What Exists Today

| Component | Status | Gap |
|-----------|--------|-----|
| `task_dependencies` table | Schema exists | Not enforced by task runner |
| `parentTaskId` on tasks | Schema exists | Used for dispatch lineage, not graph structure |
| `dispatch_task` MCP tool | Working | Creates independent tasks, no dependency edges |
| `complete_task` MCP tool | Working | Best-effort, agents sometimes don't call it |
| Task runner | Working | Flat execution only — one task, one workspace |
| Warm node pooling | Working | Can reuse nodes for graph node execution |

## Implementation Phases (Rough)

### Phase 1: Foundation
- Task runner respects `task_dependencies` — don't start a task until dependencies are met
- API endpoint to add dependency edges
- UI visualization of task graph on the Ideas page (probably a simple dependency list, not a full graph visualization yet)

### Phase 2: Orchestrated Decomposition
- "Plan" step that takes an idea and produces a task graph
- Could be agent-driven (an agent reads the idea + brainstorming and proposes decomposition)
- Human reviews and approves the graph before execution starts

### Phase 3: Dynamic Graph
- MCP tools for executing agents to add nodes/edges
- Scheduler that monitors completions and starts ready nodes
- LLM-based completion detection as fallback

### Phase 4: Context and Output Propagation
- Nodes declare typed outputs
- Downstream nodes receive upstream outputs as context
- Summarization for deep graphs

## Open Questions

- **Termination**: How do we know the whole graph is done? When all nodes with no outgoing edges are complete? What if a node keeps adding more work?
- **Cost control**: Unbounded graph growth means unbounded VM costs. Need limits (max nodes, max depth, max total execution time).
- **Visibility**: How does the user see what's happening? A live-updating graph view? A timeline? Just a list with status indicators?
- **Failure handling**: If node C fails, what happens to nodes D and E that depend on it? Automatic retry? Mark the whole subgraph as blocked? Let the user decide?
- **Agent capability**: Can current agents (Claude Code, Codex) actually produce useful structured outputs and respond to "are you done?" queries reliably? Needs testing.
- **Conflict resolution**: If nodes B and C both modify the same file, how do we merge? Git-based (each node works on a branch, merge at convergence points)?

## Related

- `tasks/backlog/2026-03-19-ideas-page-and-ideation-system.md` — the Ideas system that feeds into this execution model
- `tasks/backlog/2026-03-09-task-resource-requirements.md` — resource requirements per task node
- `tasks/backlog/2026-03-14-unified-session-task-workspace-state-machine.md` — state machine unification
- `specs/021-task-chat-architecture/` — current task execution architecture
- `specs/027-do-session-ownership/` — ACP session lifecycle, heartbeats, fork lineage
