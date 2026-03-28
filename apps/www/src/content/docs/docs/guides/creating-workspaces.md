---
title: Creating Workspaces
description: How to create, use, and manage workspaces in SAM.
---

Workspaces are ephemeral AI coding environments — a VM, a devcontainer, and your repo, accessible through a browser terminal.

## Before You Start

You need:
1. A SAM account (sign in with GitHub)
2. A **Hetzner API token** added in Settings
3. The **GitHub App installed** on at least one repository

## Creating a Workspace

### From the Dashboard

1. Navigate to the **Dashboard**
2. Click **New Workspace** (or use the project's workspace creation)
3. Select:
   - **Repository** — from repos with the GitHub App installed
   - **VM Size** — Small, Medium, or Large
   - **Branch** (optional) — defaults to the repo's default branch
4. Click **Create**

### What Happens Next

1. SAM selects an existing healthy node or provisions a new Hetzner VM
2. The VM runs cloud-init: installs Docker, downloads the VM Agent, starts the agent service
3. The VM Agent creates a Docker container with your repo's devcontainer configuration
4. Your repository is cloned into the container
5. The workspace becomes accessible at `ws-{id}.yourdomain.com`

Provisioning takes **2-5 minutes** for new nodes, or **seconds** if reusing a warm node.

## Using a Workspace

### Terminal

Click a running workspace to open the browser-based terminal. This is a full PTY session via xterm.js and WebSocket — it behaves like a real terminal.

Features:
- **Session persistence** — terminal sessions survive page refreshes
- **Multiple tabs** — shell terminals and agent chat sessions
- **Copy/paste** — standard keyboard shortcuts work
- **Resize** — terminal auto-resizes with the browser window

### Agent Chat

Click **+ New Chat** to start a Claude Code session. Type a prompt and Claude will:
- Read and modify code in your repository
- Run commands in the terminal
- Stream responses in real-time

Each chat session runs in its own tab alongside shell terminals.

## Managing Workspaces

### Stopping

Click **Stop** on a running workspace. This:
- Powers off the VM (if no other workspaces are using it)
- Preserves the workspace record for restart

Stopped workspaces don't incur Hetzner charges.

### Restarting

Click **Restart** on a stopped workspace. SAM provisions a new VM and recreates the container. Your repository is re-cloned from GitHub.

:::caution
Restarting creates a fresh container. Any uncommitted changes from the previous session are lost. Always push your work before stopping.
:::

### Deleting

Click **Delete** to permanently remove a workspace. This cleans up:
- The Docker container
- DNS records
- The VM (if no other workspaces are using it)

## Workspaces from Ideas

Workspaces are also created automatically when you execute an idea:

1. Go to a project's chat view
2. Describe what you want done
3. SAM automatically provisions a workspace, runs your configured agent, and creates a PR

After execution completes, the node enters a **warm pool** for 30 minutes, enabling fast reuse for follow-up work.

## VM Sizes

| Size | Specs | Best For | Hourly Cost |
|------|-------|----------|-------------|
| **Small** | 2 vCPU, 4GB RAM | Simple changes, code review | ~$0.007 |
| **Medium** | 4 vCPU, 8GB RAM | Most development work | ~$0.012 |
| **Large** | 8 vCPU, 16GB RAM | Large builds, heavy compilation | ~$0.030 |

:::tip
Start with Medium for most use cases. You can set a default VM size per project in the project settings.
:::
