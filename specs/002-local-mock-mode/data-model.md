# Data Model: Local Mock Mode

**Feature**: 002-local-mock-mode
**Date**: 2025-01-25

## Overview

This feature primarily reuses existing data models. The key additions are implementation-specific structures for the DevcontainerProvider and MockDNSService.

---

## Existing Entities (Unchanged)

These entities from `packages/providers/src/types.ts` and `packages/shared/` are reused without modification.

### VMConfig
Configuration passed to provider's `createVM()` method.

| Field | Type | Description |
|-------|------|-------------|
| workspaceId | string | Unique identifier for the workspace |
| name | string | Human-readable name |
| repoUrl | string | Git repository URL |
| size | WorkspaceSize | VM size tier (small/medium/large) |
| authPassword | string | Auto-generated basic auth password |
| apiToken | string | API token for cleanup callback |
| baseDomain | string | Base domain for DNS |
| apiUrl | string | API URL for cleanup callback |
| githubToken? | string | GitHub token for private repos (optional) |

### VMInstance
Instance returned by provider methods.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Provider-specific ID (container ID for devcontainer) |
| name | string | Instance name |
| ip | string | IP address (container IP for devcontainer) |
| status | enum | 'initializing' \| 'running' \| 'off' \| 'starting' \| 'stopping' |
| serverType | string | Provider type identifier (e.g., "devcontainer-medium") |
| createdAt | string | ISO 8601 timestamp |
| labels | Record<string, string> | Metadata labels |

### SizeConfig
Size tier configuration.

| Field | Type | Description |
|-------|------|-------------|
| type | string | Provider-specific type identifier |
| price | string | Price string (always "$0/month" for devcontainer) |
| vcpu | number | vCPU count (informational for devcontainer) |
| ramGb | number | RAM in GB (informational for devcontainer) |
| storageGb | number | Storage in GB (informational for devcontainer) |

### DNSRecord
DNS record structure (reused by MockDNSService).

| Field | Type | Description |
|-------|------|-------------|
| id | string | Record ID (UUID for mock) |
| name | string | DNS record name (e.g., *.abc123.vm.localhost) |
| type | 'A' | Record type (always A) |
| content | string | IP address |
| proxied | boolean | Whether proxied (always false for mock) |
| ttl | number | TTL in seconds |

---

## New Internal Structures

These are implementation details within the new providers, not exposed to other packages.

### DevcontainerState (internal to DevcontainerProvider)

Tracks the current workspace state in memory.

| Field | Type | Description |
|-------|------|-------------|
| workspaceId | string | Workspace identifier |
| containerId | string | Docker container ID |
| workspaceFolder | string | Path to cloned repo (e.g., /tmp/cloud-ai-workspaces/{id}) |
| repoUrl | string | Original repository URL |
| status | VMInstance['status'] | Current status |
| createdAt | Date | Creation timestamp |

### MockDNSStore (internal to MockDNSService)

In-memory storage for DNS records.

```typescript
// Stored as Map<workspaceId, DNSRecord>
private records = new Map<string, DNSRecord>();
```

---

## State Transitions

### Workspace Lifecycle (DevcontainerProvider)

```
[none] ──createVM()──> [initializing]
                            │
                       git clone
                            │
                       devcontainer up
                            │
                            v
                       [running] ──deleteVM()──> [stopping]
                                                      │
                                                 docker stop
                                                 docker rm
                                                      │
                                                      v
                                                  [none]
```

### Status Mapping

| Docker Container State | VMInstance Status |
|------------------------|-------------------|
| (creating) | initializing |
| running | running |
| exited | off |
| paused | stopping |
| (not found) | (null) |

---

## Validation Rules

### VMConfig Validation (existing, unchanged)
- `workspaceId`: Non-empty string, alphanumeric with hyphens
- `repoUrl`: Valid git URL (https:// or git@)
- `size`: One of 'small', 'medium', 'large'
- `authPassword`: Non-empty string
- `baseDomain`: Valid domain name

### DevcontainerProvider-Specific
- Only one workspace allowed at a time (FR-012)
- Docker daemon must be running
- devcontainer CLI must be installed
- Repository must be clonable

---

## Relationships

```
┌─────────────────────┐
│   WorkspaceService  │
└─────────────────────┘
          │
          │ uses (injected)
          v
┌─────────────────────┐     ┌─────────────────────┐
│     Provider        │     │    DNSService       │
│  (interface)        │     │    (interface)      │
└─────────────────────┘     └─────────────────────┘
          △                           △
          │                           │
    ┌─────┴─────┐               ┌─────┴─────┐
    │           │               │           │
┌───────┐  ┌─────────────┐  ┌───────┐  ┌─────────┐
│Hetzner│  │Devcontainer │  │  DNS  │  │MockDNS  │
│Provider│ │  Provider   │  │Service│  │ Service │
└───────┘  └─────────────┘  └───────┘  └─────────┘
```

---

## Notes

- No database schema changes required
- No new API contracts (reusing existing endpoints)
- All new structures are in-memory only
- Workspace data does not persist across API restarts (per spec)
