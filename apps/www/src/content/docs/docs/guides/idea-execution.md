---
title: Idea Execution
description: How ideas go from description to pull request — execution lifecycle, agent dispatch, and warm node pooling.
---

The main way to use SAM is the **project chat**: you describe what you want done, and SAM handles provisioning, agent execution, and cleanup. This page explains what happens after you hit send.

## Executing from the Chat

Type your description in the project chat input and submit. Submitting a message both **creates** the work and **starts** it in one step — you don't need to pre-create an idea. SAM will:

1. **Generate a title** — short messages are used as-is; longer ones get a concise AI-generated title
2. **Create a branch** — descriptive branch name with `sam/` prefix
3. **Provision a workspace** — reuses a warm environment if available, otherwise provisions a new one
4. **Start the agent** — runs the agent from your selected profile (Claude Code, Codex, Gemini CLI, Mistral Vibe, OpenCode, or Amp) with your description
5. **Stream output** — watch the agent work in real time in the chat

The **Ideas** board holds work you've drafted but not started yet. Once an idea is executing or done, you follow it in the chat session list. You can also start a saved idea from its detail page with the **Execute** button.

### Execution Options

Before you send, you can optionally choose:

| Option                | Description                          | Default                  |
| --------------------- | ------------------------------------ | ------------------------ |
| **Agent profile**     | Which agent, model, and settings run | Project default profile  |
| **Skill**             | A profile-override layer for the run | None                     |
| **Workspace profile** | `full` or `lightweight` environment  | `full`                   |
| **VM size**           | small, medium, or large              | Project default          |
| **Provider**          | Hetzner or Scaleway                  | Project default provider |

## Idea Lifecycle

Ideas progress through these stages as seen in the UI:

| Stage         | What's happening                           |
| ------------- | ------------------------------------------ |
| **Exploring** | You're brainstorming — the idea is a draft |
| **Ready**     | The idea is defined and ready to execute   |
| **Executing** | An agent is actively working on it         |
| **Done**      | The agent finished and created a PR        |
| **Parked**    | The idea was cancelled or execution failed |

### Execution Steps

While an idea is executing, SAM tracks detailed progress:

| Step                 | Description                                     |
| -------------------- | ----------------------------------------------- |
| `node_selection`     | Finding or provisioning compute                 |
| `node_provisioning`  | Waiting for the environment to boot             |
| `node_agent_ready`   | Waiting for the environment to report ready     |
| `workspace_creation` | Cloning your repository and setting up          |
| `workspace_ready`    | Waiting for the environment to finish preparing |
| `agent_session`      | Starting the AI agent session                   |
| `running`            | Agent is actively working                       |

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
- Longer messages are summarized by a Workers AI model (default: `@cf/zai-org/glm-4.7-flash`)
- If AI generation fails or times out, the message is truncated to 100 characters as a fallback
- Generation uses exponential backoff with up to 2 retries

Configure via environment variables:

| Variable                             | Default                     | Description                                |
| ------------------------------------ | --------------------------- | ------------------------------------------ |
| `TASK_TITLE_MODEL`                   | `@cf/zai-org/glm-4.7-flash` | Workers AI model for title generation      |
| `TASK_TITLE_GENERATION_ENABLED`      | `true`                      | Set `false` to always use truncation       |
| `TASK_TITLE_TIMEOUT_MS`              | `5000`                      | Per-attempt timeout                        |
| `TASK_TITLE_SHORT_MESSAGE_THRESHOLD` | `100`                       | Messages at or below this length bypass AI |

## Agent-to-Agent Dispatch

Running agents can spawn follow-up work within the same project using MCP tools. This enables multi-step workflows where one agent delegates sub-work to others.

### How It Works

An agent running inside a workspace has access to MCP tools that provide project awareness:

| Tool                  | Purpose                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `dispatch_task`       | Spawn work using the selected profile runtime or an explicit runtime override |
| `create_idea`         | Create a new idea                                                             |
| `update_idea`         | Update an idea's title, content, priority, or status                          |
| `list_ideas`          | View existing ideas                                                           |
| `get_idea`            | Read idea details                                                             |
| `search_ideas`        | Search ideas by keyword                                                       |
| `update_task_status`  | Report progress                                                               |
| `complete_task`       | Mark the current work as done, optionally with structured completion evidence |
| `request_human_input` | Ask the user for a decision                                                   |

`dispatch_task` accepts an optional `runtime` value of `vm` or `cf-container`. Container dispatch starts an Instant task without VM sizing or cloud credentials. Explicit VM-only options such as `vmSize`, `provider`, `vmLocation`, `workspaceProfile`, and `devcontainerConfigName` cannot be combined with a container runtime; choose `runtime: "vm"` or remove those options.

### Dispatch Limits

To prevent runaway recursion, dispatch has configurable limits:

| Limit                             | Default | Env Variable                          |
| --------------------------------- | ------- | ------------------------------------- |
| Max recursion depth               | 3       | `MCP_DISPATCH_MAX_DEPTH`              |
| Max dispatched per parent         | 5       | `MCP_DISPATCH_MAX_PER_TASK`           |
| Max active dispatched per project | 10      | `MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT` |

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

## Warm Reuse for Fast Follow-Ups

After work finishes, SAM keeps the auto-provisioned environment **warm** for a while instead of tearing it down immediately. If you start follow-up work during that window, SAM reuses the warm environment — so a second task starts in seconds instead of minutes. Idle environments are cleaned up automatically afterward, and there's an absolute lifetime cap so nothing runs indefinitely.

Self-hosters can tune the warm window and lifetime cap (`NODE_WARM_TIMEOUT_MS`, `MAX_AUTO_NODE_LIFETIME_MS`) — see the [Configuration Reference](/docs/reference/configuration/).
