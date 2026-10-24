---
title: Idea Execution
description: How ideas go from description to pull request — execution lifecycle, agent dispatch, and warm node pooling.
---

The main way to use SAM is the **project chat**: you describe what you want done, and SAM handles provisioning, agent execution, and cleanup. This page explains what happens after you hit send.

## Executing from the Chat

Type your description in the project chat input and submit. Submitting a message both **creates** the work and **starts** it in one step — you don't need to pre-create an idea. SAM will:

1. **Generate a title** — short messages are used as-is; longer ones get a concise AI-generated title (an Instant chat that gets no branch keeps the start of your message as its title)
2. **Create an output branch** — a descriptive `sam/`-prefixed name off your default branch (except for an Instant chat that [gets no branch](/docs/guides/instant-sessions/#what-happens-to-your-work))
3. **Provision a workspace** — already checked out on that branch; reuses a warm VM if available (an Instant chat that gets no branch starts a new container on your default branch instead)
4. **Start the agent** — runs the agent from your selected profile (Claude Code, Codex, Gemini CLI, Mistral Vibe, OpenCode, or Amp) with your description
5. **Stream output** — watch the agent work in real time in the chat

The **Ideas** list holds work you want done but have not started yet, and keeps following it after you do — see [Ideas](#ideas) below for how an idea's state is worked out. You can also start a saved idea from its detail page — see [Starting work on an idea](#starting-work-on-an-idea).

## Starting work on an idea

An open idea's detail page has a **Start work** button. It opens a sheet where you choose:

- **Who works on it** — the same profile picker the chat composer uses. The badge beside the profile says what SAM will do with it: **Does the work** (SAM runs it as a task) or **Talks it through** (SAM runs it as a conversation).
- **Skill** — optional, from your project's skills.
- **Note for the agent** — optional. Your note is the only message sent. If you leave it blank SAM sends one short neutral line.
- **What the agent starts with** — the idea itself, plus the chats, files and pull requests already linked to the idea, which the agent can look up with its SAM tools.

One sentence above the buttons says exactly what will happen. Picking a conversation profile changes the sheet to **Talk it through** and the button to **Start chat**: the chat is recorded on the idea as a discussion rather than as work on it. SAM never swaps the runtime your profile asks for.

Before the agent receives its first prompt, SAM links the new chat to the idea — `works_on` for task work, `discusses` for a conversation. If that link cannot be written the start fails and nothing is left queued. Done and parked ideas are rejected; reopen the idea first.

The agent is given the idea itself through `get_instructions`, inside an explicit untrusted-data envelope, and is pointed at the `get_idea` and `get_related` tools for the rest. SAM does not put ids, tool names, slash commands or any workflow that only exists in one repository into the message you send. How the agent works is decided by the profile and skill you chose and by your repository's own instructions.

### Keep the plan current with Updates

An idea's text is its current plan. Post progress, findings, and decisions as updates through the API or agent tools so earlier notes do not obscure the plan. Agents can post an update with `update_idea` using `note` and an optional `quote`, then read updates with `list_idea_updates`. Post a note separately from editing the plan; a note by itself leaves the idea text unchanged. Updates carry the author's name and, for agent notes, the source chat. The author or a project owner or admin can remove an update.

### Execution Options

Before you send, you can optionally choose:

| Option                    | Description                                                         | Default                  |
| ------------------------- | ------------------------------------------------------------------- | ------------------------ |
| **Agent profile**         | Which agent, model, and settings run                                | Project default profile  |
| **Skill**                 | A profile-override layer for the run                                | None                     |
| **Workspace profile**     | `full` or `lightweight` environment                                 | `full`                   |
| **Workload requirements** | Minimum vCPU, memory, disk, and optional exclusive node             | Inherited defaults       |
| **Provider**              | Hetzner, Scaleway, Vultr, Infomaniak, DigitalOcean, UpCloud, or GCP | Project default provider |

For VM runs, blank resource fields inherit defaults from the selected skill,
agent profile, project, and platform. The effective
[compute pool](/docs/guides/compute-pools/) selects an eligible provider-native
offering for those requirements. Node details show the
actual provider type and hardware separately from the workload's reservation.

Older profiles and API or CLI requests using `small`, `medium`, or `large` remain
compatible: SAM translates those presets into workload requirements. Explicit
modern fields take precedence at the same configuration layer. See
[Creating Workspaces](/docs/guides/creating-workspaces/) for resource controls and
[Upgrading existing compute pools](/docs/reference/configuration/#upgrading-existing-compute-pools)
for migration and rollback behavior.

## Ideas

An idea is something you want done that nobody has handed to an agent yet. It collects
context — chats, files, notes, pull requests — until someone starts work on it, and then it
follows that work.

### Where an idea stands is worked out, not typed

Nobody sets an idea's state by hand. SAM derives it from the chats linked to the idea, those
chats' tasks and their pull requests, and shows where each state came from ("From GitHub, a
minute ago") so you can tell whether to trust it:

| State               | What it means                                                            |
| ------------------- | ------------------------------------------------------------------------ |
| **Not started**     | Nothing is linked yet, or nothing is in flight                           |
| **In progress**     | A linked chat is working on it (a sleeping chat still counts — it wakes) |
| **In review**       | A pull request for the work is open                                      |
| **Merged**          | A pull request merged, and nobody has said whether that finished it      |
| **Stopped**         | The latest work failed and nothing else is running                       |
| **Waiting for you** | An agent asked you something and nobody has answered                     |
| **Done**            | You marked it done                                                       |
| **Parked**          | You parked it                                                            |

Higher rows win: an unanswered question outranks running work, running work outranks an open
pull request. Only chats that actually work on the idea move it; a chat that merely read or
mentioned it never does.

**Done and Parked stay your decision.** A merged pull request does not always finish an idea —
the docs page may still be missing — so SAM asks once, with **Mark done** and **Keep open**,
and does not ask again about that merge.

### What needs you comes first

The Ideas list opens on **Needs you**: the ideas with a question, a stopped run, or a merged
pull request waiting on your call, each with its fix as a button (**Answer**, **Try again…**,
**Mark done**). At most three are shown before the rest fold away, so a bad day cannot push the
whole list off a phone screen. Below that come **In progress** and **Not started**; ideas you
have finished and ideas an automation filed fold away at the bottom.

## While the work runs

### Linked work

SAM connects an idea to the chats that created, edited, read, or worked on it. When an agent uploads, replaces, downloads, or displays a library file in a chat, SAM records that relationship too. An idea can show files and pull requests linked directly to it and those produced by chats doing substantial work on it. A chat that only read an idea does not bring its files or pull requests into that idea.

Agents can use `link_to_idea` for a file, pull request, or related idea created outside those automatic paths, and `unlink_from_idea` to remove an explicit link. The idea's Conversations list still shows its connected chats. Linked lists are capped; the API reports their totals and whether results were truncated. A pull request total may be shown as a lower bound when the associated chat list is too large to scan in one bounded read.

Agent tools expose this context in one call. `get_idea` returns the idea's plan, related chats, files, pull requests with recorded state and checks, related ideas, and recent updates. By default, the complete maximum-length idea plan fits in one call when it uses ASCII text. If a longer encoded plan is paged, its content ends with a continuation notice naming `get_idea` and the next `contentOffset`; `contentTruncated` and `nextContentOffset` carry the same signal as fields. `get_linked_context` returns related work for an idea, chat or library file; in a workspace, calling it without an ID uses the current chat. These responses cap each list and disclose totals and truncation. Text written by people, agents or GitHub is enclosed as untrusted data, so a quoted instruction in a note or pull request title does not change the agent's instructions.

### Execution Steps

While a task is running, SAM tracks detailed progress:

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

1. The agent commits and pushes changes to the task's output branch
2. A pull request is created automatically
3. A notification is sent
4. The workspace is stopped
5. If the node was auto-provisioned and has no other active workspaces, it enters the **warm pool** for potential reuse

## Where the work lands

Every **submitted task** gets its own **output branch** — a prefixed name derived from your description, `sam/` by default (self-hosters can change the prefix with `BRANCH_NAME_PREFIX`). This covers work you submit as a task and work an agent creates with `dispatch_task`, on either runtime. A message-box chat on an [Instant](/docs/guides/instant-sessions/) profile, without attachments or explicit resource overrides and not started from an idea, is the exception: it gets no branch at all — see [What happens to your work](/docs/guides/instant-sessions/#what-happens-to-your-work). Having a branch does not mean SAM publishes to it: commits, pushes and pull requests are agent-directed on both runtimes. The workspace is now checked out on that branch from the moment it's created: SAM clones your project's default branch as the base, then creates and checks out the output branch before the agent starts. Run `git branch --show-current` inside a task workspace and you'll see the task branch, not `main`.

The output branch provides a place for the agent to commit and publish when instructed. SAM does not publish whatever the agent leaves behind.

When a task reports a pull request in the project's GitHub repository, SAM keeps its number, open or closed state, merge status, and latest reported checks with the task. GitHub events update that record as the pull request changes. A pull request in another repository is not added to the project's tracked work.

If you pass an explicit `branch` when starting work (via the API or `dispatch_task`), that branch is used instead — the meaning is "continue the work already on this branch."

### Publication and sleep recovery

SAM does not stage files, commit, push, or open pull requests when an agent turn ends or a task completes. Ask the agent to publish the intended files and report the commit or pull request explicitly. Shell git commands and completion evidence remain available.

Sleep snapshots independently preserve the supported workspace's dirty files, staged content and local commits, including local workflow state. Snapshot capture uses a temporary index and internal WIP bundle; it does not publish changes or alter the working branch. Files outside snapshot-supported paths, such as arbitrary sibling worktrees, are not covered by this guarantee.

Protect your default branch with repository branch protection rules: agent-directed shell pushes follow your repository permissions.

## AI Title Generation

SAM automatically generates concise titles for ideas using Workers AI:

- Messages **at or below 100 characters** are used as the title directly (no AI needed)
- Longer messages are summarized by a Workers AI model (default: `@cf/google/gemma-4-26b-a4b-it`)
- If AI generation fails or times out, the message is truncated to 100 characters as a fallback
- An Instant chat that [gets no branch](/docs/guides/instant-sessions/#what-happens-to-your-work) skips AI generation; its title is your message, truncated to 100 characters
- Generation uses exponential backoff with up to 2 retries

Configure via environment variables:

| Variable                             | Default                         | Description                                |
| ------------------------------------ | ------------------------------- | ------------------------------------------ |
| `TASK_TITLE_MODEL`                   | `@cf/google/gemma-4-26b-a4b-it` | Workers AI model for title generation      |
| `TASK_TITLE_GENERATION_ENABLED`      | `true`                          | Set `false` to always use truncation       |
| `TASK_TITLE_TIMEOUT_MS`              | `5000`                          | Per-attempt timeout                        |
| `TASK_TITLE_SHORT_MESSAGE_THRESHOLD` | `100`                           | Messages at or below this length bypass AI |

## Agent-to-Agent Dispatch

Running agents can spawn follow-up work within the same project using MCP tools. This enables multi-step workflows where one agent delegates sub-work to others.

### How It Works

An agent running inside a workspace has access to MCP tools that provide project awareness:

| Tool                  | Purpose                                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch_task`       | Spawn work using the selected profile runtime or an explicit runtime override                                                                                                                                              |
| `create_idea`         | Create a new idea                                                                                                                                                                                                          |
| `update_idea`         | Change the current plan, title, priority, or status; use `note` for progress, findings, and decisions without changing the plan. An optional `quote` points to a passage. Existing `content` append behavior is unchanged. |
| `list_idea_updates`   | Read the idea's updates newest first, using `nextCursor` for older notes.                                                                                                                                                  |
| `list_ideas`          | View existing ideas                                                                                                                                                                                                        |
| `get_idea`            | Read idea details                                                                                                                                                                                                          |
| `get_linked_context`  | Read bounded related chats, ideas, files, pull requests and recent updates for an idea, chat or library file; defaults to the current chat in a workspace.                                                                 |
| `search_ideas`        | Search ideas by keyword                                                                                                                                                                                                    |
| `update_task_status`  | Report progress                                                                                                                                                                                                            |
| `complete_task`       | Mark the current work as done; pass the pull request URL as `evidence.prUrl` so it is saved on the task, alongside any structured verification evidence                                                                    |
| `request_human_input` | Ask the user for a decision                                                                                                                                                                                                |

`dispatch_task` accepts an optional `runtime` value of `vm` or `cf-container`. Container dispatch starts an [Instant](/docs/guides/instant-sessions/) task without VM sizing or cloud credentials — but only when asked: dispatch defaults to a VM unless `cf-container` is set explicitly or comes from the dispatching profile. Explicit VM-only options such as `vmSize`, `provider`, `vmLocation`, `workspaceProfile`, and `devcontainerConfigName` cannot be combined with a container runtime; choose `runtime: "vm"` or remove those options.

For VM dispatch, pass workload overrides in `resourceRequirements`, using
`minVcpu`, `minMemoryGb`, `minDiskGb`, and `exclusiveNode`. Omitted fields inherit
through the same resource-resolution path as other VM runs. The deprecated
`vmSize` field remains accepted for older clients.

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
