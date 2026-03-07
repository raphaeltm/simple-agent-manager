---
title: Quickstart
description: Get SAM deployed and create your first workspace.
---

This guide covers two paths: **using a hosted instance** (if someone has already deployed SAM) or **self-hosting** your own.

## Using a Hosted Instance

If SAM is already deployed (e.g., at `app.example.com`):

### 1. Sign In

Open the web UI and click **Sign in with GitHub**. Authorize the GitHub App when prompted.

### 2. Add Your Hetzner Token

Go to **Settings** and add your [Hetzner API token](https://console.hetzner.cloud/). This token stays encrypted in the database — it's never stored as an environment variable.

### 3. Install the GitHub App

In **Settings**, click **Install GitHub App** on the repositories you want to use with SAM. This grants SAM read/write access to repository contents.

### 4. Create a Workspace

From the **Dashboard**, click **New Workspace** and select:
- **Repository** — from your installed GitHub App repos
- **VM Size** — Small (2 vCPU, 4GB), Medium (4 vCPU, 8GB), or Large (8 vCPU, 16GB)

Click **Create Workspace**. Provisioning takes 2-5 minutes.

### 5. Use It

Once running, click the workspace to open a browser-based terminal. The devcontainer includes git, Docker, and your repo cloned and ready.

To start Claude Code:
```bash
claude login    # Authenticate with your Claude subscription
claude          # Start coding
```

## Self-Hosting

To deploy your own SAM instance:

### Prerequisites

- A domain with DNS managed by Cloudflare
- A Cloudflare account (free tier works)
- A GitHub account

### Quick Deploy

1. **Fork** the [SAM repository](https://github.com/raphaeltm/simple-agent-manager)
2. **Create a GitHub Environment** named `production` in your fork's Settings
3. **Add the required secrets** — see the [Self-Hosting Guide](/docs/guides/self-hosting/) for the full list
4. **Push to main** — deployment is automatic via GitHub Actions + Pulumi

The deployment workflow:
- Provisions Cloudflare infrastructure (D1, KV, R2, DNS)
- Deploys the API Worker and Web UI
- Builds and uploads VM Agent binaries
- Runs database migrations
- Verifies with a health check

For detailed step-by-step instructions, see the [Self-Hosting Guide](/docs/guides/self-hosting/).

## Next Steps

- [Core Concepts](/docs/concepts/) — understand workspaces, nodes, and providers
- [Architecture Overview](/docs/architecture/overview/) — how the system fits together
- [Configuration Reference](/docs/reference/configuration/) — all environment variables and settings
