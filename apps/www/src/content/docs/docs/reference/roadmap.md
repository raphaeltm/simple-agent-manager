---
title: Roadmap
description: SAM development phases — what's shipped and what's next.
---

## Complete: Core Platform

Workspace management with GitHub OAuth:

- Create workspaces from git repositories.
- Authenticate with GitHub OAuth.
- Use a GitHub App for private repository access.
- View workspace status.
- Stop and restart workspaces manually.
- Manage workspaces through the web UI.
- Persist data in Cloudflare D1.
- Store user cloud credentials encrypted.

## Complete: Browser Terminal & Agent Chat

Browser-based terminal and structured agent interaction:

- Go VM agent with WebSocket terminal support.
- JWT-based terminal authentication.
- Idle detection and heartbeat system.
- xterm.js terminal UI.
- Secure bootstrap token credential delivery.
- Workspace ownership validation.
- Multi-agent ACP protocol support.

## Complete: Multi-Agent Support

Run your choice of coding agent:

- Claude Code, Codex, Gemini CLI, Mistral Vibe, OpenCode, Amp.
- Per-agent API key and OAuth credential management.
- Agent profiles with custom configuration per project.

## Complete: Multi-Workspace Nodes

Multiple isolated workspaces per VM:

- Multiple devcontainer workspaces share a single node.
- Per-workspace isolation and lifecycle control.

## Complete: Project-First Architecture

Projects as the primary organizational unit:

- Projects linked to GitHub repos.
- Persistent project chat with structured agent output.
- Activity feeds and task-driven workflows.
- Project-scoped settings, credentials, and agent configuration.

## Complete: Multi-Cloud & Enhanced UX

Multiple cloud providers and UX improvements:

- Scaleway, GCP, Vultr, Infomaniak, DigitalOcean, and UpCloud cloud provider support (in addition to Hetzner).
- In-app notifications with filtering.
- Voice input and text-to-speech playback.
- Conversation forking.
- Warm node pooling for fast workspace reuse.
- Provider-native [compute pools](/docs/guides/compute-pools/) with per-pool placement strategy and exhaustion policy.
- Custom devcontainer support.
- File browsing, upload, and download.
- Usage visibility for compute and SAM-managed AI.

## Complete: Task Orchestration

Multi-agent coordination:

- Agents that start, message, and stop other agents, which can message back.
- Task dependencies and durable messaging.
- Structured idea capture with execution dispatch.
- Recurring triggers (daily/weekly schedules).
- A project knowledge base that agents can read and add to.

## Complete: CLI

Command-line interface for SAM:

- Auth, task submission, chat prompts, task status, and runner doctor commands.

## Complete: App Deployments

Agent-first deployment environments:

- Deployment environments with user-managed agent deployment policy gates.
- Docker Compose release submission with SAM extensions and server-side image publishing.
- Deployment logs, status, environment config, secrets, and safe named volume management.

## Complete: Comments

Threads that become agent context:

- Comments on chat messages and project library files, by any project member.
- @mentions that notify teammates.
- Comment inboxes for project-wide and session-scoped follow-up.
- **Send to agent**, which turns a comment into a message for the chat's agent.
- Agent replies and resolution through MCP tools.

## Complete: Event Streams & Triggers

Visible project automation:

- Cron, GitHub, and authenticated webhook triggers.
- One-off schedules and standing watches.
- Agent event subscriptions and project activity streams.

## Planned: More Providers

- AWS and expanded provider coverage.

## Complete: Teams & Collaboration

Shared project collaboration:

- Project members with owner and admin roles.
- Maintainer and viewer role enforcement foundation.
- Invite links and access requests.
- Member removal and ownership transfer flows with credential impact handling.
- Sharing a chat with a teammate for a set time, so they can drive it on the owner's accounts.

## Planned: Billing Integration

- Billing integration.

## Planned: Role Assignment for Project Members

- User-facing controls for assigning maintainer and viewer roles.

## Future Considerations

- VS Code Remote integration.
- Collaborative editing.
- Longer-lived workspace snapshots and restore controls.
- GPU instances for AI workloads.
- Kubernetes-based workspaces.
