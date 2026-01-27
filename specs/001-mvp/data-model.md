# Data Model: Cloud AI Coding Workspaces MVP

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Phase**: 1 - Design
**Date**: 2026-01-24
**Updated**: 2026-01-25

## Overview

This document defines the core entities, their relationships, and storage strategy for the MVP.

---

## Storage Strategy

### MVP Approach: Stateless + Provider Labels

The MVP uses a **stateless architecture** where workspace state is derived from:
1. **Hetzner server labels** - Metadata stored with VM
2. **Cloudflare DNS records** - Existence implies active workspace
3. **Cloudflare KV** (optional) - Cache for fast list operations

**Why stateless?**
- No database to manage
- Provider is source of truth
- Simplifies deployment
- Reduces operational complexity

### Future: Cloudflare D1 (Phase 2+)

For multi-tenancy and persistence features, migrate to D1:
- Workspace history
- Usage tracking
- Tenant management

---

## Core Entities

### Workspace

The primary entity representing an AI coding environment.

```typescript
// packages/shared/src/types.ts

export type WorkspaceStatus =
  | 'creating'   // VM being provisioned
  | 'running'    // VM active, accessible
  | 'stopping'   // Shutdown initiated
  | 'stopped'    // VM terminated
  | 'failed';    // Provisioning failed

export interface Workspace {
  /** Unique workspace identifier (e.g., "ws-abc123") */
  id: string;

  /** Human-readable name (derived from repo) */
  name: string;

  /** Git repository URL */
  repoUrl: string;

  /** Current lifecycle status */
  status: WorkspaceStatus;

  /** Provider-specific VM identifier */
  providerId: string;

  /** Provider name (e.g., "hetzner") */
  provider: string;

  /** Public IP address (when running) */
  ipAddress: string | null;

  /** Fully qualified domain name */
  hostname: string;

  /** Access URL for CloudCLI */
  accessUrl: string | null;

  /** VM size (small/medium/large) */
  size: 'small' | 'medium' | 'large';

  /** ISO 8601 creation timestamp */
  createdAt: string;

  /** ISO 8601 last activity timestamp (if tracked) */
  lastActivityAt: string | null;

  /** Error message (if status is 'failed') */
  error: string | null;
}
```

### Workspace Create Request

```typescript
export interface CreateWorkspaceRequest {
  /** Git repository URL (required) */
  repoUrl: string;

  /** VM size (optional, defaults to 'medium') */
  size?: 'small' | 'medium' | 'large';

  /** Custom name (optional, derived from repo if not provided) */
  name?: string;
}

/**
 * Note: Anthropic API key is NOT required.
 * Users authenticate via `claude login` in the CloudCLI terminal.
 * Claude Max subscription is required.
 */
```

### Workspace Summary (List Response)

```typescript
export interface WorkspaceSummary {
  id: string;
  name: string;
  status: WorkspaceStatus;
  accessUrl: string | null;
  createdAt: string;
}
```

---

---

## GitHub Integration Entities

### GitHubConnection

Represents a user's GitHub App installation for accessing private repositories.

```typescript
// packages/shared/src/types.ts

export type GitHubConnectionStatus = 'active' | 'revoked' | 'pending';

export interface GitHubConnection {
  /** GitHub App installation ID */
  installationId: number;

  /** GitHub account login (user or org) */
  accountLogin: string;

  /** GitHub account type */
  accountType: 'User' | 'Organization';

  /** List of accessible repository full names (owner/repo) */
  repositories: string[];

  /** Connection status */
  status: GitHubConnectionStatus;

  /** ISO 8601 installation timestamp */
  installedAt: string;

  /** ISO 8601 last token generation timestamp */
  lastTokenAt: string | null;
}
```

### GitHubInstallationToken

Short-lived token for repository access (generated on demand).

```typescript
export interface GitHubInstallationToken {
  /** The access token */
  token: string;

  /** ISO 8601 expiration timestamp (typically 1 hour) */
  expiresAt: string;

  /** Repositories this token can access */
  repositories: string[];

  /** Permissions granted (write includes read) */
  permissions: {
    contents: 'write';
  };
}
```

### Storage Strategy for GitHub Connection

**MVP Approach: Cloudflare KV**

```typescript
// Key pattern: github:installation:{installationId}
// Value: JSON serialized GitHubConnection
// No TTL (permanent until revoked)

interface KVGitHubConnection {
  key: `github:installation:${number}`;
  value: GitHubConnection;
}

// For single-user MVP, also store:
// Key: github:current
// Value: installationId
```

**Future: Cloudflare D1**

For multi-tenancy, migrate to D1 with user association:

```sql
CREATE TABLE github_connections (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  repositories TEXT NOT NULL, -- JSON array
  status TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  last_token_at TEXT
);
```

---

## Provider Entities

### VM Configuration

Internal representation for creating VMs.

```typescript
// packages/providers/src/types.ts

export interface VMConfig {
  /** Unique identifier for the workspace */
  workspaceId: string;

  /** Human-readable name */
  name: string;

  /** Git repository URL */
  repoUrl: string;

  /** VM size tier */
  size: 'small' | 'medium' | 'large';

  /** Auto-generated basic auth password */
  authPassword: string;

  /** API token for cleanup callback */
  apiToken: string;

  /** Base domain for DNS */
  baseDomain: string;

  /** GitHub installation token for private repos (optional) */
  githubToken?: string;
}

/**
 * Note: anthropicApiKey is NOT included.
 * Users authenticate via `claude login` in CloudCLI terminal.
 * ANTHROPIC_API_KEY env var must NOT be set on VMs.
 */
```

### VM Instance

Provider response representation.

```typescript
export interface VMInstance {
  /** Provider-specific server ID */
  id: string;

  /** Server name */
  name: string;

  /** Public IPv4 address */
  ip: string;

  /** Provider-reported status */
  status: 'initializing' | 'running' | 'off' | 'starting' | 'stopping';

  /** Server type (e.g., "cx22") */
  serverType: string;

  /** ISO 8601 creation timestamp */
  createdAt: string;

  /** Labels attached to server */
  labels: Record<string, string>;
}
```

### Provider Interface

```typescript
export interface Provider {
  /** Provider identifier */
  readonly name: string;

  /** Create a new VM */
  createVM(config: VMConfig): Promise<VMInstance>;

  /** Delete a VM by ID */
  deleteVM(id: string): Promise<void>;

  /** List all managed VMs */
  listVMs(): Promise<VMInstance[]>;

  /** Get a single VM by ID */
  getVM(id: string): Promise<VMInstance | null>;

  /** Get size configuration */
  getSizeConfig(size: VMConfig['size']): SizeConfig;

  /** Generate cloud-init script */
  generateCloudInit(config: VMConfig): string;
}

export interface SizeConfig {
  /** Provider-specific server type */
  type: string;

  /** Monthly price string */
  price: string;

  /** vCPU count */
  vcpu: number;

  /** RAM in GB */
  ramGb: number;

  /** Storage in GB */
  storageGb: number;
}
```

---

## DNS Entities

### DNS Record

```typescript
// apps/api/src/services/dns.ts

export interface DNSRecord {
  /** Cloudflare record ID */
  id: string;

  /** Record name (e.g., "*.ws-abc123.vm") */
  name: string;

  /** Record type (always "A" for MVP) */
  type: 'A';

  /** Target IP address */
  content: string;

  /** Whether proxied through Cloudflare */
  proxied: boolean;

  /** TTL (1 = auto when proxied) */
  ttl: number;
}
```

---

## Hetzner Label Schema

Workspace metadata stored as Hetzner server labels:

```typescript
const labels = {
  // Identification
  'managed-by': 'cloud-ai-workspaces',
  'workspace-id': 'ws-abc123',

  // Configuration
  'repo-url': encodeURIComponent('https://github.com/user/repo'),
  'size': 'medium',

  // Tracking
  'created-at': '2026-01-24T12:00:00Z',
};
```

**Label Constraints (Hetzner)**:
- Key: 1-63 chars, alphanumeric + `-_`
- Value: 0-63 chars
- Max labels per server: 16

---

## Cloudflare KV Schema (Optional Cache)

For faster list operations, cache workspace data in KV:

```typescript
// Key pattern: workspace:{id}
// Value: JSON serialized WorkspaceSummary
// TTL: 5 minutes (refresh on mutation)

interface KVWorkspaceCache {
  key: `workspace:${string}`;
  value: WorkspaceSummary;
  metadata: {
    provider: string;
    providerId: string;
    refreshedAt: string;
  };
}
```

---

## State Transitions

```
                    ┌─────────────────────────┐
                    │                         │
   POST /vms        ▼                         │
  ───────────► [creating] ──── success ────►[running]
                    │                         │
                    │                         │ DELETE /vms/:id
                    │ failure                 │ or idle timeout
                    │                         │
                    ▼                         ▼
               [failed]                  [stopping]
                                              │
                                              │ cleanup complete
                                              │
                                              ▼
                                          [stopped]
                                         (deleted)
```

**Transitions**:
- `creating → running`: VM boots, devcontainer starts, CloudCLI accessible
- `creating → failed`: Provisioning error, API failure, timeout
- `running → stopping`: Manual stop or idle timeout triggers shutdown
- `stopping → stopped`: VM deleted, DNS cleaned up
- `stopped → (deleted)`: No longer exists in system

---

## Identifier Generation

```typescript
// packages/shared/src/lib/id.ts

/**
 * Generate workspace ID
 * Format: ws-{random6}
 * Example: ws-abc123
 */
export function generateWorkspaceId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const random = Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
  return `ws-${random}`;
}
```

---

## Validation Rules

### CreateWorkspaceRequest Validation

```typescript
export const createWorkspaceSchema = {
  repoUrl: {
    required: true,
    pattern: /^https?:\/\/.+/,
    maxLength: 500,
  },
  size: {
    enum: ['small', 'medium', 'large'],
    default: 'medium',
  },
  name: {
    maxLength: 50,
    pattern: /^[a-zA-Z0-9-_]+$/,
  },
};

/**
 * Note: anthropicApiKey validation removed (2026-01-25).
 * Users authenticate via `claude login` in CloudCLI terminal.
 */
```

### Private Repository Validation

```typescript
/**
 * For private repositories:
 * 1. Check if user has GitHub connection
 * 2. Verify repository is in accessible list
 * 3. Generate installation token on-demand
 */
export async function validateRepoAccess(
  repoUrl: string,
  connection: GitHubConnection | null
): Promise<{ valid: boolean; error?: string }> {
  const repoName = extractRepoFullName(repoUrl); // e.g., "owner/repo"

  // Public repos always allowed
  if (await isPublicRepo(repoUrl)) {
    return { valid: true };
  }

  // Private repo requires GitHub connection
  if (!connection) {
    return { valid: false, error: 'GitHub connection required for private repositories' };
  }

  if (connection.status !== 'active') {
    return { valid: false, error: 'GitHub connection is not active' };
  }

  if (!connection.repositories.includes(repoName)) {
    return { valid: false, error: 'Repository not accessible. Update GitHub App permissions.' };
  }

  return { valid: true };
}
```

---

## Example Data

### Workspace (Running)

```json
{
  "id": "ws-abc123",
  "name": "my-project",
  "repoUrl": "https://github.com/user/my-project",
  "status": "running",
  "providerId": "12345678",
  "provider": "hetzner",
  "ipAddress": "159.69.123.45",
  "hostname": "ui.ws-abc123.vm.example.com",
  "accessUrl": "https://ui.ws-abc123.vm.example.com",
  "size": "medium",
  "createdAt": "2026-01-24T12:00:00Z",
  "lastActivityAt": "2026-01-24T12:30:00Z",
  "error": null
}
```

### Workspace (Failed)

```json
{
  "id": "ws-def456",
  "name": "bad-repo",
  "repoUrl": "https://github.com/user/nonexistent",
  "status": "failed",
  "providerId": "12345679",
  "provider": "hetzner",
  "ipAddress": null,
  "hostname": "ui.ws-def456.vm.example.com",
  "accessUrl": null,
  "size": "small",
  "createdAt": "2026-01-24T13:00:00Z",
  "lastActivityAt": null,
  "error": "Git clone failed: repository not found"
}
```

---

## Type Exports

All types are exported from the shared package:

```typescript
// packages/shared/src/index.ts
export * from './types';
export * from './lib/id';
```

Usage in other packages:

```typescript
import { Workspace, CreateWorkspaceRequest, WorkspaceStatus } from '@cloud-ai-workspaces/shared';
```
