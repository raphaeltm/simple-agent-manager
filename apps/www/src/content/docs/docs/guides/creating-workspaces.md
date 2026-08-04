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

## Two kinds of workspace: Instant and VM

A workspace runs either as an **Instant** container on Cloudflare's network or as a **VM** on a cloud provider. Which one you get is an [agent profile](/docs/guides/agents/#agent-profiles) setting:

- **A profile whose runtime is "Instant container"** → Instant. Starts in seconds and needs no cloud account, but has no `.devcontainer` build, no Docker, and no automatic port exposure.
- **Anything else** → a task on a VM, with your full environment.

Submitted tasks always use a VM, so a project that mainly runs tasks needs cloud compute regardless.

Everything below — providers, VM sizes, the terminal, stop/restart/delete — describes the **VM** path. If your sessions are starting in seconds and the agent can't run your build tooling, you're on Instant; see [Instant Sessions](/docs/guides/instant-sessions/) for its behavior, limits, and how to pin a runtime explicitly.

## Where your workspaces run: Bring Your Own Cloud

VM workspaces run on a real cloud VM. On the **hosted platform**, compute is usually provided for you, so you can start working without connecting anything. On a **self-hosted instance**, or when you want VMs billed directly to your own account, SAM follows a **Bring Your Own Cloud (BYOC)** model: you connect a cloud provider once, and every VM runs on your account.

SAM supports seven providers:

| Provider                    | Known for                          | What you connect                                                      |
| --------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| **Hetzner**                 | European cloud, great value        | An API token with Read & Write access                                 |
| **Scaleway**                | European cloud, GPU options        | An API secret key and project ID                                      |
| **Vultr**                   | Global cloud, hourly billing       | A Personal Access Token with IP access set to **Allow All IPv4/IPv6** |
| **Infomaniak Public Cloud** | Swiss OpenStack cloud              | An application credential ID and secret                               |
| **DigitalOcean**            | Global cloud, simple droplets      | A Full Access Personal Access Token                                   |
| **UpCloud**                 | European cloud with global regions | A dedicated API subaccount username and password                      |
| **Google Cloud**            | Google Cloud Platform              | Workload Identity Federation, or a service-account JSON key           |

### Connecting a provider

1. Open **Settings → Connections** and start connecting a cloud provider. (The **Cloud Provider** tab lets you fill in each provider's form directly instead.)
2. Pick a provider — each card shows a one-line description to help you choose.
3. Use the linked provider console to create the credential, paste it into the form, and save. SAM encrypts the credential at rest and validates it before the first VM is created.

![The cloud provider picker in SAM's Connections settings: a selectable card for each supported provider — Hetzner, Scaleway, Google Cloud, Vultr, Infomaniak Public Cloud, DigitalOcean, and UpCloud — each with a short description, above the credential form for the selected provider.](/images/docs/cloud-provider-connect.png)

Once a provider is connected, SAM uses it automatically when it provisions workspaces. You can connect more than one and set a default provider (and region) per project in project settings. For per-provider VM sizes, regions, and example pricing, see the [Self-Hosting guide](/docs/guides/self-hosting/#user-vm-costs).

:::note
Cloud provider credentials are stored encrypted per user — never as environment variables or shared secrets. In a [shared project](/docs/guides/collaboration/), a member can attach a project-level cloud credential so shared work doesn't run on someone's personal account.
:::

### Choosing an environment size and profile

When you start a chat you can optionally choose:

- **Agent profile** — which agent, model, and settings to run (see [AI Agents](/docs/guides/agents/)).
- **Workspace profile** — a **Full** environment that builds your project's `.devcontainer` (best when the agent needs to run your stack), or a **Lightweight** environment that starts faster (best for quick questions and code exploration). Workspace profile and runtime are separate choices: **Full has no effect on an [Instant session](/docs/guides/instant-sessions/)**, which never builds a devcontainer. To get your devcontainer you need a VM workspace.
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

| Size       | Best for                                     |
| ---------- | -------------------------------------------- |
| **Small**  | Simple changes, code review, quick questions |
| **Medium** | Most development work                        |
| **Large**  | Large builds and heavy compilation           |

Exact specs and pricing are shown in the size picker when you create a workspace and vary by cloud provider. Start with **Medium** for most work, and set a per-project default in project settings.

:::note
Creating a workspace directly (rather than through chat) is an advanced path intended for hands-on infrastructure control. It requires a project to already be imported, and — on a self-hosted instance — a connected [cloud provider](#where-your-workspaces-run-bring-your-own-cloud). On the hosted platform, compute is typically provided for you.
:::
