# Research: Local Mock Mode

**Feature**: 002-local-mock-mode
**Date**: 2025-01-25

## Overview

This document captures research findings for implementing local mock mode. All technical decisions have been resolved - no NEEDS CLARIFICATION items remain.

---

## 1. Devcontainer CLI Usage

### Decision
Use `@devcontainers/cli` via child process execution (execa or Node's spawn).

### Rationale
- The devcontainer CLI is the official tool from Microsoft for managing devcontainers
- Already tested and verified working in this environment (see spec exploration)
- Provides JSON output for programmatic parsing
- Handles all complexity of devcontainer.json parsing, feature installation, etc.

### Key Commands

| Operation | Command | Output |
|-----------|---------|--------|
| Create/Start | `devcontainer up --workspace-folder {path}` | JSON with containerId |
| Execute | `devcontainer exec --workspace-folder {path} {cmd}` | Command output |
| Stop | `docker stop {containerId}` | (uses Docker directly) |
| Remove | `docker rm {containerId}` | (uses Docker directly) |

### Alternatives Considered
- **Dockerode (Docker SDK for Node.js)**: More complex, would need to replicate devcontainer logic
- **Direct Docker CLI**: Doesn't handle devcontainer.json features
- **Docker Compose**: Overkill for single container, different config format

---

## 2. Workspace Storage Location

### Decision
Store cloned repositories in `/tmp/simple-agent-manager/{workspaceId}/`

### Rationale
- Temporary directory is appropriate for development artifacts
- Automatic cleanup on system restart
- Isolated per-workspace to prevent conflicts
- Easy to manually clean up if needed

### Implementation Notes
```typescript
const workspaceDir = `/tmp/simple-agent-manager/${workspaceId}`;
await fs.mkdir(workspaceDir, { recursive: true });
await execa('git', ['clone', repoUrl, workspaceDir]);
```

### Alternatives Considered
- **User home directory (~/.simple-agent-manager/)**: Persists across reboots, but spec says no persistence needed
- **Project-local directory**: Could conflict with git, gets messy

---

## 3. Container Identification and Tracking

### Decision
Use Docker labels to track managed containers.

### Rationale
- Consistent with HetznerProvider pattern (uses VM labels)
- Survives API restarts (can rediscover containers)
- Standard Docker practice

### Labels Applied
```
workspace-id={workspaceId}
managed-by=simple-agent-manager
provider=devcontainer
repo-url={encodedRepoUrl}
```

### Finding Containers
```bash
docker ps --filter "label=managed-by=simple-agent-manager" --filter "label=provider=devcontainer"
```

---

## 4. Default Devcontainer Configuration

### Decision
Use a minimal default devcontainer.json for repos without one.

### Rationale
- Most repos don't have devcontainer.json
- Need consistent baseline environment
- Must include Claude Code for testing

### Default Configuration
```json
{
  "name": "Simple Agent Manager Workspace",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",
  "features": {
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/devcontainers/features/node:1": { "version": "22" }
  },
  "remoteUser": "vscode"
}
```

### Notes
- Matches the default used by HetznerProvider (scripts/vm/default-devcontainer.json)
- Simplified version without Claude Code feature (that's for production VMs)
- Can be enhanced later if needed

---

## 5. MockDNSService Design

### Decision
Implement a class-compatible mock that stores records in a Map.

### Rationale
- Must implement same interface as DNSService for drop-in replacement
- In-memory storage is sufficient (no cross-session persistence needed)
- Simple and testable

### Interface Compatibility
```typescript
interface DNSServiceInterface {
  createRecord(workspaceId: string, ip: string, baseDomain: string): Promise<DNSRecord>;
  deleteRecord(workspaceId: string, baseDomain: string): Promise<boolean>;
  findRecord(workspaceId: string, baseDomain: string): Promise<DNSRecord | null>;
  recordExists(workspaceId: string, baseDomain: string): Promise<boolean>;
}
```

### Implementation Pattern
```typescript
class MockDNSService implements DNSServiceInterface {
  private records = new Map<string, DNSRecord>();

  async createRecord(workspaceId: string, ip: string, baseDomain: string) {
    const record = { id: crypto.randomUUID(), name: `*.${workspaceId}.vm.${baseDomain}`, ... };
    this.records.set(workspaceId, record);
    return record;
  }
}
```

---

## 6. Provider Selection Mechanism

### Decision
Use environment variable `PROVIDER_TYPE` with factory pattern.

### Rationale
- Factory pattern already exists in packages/providers/src/index.ts
- Environment variables are the standard Cloudflare Workers pattern
- Easy to configure via wrangler.toml or .dev.vars

### Configuration
```toml
# wrangler.toml
[env.mock.vars]
PROVIDER_TYPE = "devcontainer"
DNS_TYPE = "mock"
```

### Factory Update
```typescript
export function createProvider(type?: 'hetzner' | 'devcontainer'): Provider {
  const providerType = type || process.env.PROVIDER_TYPE || 'hetzner';
  switch (providerType) {
    case 'devcontainer':
      return new DevcontainerProvider();
    case 'hetzner':
    default:
      return new HetznerProvider({ apiToken: process.env.HETZNER_TOKEN || '' });
  }
}
```

---

## 7. Single Workspace Enforcement

### Decision
Check for existing workspace before creating new one; return error if one exists.

### Rationale
- Per spec FR-012: single workspace limit
- Simplifies resource management
- Prevents accidental resource exhaustion

### Implementation
```typescript
async createVM(config: VMConfig): Promise<VMInstance> {
  const existing = await this.listVMs();
  if (existing.length > 0) {
    throw new Error('A workspace already exists. Stop it before creating a new one.');
  }
  // ... proceed with creation
}
```

---

## 8. Error Handling Strategy

### Decision
Provide actionable error messages per Constitution Principle IV.

### Rationale
- Users need to know HOW to fix issues, not just WHAT went wrong
- Docker/devcontainer CLI availability are common failure points

### Error Messages

| Scenario | Error Message |
|----------|---------------|
| Docker not running | "Docker is not running. Please start Docker Desktop or the Docker daemon." |
| devcontainer CLI missing | "devcontainer CLI not found. Install it with: npm install -g @devcontainers/cli" |
| Workspace already exists | "A workspace already exists (ID: {id}). Stop it with DELETE /vms/{id} before creating a new one." |
| Git clone failed | "Failed to clone repository: {error}. Check the URL is correct and accessible." |
| devcontainer up failed | "Failed to start devcontainer: {error}. Check the repository's devcontainer.json is valid." |

---

## 9. Cleanup of Docker-in-Docker Code

### Decision
Delete entirely (not archive).

### Rationale
- Per clarification: nested DinD is not viable in current dev environment
- Archiving adds maintenance burden
- Git history preserves the code if ever needed

### Files to Delete
- `packages/providers/src/docker.ts`
- `scripts/docker/Dockerfile`
- `scripts/docker/entrypoint.sh`
- `scripts/docker/nginx.conf`
- `scripts/docker/supervisord.conf`

### References to Remove
- Export from `packages/providers/src/index.ts`
- 'docker' case in provider factory switch statement

---

## Summary

All research items resolved. No NEEDS CLARIFICATION markers. Ready to proceed with Phase 1 design artifacts.
