---
title: Task Execution
description: How to submit tasks, understand the task lifecycle, and use agent-to-agent dispatch in SAM.
---

Tasks are the primary way to use SAM for autonomous AI coding work. You describe what you want done, and SAM handles provisioning, agent execution, and cleanup.

## Submitting a Task

You can submit tasks through the **project chat interface**. Type your task description in the chat input and submit. SAM will:

1. **Generate a title** — AI-powered title generation using Workers AI (short messages are used as-is)
2. **Create a branch** — descriptive branch name with `sam/` prefix
3. **Select a node** — reuses a warm node if available, otherwise provisions a new one
4. **Create a workspace** — clones your repo and sets up the environment
5. **Start the agent** — runs your configured agent (Claude Code, Codex, Gemini, or Mistral Vibe) with your task description
6. **Stream output** — watch the agent work in real-time through the chat interface

### Task Options

When submitting a task, you can optionally specify:

| Option | Description | Default |
|--------|-------------|---------|
| **VM Size** | small, medium, or large | Project default |
| **Provider** | Hetzner or Scaleway | Project default provider |
| **Agent Type** | Which AI agent to use | Project default agent |
| **Workspace Profile** | `full` or `lightweight` | `full` |
| **Node** | Reuse a specific existing node | Auto-select |

## Task Lifecycle

Tasks progress through these statuses:

```
draft → ready → queued → delegated → in_progress → completed/failed/cancelled
```

### Execution Steps

While a task is running, the task runner tracks detailed progress:

| Step | Description |
|------|-------------|
| `node_selection` | Finding or provisioning a node |
| `node_provisioning` | Waiting for the VM to boot |
| `node_agent_ready` | Waiting for the VM Agent to report ready |
| `workspace_creation` | Creating the Docker container and cloning the repo |
| `workspace_ready` | Waiting for the devcontainer to finish building |
| `agent_session` | Starting the AI agent session |
| `running` | Agent is actively working |

### What Happens When a Task Completes

When an agent finishes its work:

1. The agent commits and pushes changes to the branch
2. A pull request is created automatically
3. A `task_complete` notification is sent
4. The workspace is stopped
5. If the node was auto-provisioned and has no other active workspaces, it enters the **warm pool** for potential reuse

## AI Task Title Generation

SAM automatically generates concise titles for tasks using Workers AI. The generation works as follows:

- Messages **at or below 100 characters** are used as the title directly (no AI needed)
- Longer messages are summarized by a Workers AI model (default: `@cf/google/gemma-3-12b-it`)
- If AI generation fails or times out, the message is truncated to 100 characters as a fallback
- Generation uses exponential backoff with up to 2 retries

Configure via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `TASK_TITLE_MODEL` | `@cf/google/gemma-3-12b-it` | Workers AI model for title generation |
| `TASK_TITLE_GENERATION_ENABLED` | `true` | Set `false` to always use truncation |
| `TASK_TITLE_TIMEOUT_MS` | `5000` | Per-attempt timeout |
| `TASK_TITLE_SHORT_MESSAGE_THRESHOLD` | `100` | Messages at or below this length bypass AI |

## Agent-to-Agent Dispatch

Running agents can spawn follow-up tasks within the same project using the `dispatch_task` MCP tool. This enables multi-step workflows where one agent delegates subtasks to others.

### How It Works

An agent running inside a workspace has access to MCP tools that provide project awareness:

| Tool | Purpose |
|------|---------|
| `dispatch_task` | Spawn a new task in the same project |
| `list_tasks` | View existing tasks |
| `get_task_details` | Read task details |
| `search_tasks` | Search tasks by keyword |
| `update_task_status` | Report progress |
| `complete_task` | Mark the current task as done |
| `request_human_input` | Ask the user for a decision |

### Dispatch Limits

To prevent runaway recursion, dispatch has configurable limits:

| Limit | Default | Env Variable |
|-------|---------|-------------|
| Max recursion depth | 3 | `MCP_DISPATCH_MAX_DEPTH` |
| Max tasks per parent | 5 | `MCP_DISPATCH_MAX_PER_TASK` |
| Max active dispatched per project | 10 | `MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT` |

### Example Flow

```
User submits: "Refactor the auth module and add tests"
  │
  ├── Agent 1 starts working on refactoring
  │     ├── dispatch_task("Write unit tests for new auth service")
  │     │     └── Agent 2 writes tests in parallel
  │     └── dispatch_task("Update API docs for auth changes")
  │           └── Agent 3 updates documentation
  │
  └── All agents commit, push, and create PRs
```

## Warm Node Pooling

After a task completes, the auto-provisioned node enters a **warm** state instead of being destroyed immediately. This dramatically reduces startup time for follow-up tasks.

### How It Works

1. Task completes → workspace is stopped
2. If the node has no other active workspaces, it enters the warm pool
3. The `NodeLifecycle` Durable Object schedules a cleanup alarm
4. If a new task arrives before the timeout, the warm node is reused (seconds vs. minutes)
5. After the timeout expires, the node is destroyed

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_WARM_TIMEOUT_MS` | `1800000` (30 min) | How long warm nodes stay alive |
| `MAX_AUTO_NODE_LIFETIME_MS` | `14400000` (4 hr) | Absolute max lifetime for auto-provisioned nodes |
| `NODE_WARM_GRACE_PERIOD_MS` | `2100000` (35 min) | Cron sweep grace period |

### Orphan Protection

SAM uses three layers of defense to prevent orphaned VMs from running indefinitely:

1. **Durable Object alarm** — primary cleanup mechanism
2. **Cron sweep** — catches nodes that miss their DO alarm (every 5 minutes)
3. **Max lifetime** — absolute 4-hour limit regardless of warm state
