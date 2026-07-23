---
title: Workspaces
description: How workspaces are provisioned, used, and managed in SAM.
---

A **workspace** is the environment an AI coding agent runs in — your repository, cloned and ready, with the tools the agent needs. In everyday use you rarely create one by hand: SAM provisions a workspace for you automatically when you start working in a project chat. This guide explains that automatic flow and the direct controls available for power users.

## The Normal Flow: Workspaces Come From Chat

You don't start with a workspace — you start with a conversation:

1. From the **Dashboard**, click **Import Project** and connect a GitHub repository.
2. Open the project and describe what you want in the **chat**.
3. SAM automatically provisions a workspace, runs your chosen agent, and streams progress back to you. When the agent finishes, it opens a pull request.

Provisioning takes a couple of minutes the first time, or seconds when SAM reuses a recently active ("warm") environment. You never have to pick a server or wait at a terminal — the workspace exists to serve the chat.

See [Idea Execution](/docs/guides/idea-execution/) for the full chat-to-pull-request workflow.

### Choosing an environment size and profile

When you start a chat you can optionally choose:

- **Agent profile** — which agent, model, and settings to run (see [AI Agents](/docs/guides/agents/)).
- **Workspace profile** — a **Full** environment that builds your project's `.devcontainer` (best when the agent needs to run your stack), or a **Lightweight** environment that starts faster (best for quick questions and code exploration).
- **VM size** — more CPU and memory for heavy builds. You can set a default size per project in project settings.

## Using a Workspace Directly

Most work happens through chat, but every workspace also has a direct view for hands-on control. You'll find running workspaces under **Nodes / Workspaces** in the navigation.

### Terminal

Open a workspace to get a browser-based terminal — a full interactive shell that behaves like a real terminal.

- **Session persistence** — terminal sessions survive page refreshes
- **Multiple tabs** — run several shells alongside agent chats
- **Copy/paste and resize** — standard shortcuts work; the terminal fits the window

### Agent chat in a workspace

Click **+ New Chat** to start an AI coding session directly in the workspace. If you've connected more than one agent, you can choose which one to use. Each chat runs in its own tab alongside your shells.

## Managing Workspaces

### Stopping

**Stop** a workspace to power down its environment while keeping the record so you can restart later. Stopped workspaces don't incur compute charges.

### Restarting

**Restart** provisions a fresh environment and re-clones your repository.

:::caution
Restarting starts from a clean checkout. Any uncommitted changes from the previous session are lost — always push your work before stopping.
:::

### Deleting

**Delete** permanently removes a workspace and cleans up everything associated with it.

## VM Sizes

SAM offers small, medium, and large sizes, trading cost for CPU and memory:

| Size | Best for |
|------|----------|
| **Small** | Simple changes, code review, quick questions |
| **Medium** | Most development work |
| **Large** | Large builds and heavy compilation |

Exact specs and pricing are shown in the size picker when you create a workspace and vary by cloud provider. Start with **Medium** for most work, and set a per-project default in project settings.

:::note
Creating a workspace directly (rather than through chat) is an advanced path intended for hands-on infrastructure control. It requires a project to already be imported, and — on a self-hosted instance — a Hetzner, Scaleway, or Vultr credential. On the hosted platform, compute is typically provided for you.
:::
