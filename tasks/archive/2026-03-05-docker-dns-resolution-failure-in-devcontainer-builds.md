# Docker DNS Resolution Failure in Devcontainer Builds

## Problem

All devcontainer builds fail on Hetzner VMs because Docker containers cannot resolve external hostnames (specifically `github.com`). This causes the nvm devcontainer feature to fail during installation, which blocks ALL workspace creation for repositories that use the default devcontainer configuration.

## Root Cause

The Docker daemon inside the Hetzner VM does not have DNS resolution configured for external domains. When the devcontainer build runs `git clone https://github.com/nvm-sh/nvm/`, the DNS lookup fails:

```
fatal: unable to access 'https://github.com/nvm-sh/nvm/': Could not resolve host: github.com
Invalid NVM_VERSION value: latest Valid values:
ERROR: Feature "Node.js (via nvm), yarn and pnpm." (ghcr.io/devcontainers/features/node) failed to install!
```

The fallback devcontainer configuration also fails with the same error, so there is no recovery path.

## Context

- **Discovered**: 2026-03-05 during manual QA testing via Playwright
- **Severity**: Critical — blocks ALL task execution for any project
- **Affected**: All 4 newly submitted tasks failed with the same error
- **Node**: The VM host itself has DNS (it can clone repos from GitHub), but Docker containers running inside the VM do not inherit DNS configuration
- **Timestamp range**: All failures occurred between 09:21:46 and 09:22:50 UTC

## Reproduction

1. Create a project linked to any GitHub repository
2. Submit any task via project chat
3. Task will provision a VM, clone the repo, then fail at devcontainer build

## Acceptance Criteria

- [ ] Docker daemon on Hetzner VMs has DNS resolution configured (e.g., `--dns 8.8.8.8` or `/etc/docker/daemon.json` with DNS config)
- [ ] Devcontainer builds can resolve `github.com` and other external domains
- [ ] Cloud-init template configures Docker DNS as part of VM provisioning
- [ ] Test: Submit a task and verify devcontainer builds successfully
