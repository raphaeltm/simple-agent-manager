---
title: Roadmap
description: Planned SAM development phases and feature areas.
---

## Complete: MVP

Core workspace management with GitHub OAuth:

- Create workspaces from git repositories.
- Authenticate with GitHub OAuth.
- Use a GitHub App for private repository access.
- View workspace status.
- Stop and restart workspaces manually.
- Shut down idle workspaces automatically.
- Manage workspaces through the web UI.
- Persist data in Cloudflare D1.
- Store user cloud credentials encrypted.

## Complete: Browser Terminal

Browser-based terminal access to running workspaces:

- Go VM agent with WebSocket terminal support.
- JWT-based terminal authentication.
- Idle detection and heartbeat system.
- xterm.js terminal UI.
- Secure bootstrap token credential delivery.
- Workspace ownership validation.
- WebSocket reconnection handling.
- Pulumi and GitHub Actions deployment.
- Multi-agent ACP protocol support.
- UI component governance system.

Planned follow-up work:

- Workspace logs and debugging.
- Better error UX for build failures.

## Planned: Enhanced UX

Reliability and product experience improvements:

- Deeper file and terminal workflow polish.
- Retry support for failed workspace builds.
- Custom devcontainer support.
- Multiple repository sources.
- Workspace templates.
- SSH access to workspaces.
- Persistent storage.
- Cost estimation display.
- Configurable subdomains.
- VM-side TLS through Caddy for direct workspace access.

## Planned: Multi-Tenancy

Support for teams and organizations:

- Team management.
- Per-user API tokens.
- Usage quotas and limits.
- Billing integration.
- Audit logging.

## Planned: Enterprise Features

Features for larger deployments:

- Private networking.
- Custom domain support.
- SSO integration.
- Compliance features.
- Multi-region support.
- Custom VM images.
- API rate limiting.

## Security Improvements

Future security hardening:

- VM callback token exchange flow.
- Token rotation for long-lived workspaces.
- Workspace audit logging.
- Least-privilege Cloudflare credentials split between deployment and runtime.

## Future Considerations

- Additional cloud providers.
- VS Code Remote integration.
- Collaborative editing.
- Workspace snapshots and restore.
- GPU instances for AI workloads.
- Kubernetes-based workspaces.
