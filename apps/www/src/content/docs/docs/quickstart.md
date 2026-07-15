---
title: Quickstart
description: Start chatting with an AI coding agent on your repo in minutes.
---

This guide covers two paths: **using a hosted instance** (if someone has already deployed SAM) or **self-hosting** your own.

## Using a Hosted Instance

SAM is chat-first: you import a repository, describe what you want in a chat, and SAM runs an AI coding agent that reads your code, makes changes, and opens a pull request. It provisions the environment for you — you don't manage servers.

### 1. Sign In

Open the web UI and click **Sign in with GitHub**. Authorize the GitHub App when prompted.

### 2. Connect an AI Agent

Go to **Settings → Connections** and connect the AI coding agent you want to use — Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, OpenCode, or Amp. Depending on the agent, you'll paste an API key or an OAuth token from your subscription. Your credentials stay encrypted in the database — they're never stored as environment variables.

:::note
On a hosted instance, cloud compute is usually provided for you, so you don't need your own cloud provider credential. If you're self-hosting or the operator requires it, add a [Hetzner API token](https://console.hetzner.cloud/) or [Scaleway secret key](https://console.scaleway.com/iam/api-keys) under **Settings → Cloud Provider**.
:::

### 3. Install the GitHub App

Go to **Settings → GitHub** and click **Install GitHub App** on the repositories you want to use with SAM. This grants SAM access to those repositories.

### 4. Import a Project

From the **Dashboard**, click **Import Project** and pick a repository that has the GitHub App installed. A project links that repo to its chats, agents, and activity.

### 5. Chat

Open your project and type what you want done in the chat — for example, "add input validation to the signup form and write tests." SAM automatically provisions a workspace, runs your chosen agent, streams its progress back to you in real time, and opens a pull request when it's done.

That's the whole loop: **import → chat → review the PR.** No terminal or server setup required.

## Self-Hosting

To deploy your own SAM instance:

### Prerequisites

- A domain with DNS managed by Cloudflare
- A Cloudflare account with **Workers Paid plan** ($5/month, required for Durable Objects)
- A GitHub account

### Quick Deploy

1. **Fork** the [SAM repository](https://github.com/raphaeltm/simple-agent-manager)
2. **Create a GitHub Environment** named `production` in your fork's Settings
3. **Add the required secrets** — see the [Self-Hosting Guide](/docs/guides/self-hosting/) for the full list
4. **Run Deploy Production** — in your fork, go to Actions → Deploy Production → Run workflow and choose `main`

The deployment workflow:

- Provisions Cloudflare infrastructure (D1, KV, R2, DNS)
- Deploys the API Worker and Web UI
- Builds and uploads VM Agent binaries
- Runs database migrations
- Verifies with a health check

For future updates, sync upstream changes into your fork's `main` branch, then run **Deploy Production** again. Pushing to `main` alone does not update a self-hosted instance.

For detailed step-by-step instructions, see the [Self-Hosting Guide](/docs/guides/self-hosting/).

## Next Steps

- [AI Agents](/docs/guides/agents/) — choose and configure your coding agent
- [Idea Execution](/docs/guides/idea-execution/) — how chatting turns into finished pull requests
- [Core Concepts](/docs/concepts/) — the vocabulary behind projects, agents, and workspaces
