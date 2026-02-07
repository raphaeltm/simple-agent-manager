# Roadmap

This document outlines the planned development phases for Simple Agent Manager (SAM).

## Complete: MVP (Phase 1)

**Status**: Complete

Core functionality for workspace management with GitHub OAuth:

- [x] Create workspace from git repository
- [x] GitHub OAuth authentication (BetterAuth)
- [x] GitHub App for private repository access
- [x] View workspace list with status
- [x] Manually stop/restart workspaces
- [x] Automatic idle shutdown (30 min)
- [x] Web UI for workspace management
- [x] D1 database for persistence
- [x] Encrypted credential storage (user Hetzner tokens)

## Complete: Browser Terminal (Phase 2)

**Status**: Complete (core features)

Web-based terminal access to running workspaces:

- [x] VM Agent (Go) with WebSocket terminal
- [x] JWT-based terminal authentication
- [x] Idle detection and heartbeat system
- [x] xterm.js terminal UI
- [x] Secure bootstrap token credential delivery
- [x] Workspace ownership validation
- [x] WebSocket reconnection handling
- [x] Automated deployment via Pulumi + GitHub Actions (spec 005)
- [x] Multi-Agent ACP protocol support (spec 007)
- [x] UI component governance system (spec 009)
- [ ] File explorer integration
- [ ] Terminal session persistence

## Planned: Enhanced UX (Phase 3)

**Target**: Q1 2026

Improvements to user experience and reliability:

- [ ] Workspace logs and debugging
- [ ] Custom devcontainer support
- [ ] Multiple repository sources (GitLab, Bitbucket)
- [ ] Workspace templates
- [ ] SSH access to workspaces
- [ ] Persistent storage (R2)
- [ ] Cost estimation display
- [ ] Configurable subdomains (api/app/workspace prefixes)
- [ ] Caddy on VMs for TLS cert provisioning (Let's Encrypt) — enables multi-level subdomain BASE_DOMAINs (e.g., `sam.company.com`) that Cloudflare free Universal SSL doesn't cover

## Planned: Multi-Tenancy (Phase 4)

**Target**: Q2 2026

Support for teams and organizations:

- [ ] Team management
- [ ] Per-user API tokens
- [ ] Usage quotas and limits
- [ ] Billing integration
- [ ] Audit logging

## Planned: Enterprise Features (Phase 5)

**Target**: Q3 2026

Features for enterprise deployments:

- [ ] Private networking (VPC)
- [ ] Custom domain support
- [ ] SSO integration (SAML, OIDC)
- [ ] Compliance features (SOC 2)
- [ ] Multi-region support
- [ ] Custom VM images
- [ ] API rate limiting

## Security Improvements

**Target**: Future

- [ ] VM callback token exchange flow (one-time code → JWT + refresh token)
- [ ] Token rotation for long-lived workspaces
- [ ] Workspace audit logging

## Future Considerations

Features under consideration for later phases:

- Alternative cloud providers (AWS, GCP, Azure)
- VS Code Remote integration
- Collaborative editing
- Workspace snapshots and restore
- GPU instances for AI workloads
- Kubernetes-based workspaces

## Feedback

Have ideas for the roadmap? Open an issue with the "enhancement" label.
