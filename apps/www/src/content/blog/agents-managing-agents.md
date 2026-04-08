---
title: "Agents Managing Agents"
date: 2026-04-08
author: Raphaël Titsworth-Morin
category: devlog
tags: ["ai-agents", "open-source", "architecture", "mcp", "orchestration"]
excerpt: "We built agent-to-agent orchestration into SAM. Here's what we learned about the surprisingly hard problems hiding inside 'just let agents coordinate.'"
---

I was sitting in a chat session with an agent, testing something we'd been building for the past week. I typed a message telling the agent to dispatch a subtask to another agent. A few seconds later, a new workspace spun up, a fresh agent booted, and it said: "Hello from subtask!"

The parent agent saw it. I asked the parent to send a message to the child. It did. The child received it and responded. Then I asked the parent to stop the child. It sent a warning, waited a few seconds, and shut it down.

It's one of those moments where the thing you've been building in pieces suddenly works end-to-end and you just sit there for a second. Agents talking to agents. Not in some demo. In the actual system, on real infrastructure, with real auth and real cleanup.

This is the story of how we built agent-to-agent orchestration into SAM, and what we learned about the surprisingly hard problems hiding inside "just let agents coordinate."

## Why agents need to talk to each other

SAM's core loop has always been simple: you describe a task, the system provisions a workspace, starts an agent, and the agent works on it. Task in, pull request out.

But some tasks are too big for one agent. Or they have natural parallelism. Or they need different expertise. A parent agent analyzing a codebase might realize it needs three things done: update the API, fix the tests, and write the docs. Doing those sequentially in one session is slow. Dispatching them to three agents working in parallel is faster and produces better results, because each agent gets a clean workspace and a focused task.

We already had `dispatch_task` from a previous round of work. A parent agent could spawn child tasks. But that was it. Fire and forget. The parent couldn't send instructions to a running child. Couldn't cancel one that went off track. Couldn't retry a failed one with better context. Couldn't say "wait for task A to finish before starting task B."

The parent was a manager who could hire people but couldn't talk to them after they started working. Not great.

## The six tools

We built six MCP tools that give parent agents real control over their children. Here's what they do and why each one exists.

**`send_message_to_subtask`** injects a user-role message into a running child agent's session. The parent can course-correct a child mid-execution without stopping it. This goes directly to the child's agent session over HTTP. No polling, no queue. The child sees it as if a human typed something.

**`stop_subtask`** shuts down a child agent. But not abruptly. It sends an optional warning message first ("wrap up, you're about to be stopped"), waits a configurable grace period (default 5 seconds), then hard-stops the session. The child gets a chance to commit its work. The task status gets updated to failed with the reason.

**`retry_subtask`** stops a failed child and dispatches a fresh replacement. The new task description automatically includes what went wrong last time, so the retry agent has context about the failure. Retries count against the parent's child limit to prevent infinite loops.

**`add_dependency`** creates an ordering constraint: "task B depends on task A." This is how a parent says "don't start the docs task until the API task is done." Dependencies are validated with BFS cycle detection (capped at 500 iterations) so you can't create circular waits.

**`remove_pending_subtask`** removes a queued task that hasn't started yet. Plans change. Sometimes the parent realizes a subtask isn't needed after all.

**`get_task_dependencies`** returns the full graph: parent, children, siblings. A parent uses this to understand the current state of everything it's spawned.

## The hard parts

The tools themselves are straightforward. The hard parts are the things that make them safe to use at scale.

### Authentication without token proliferation

Every agent in SAM gets a task-scoped MCP token when it starts. That token proves who the agent is and what task it's working on. When a parent calls `send_message_to_subtask`, the system checks: is the caller actually the direct parent of this child?

```typescript
if (childTask.parentTaskId !== tokenData.taskId) {
  return error('Only the direct parent task can communicate with a child task');
}
```

Simple rule, strictly enforced. A task can't control its siblings. Can't control its grandchildren. Only its own immediate children. We didn't need to issue new tokens or build a separate auth layer. The existing task-scoped tokens already carry the identity we need.

This matters beyond SAM. If you're building any multi-agent system, think carefully about the authorization model. "Can agent A tell agent B what to do?" is a security question, not just a UX question.

### Rate limiting without races

When a parent dispatches a subtask, the system needs to check: has this parent already hit its child limit? Is the project at its concurrency cap?

The obvious approach is: count the existing children, check against the limit, then insert. But between the count and the insert, another dispatch could sneak in. Classic TOCTOU (time-of-check to time-of-use) race.

We solved this with an atomic conditional INSERT:

```sql
INSERT INTO tasks (...)
  SELECT ?, ?, ...
  WHERE (
    SELECT count(*) FROM tasks
    WHERE parent_task_id = ?
    AND status IN ('running', 'assigned', 'queued')
  ) < ?
```

If a concurrent dispatch pushes the count over the limit between the advisory pre-check and the atomic INSERT, the subquery reflects it and the INSERT produces zero rows. No phantom tasks, no compensating rollbacks. The database does the coordination.

This pattern is useful anywhere you need "create something only if a count-based limit isn't exceeded" without pessimistic locking. It works in SQLite, Postgres, MySQL. The key insight is pushing the limit check into the INSERT's WHERE clause instead of doing it as a separate step.

### Graceful shutdown is a protocol, not an event

Stopping an agent isn't like killing a process. The agent might be mid-commit, mid-push, or mid-way through writing a file. A hard kill can leave the workspace in a broken state.

Our stop sequence is a three-step protocol:

1. **Warn:** Send a message to the child ("you're about to be stopped, wrap up")
2. **Wait:** Grace period. Default 5 seconds, configurable up to 30
3. **Stop:** Hard-cancel the agent session, update the task status

The warning is best-effort. If the agent is busy processing something and can't receive the message, we don't block on it. We move to step 3 after the grace period regardless.

This pattern shows up everywhere in distributed systems. Kubernetes pod termination does the same thing (SIGTERM, grace period, SIGKILL). The lesson: if you're building any system where one process controls another's lifecycle, build the shutdown as a multi-step protocol with a hard deadline.

## What it looks like in the UI

We added a grouped cards view to the project chat sidebar. Parent tasks show a green accent strip with a "3 SUB" badge and a progress bar (1/3 completed). Expand the group to see each child task with its status. Children that are blocked by dependencies show a "BLOCKED: Waiting on [sibling]" badge.

It's simple. It makes the parent-child relationship visible without requiring a separate graph visualization page. Most of the time you just want to glance at the sidebar and see "the parent dispatched 3 tasks, 2 are done, 1 is still running."

## What surprised us

**Direct HTTP beats queues for inter-agent messaging.** Our first instinct was to build an inbox system where the parent drops messages into a queue and the child polls for them. We built the inbox (it's still there as a safety net for async notifications). But for the happy path, direct HTTP calls to the running agent session are faster and simpler. The parent calls, the child receives the message immediately, the parent gets confirmation it was delivered. No polling interval, no eventual consistency.

**Authorization is the whole design.** We spent more time on "who can do what to whom" than on any other aspect. The direct-parent-only rule, the cycle detection in dependency graphs, the child count limits. Remove any of these and the system becomes unsafe. A bug that lets task A control task B's children would be a serious security issue in a multi-user system.

**Agents are surprisingly good at being managers.** Once we gave the parent agent these tools, it started doing sensible things we didn't explicitly program. Dispatching tasks in dependency order. Checking child progress before deciding whether to retry. Sending encouragement messages to stuck children (okay, that one was more entertaining than useful). The tools are primitives. The coordination strategy emerges from the agent's reasoning.

## What this actually unlocks

Here's the scenario I keep thinking about. I'm in a conversation with an agent and we decide SAM needs a new cloud provider. The agent breaks it down: implement the provider interface, update the cloud-init templates, add the API validation, write the tests, update the docs. Five tasks with dependencies — the API validation depends on the provider interface, the tests depend on both, the docs depend on everything.

The agent dispatches all five. Three start immediately (provider, cloud-init, docs skeleton). Two wait for their dependencies. One of the parallel tasks fails because it made an incorrect assumption about the Scaleway API. The parent sees the failure, reads the error, dispatches a retry with "the instance type field is called `commercial_type`, not `instance_type` — here's the API response that shows why." The retry succeeds. Dependencies unblock. Five PRs land, each from a focused agent with a clean workspace.

I'm not there yet. But every piece of that workflow exists now. Dispatch, dependencies, messaging, retry with context, graceful shutdown. The parent agent has the tools. The infrastructure handles the auth, the rate limiting, the lifecycle.

The thing that makes this feel different from other multi-agent demos is that it's not choreographed. There's no hardcoded DAG. The parent agent reasons about what to dispatch, when to retry, and what context to pass. The orchestration tools are primitives. The coordination strategy is emergent.

We actually built the orchestration system this way. The feature was six phases. Each phase was dispatched to an agent from a brainstorming conversation. The agents implemented, tested, and opened PRs. I reviewed and merged. Next time, the parent agent could manage that dispatch itself, using the tools those agents built.

There's something recursive about building agent infrastructure using agents. The tools get better, which makes the agents more capable, which lets them build better tools. I don't know exactly where that loop leads. But sitting in a chat session watching agents coordinate on real work… it feels like the beginning of something.

The code is open source. The orchestration tools live in `apps/api/src/routes/mcp/` and the authorization logic is in the orchestration modules. If you're building multi-agent systems, [come take a look](https://github.com/raphaeltm/simple-agent-manager).
