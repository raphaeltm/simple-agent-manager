# Quickstart: Local Mock Mode

**Feature**: 002-local-mock-mode
**Date**: 2025-01-25

## Overview

Run the Simple Agent Manager control plane locally without cloud credentials. Workspaces are created as local devcontainers instead of cloud VMs.

---

## Prerequisites

1. **Docker** - Docker Desktop or Docker Engine running
   ```bash
   docker --version  # Should show Docker version
   docker ps         # Should not error
   ```

2. **devcontainer CLI** - Install if not present
   ```bash
   npm install -g @devcontainers/cli
   devcontainer --version  # Should show version
   ```

3. **Repository cloned** with dependencies installed
   ```bash
   git clone https://github.com/your-org/simple-agent-manager.git
   cd simple-agent-manager
   pnpm install
   ```

---

## Start Mock Mode

Run the control plane in mock mode:

```bash
pnpm dev:mock
```

This starts:
- **API** at `http://localhost:8787` (mock providers)
- **Web UI** at `http://localhost:5173`

---

## Create a Workspace

1. Open `http://localhost:5173` in your browser
2. Click "Create Workspace"
3. Enter a public GitHub repository URL (e.g., `https://github.com/octocat/Hello-World`)
4. Select size (doesn't affect local containers)
5. Click "Create"

The workspace will:
1. Clone the repository to `/tmp/simple-agent-manager/{id}/`
2. Create a devcontainer from the repo's config (or a default if none exists)
3. Show as "Running" when ready

---

## View Workspace

Click on a workspace to see:
- Container ID
- Repository URL
- Status
- Creation time

---

## Stop Workspace

Click "Stop" on a workspace to:
1. Stop the Docker container
2. Remove the container
3. Clean up cloned files

---

## Execute Commands

Execute commands in a running workspace via API:

```bash
curl -X POST http://localhost:8787/vms/{workspace-id}/exec \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"command": "ls -la"}'
```

Response:
```json
{
  "workspaceId": "abc123",
  "command": "ls -la",
  "stdout": "total 0\ndrwxr-xr-x 1 vscode ...",
  "stderr": "",
  "exitCode": 0
}
```

---

## Limitations

Mock mode has these intentional limitations:

| Feature | Mock Mode | Production |
|---------|-----------|------------|
| Concurrent workspaces | 1 | Unlimited |
| Data persistence | None (in-memory) | KV/D1 storage |
| DNS records | In-memory mock | Cloudflare DNS |
| HTTPS | No (HTTP only) | Yes |
| Idle detection | No | 30-minute timeout |
| CloudCLI terminal | No | Yes |

---

## Troubleshooting

### "Docker is not running"
Start Docker Desktop or the Docker daemon:
```bash
# macOS/Windows: Open Docker Desktop
# Linux: sudo systemctl start docker
```

### "devcontainer CLI not found"
Install it globally:
```bash
npm install -g @devcontainers/cli
```

### "A workspace already exists"
Stop the existing workspace before creating a new one:
```bash
# Via UI: Click "Stop" on the existing workspace
# Via API: DELETE http://localhost:8787/vms/{workspace-id}
```

### "Failed to clone repository"
Check that:
- The repository URL is correct
- The repository is public (private repos not supported in mock mode)
- You have network connectivity

### "devcontainer up failed"
Check that:
- The repository's `.devcontainer/devcontainer.json` is valid JSON
- Docker has enough resources allocated

---

## Environment Variables

Mock mode uses these environment variables (set automatically by `pnpm dev:mock`):

| Variable | Value | Description |
|----------|-------|-------------|
| PROVIDER_TYPE | devcontainer | Use DevcontainerProvider |
| DNS_TYPE | mock | Use MockDNSService |
| API_TOKEN | dev-token | Local auth token |
| BASE_DOMAIN | localhost | Domain for workspace URLs |

---

## Next Steps

- **Run tests**: `pnpm test`
- **Build for production**: `pnpm build`
- **Deploy staging**: See deployment docs
