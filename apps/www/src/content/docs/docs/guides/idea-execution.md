---
title: Idea Execution
description: How ideas go from description to pull request — execution lifecycle, agent dispatch, and warm node pooling.
---

Ideas are the primary way to use SAM for autonomous AI coding work. You describe what you want done in the chat, and SAM handles provisioning, agent execution, and cleanup.

## Executing an Idea

You execute ideas through the **project chat interface**. Type your description in the chat input and submit. SAM will:

1. **Generate a title** — AI-powered title generation using Workers AI (short messages are used as-is)
2. **Create a branch** — descriptive branch name with `sam/` prefix
3. **Select a node** — reuses a warm node if available, otherwise provisions a new one
4. **Create a workspace** — clones your repo and sets up the environment
5. **Start the agent** — runs your configured agent (Claude Code, Codex, Gemini, or Mistral Vibe) with your description
6. **Stream output** — watch the agent work in real-time through the chat interface

### Execution Options

When executing an idea, you can optionally specify:

| Option | Description | Default |
|--------|-------------|---------|
| **VM Size** | small, medium, or large | Project default |
| **Provider** | Hetzner or Scaleway | Project default provider |
| **Agent Type** | Which AI agent to use | Project default agent |
| **Workspace Profile** | `full` or `lightweight` | `full` |
| **Node** | Reuse a specific existing node | Auto-select |

## Idea Lifecycle

Ideas progress through these stages as seen in the UI:

| Stage | What's happening |
|-------|-----------------|
| **Exploring** | You're brainstorming — the idea is a draft |
| **Ready** | The idea is defined and ready to execute |
| **Executing** | An agent is actively working on it |
| **Done** | The agent finished and created a PR |
| **Parked** | The idea was cancelled or execution failed |

### Execution Steps

While an idea is executing, SAM tracks detailed progress:

| Step | Description |
|------|-------------|
| `node_selection` | Finding or provisioning a node |
| `node_provisioning` | Waiting for the VM to boot |
| `node_agent_ready` | Waiting for the VM Agent to report ready |
| `workspace_creation` | Creating the Docker container and cloning the repo |
| `workspace_ready` | Waiting for the devcontainer to finish building |
| `agent_session` | Starting the AI agent session |
| `running` | Agent is actively working |

### What Happens When Execution Completes

When an agent finishes its work:

1. The agent commits and pushes changes to the branch
2. A pull request is created automatically
3. A notification is sent
4. The workspace is stopped
5. If the node was auto-provisioned and has no other active workspaces, it enters the **warm pool** for potential reuse

## AI Title Generation

SAM automatically generates concise titles for ideas using Workers AI:

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

Running agents can spawn follow-up work within the same project using MCP tools. This enables multi-step workflows where one agent delegates sub-work to others.

### How It Works

An agent running inside a workspace has access to MCP tools that provide project awareness:

| Tool | Purpose |
|------|---------|
| `dispatch_task` | Spawn a new idea for execution |
| `create_idea` | Create a new idea |
| `update_idea` | Update an idea's title, content, priority, or status |
| `list_ideas` | View existing ideas |
| `get_idea` | Read idea details |
| `search_ideas` | Search ideas by keyword |
| `update_task_status` | Report progress |
| `complete_task` | Mark the current work as done |
| `request_human_input` | Ask the user for a decision |

### Dispatch Limits

To prevent runaway recursion, dispatch has configurable limits:

| Limit | Default | Env Variable |
|-------|---------|-------------|
| Max recursion depth | 3 | `MCP_DISPATCH_MAX_DEPTH` |
| Max dispatched per parent | 5 | `MCP_DISPATCH_MAX_PER_TASK` |
| Max active dispatched per project | 10 | `MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT` |

### Example Flow

```
You submit: "Refactor the auth module and add tests"
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

After an idea finishes executing, the auto-provisioned node enters a **warm** state instead of being destroyed immediately. This dramatically reduces startup time for follow-up work.

### How It Works

1. Execution completes → workspace is stopped
2. If the node has no other active workspaces, it enters the warm pool
3. The `NodeLifecycle` Durable Object schedules a cleanup alarm
4. If new work arrives before the timeout, the warm node is reused (seconds vs. minutes)
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
