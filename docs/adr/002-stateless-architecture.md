# ADR 002: Stateless Architecture

**Status**: Superseded
**Date**: 2026-01-24
**Deciders**: Development Team
**Superseded By**: The project now uses Cloudflare D1 (SQLite) as the primary database for workspace metadata, user sessions, and credentials. See `apps/api/src/db/schema.ts` for the current schema and `apps/api/src/db/migrations/` for migration history.

> **Note**: This ADR describes the original stateless architecture used during the MVP phase. The migration path described below was executed as part of the Browser Terminal SaaS phase (spec 003). The original content is preserved as a historical record.

## Context

We need to store and manage workspace metadata including:
- Workspace configuration (repo URL, size, etc.)
- Lifecycle status (creating, running, stopped)
- Provider-specific IDs
- DNS records

Options for state management:
1. Traditional database (PostgreSQL, MySQL)
2. Cloudflare D1 (SQLite at the edge)
3. Stateless - derive state from provider labels
4. Key-value store (Cloudflare KV)

## Decision

We will use a **stateless architecture** where workspace state is derived from:

1. **Hetzner server labels**: Primary source of truth for workspace metadata
2. **Cloudflare DNS records**: Existence implies active workspace
3. **Cloudflare KV** (optional): Cache for fast list operations

### Hetzner Label Schema

```typescript
const labels = {
  'managed-by': 'simple-agent-manager',
  'workspace-id': 'ws-abc123',
  'repo-url': encodeURIComponent('https://github.com/user/repo'),
  'size': 'medium',
  'created-at': '2026-01-24T12:00:00Z',
};
```

### State Derivation

```typescript
// Status is derived from VM status
function mapVMStatusToWorkspace(vmStatus: string): WorkspaceStatus {
  switch (vmStatus) {
    case 'initializing':
    case 'starting':
      return 'creating';
    case 'running':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'off':
      return 'stopped';
    default:
      return 'creating';
  }
}
```

## Consequences

### Positive

- No database to manage or maintain
- Zero migration headaches
- Provider is source of truth (no sync issues)
- Simplified deployment (just Workers + Pages)
- Lower operational complexity
- Cost effective for MVP

### Negative

- Limited query capabilities
- No historical data retention
- Label character limits (63 chars per value)
- List operations require provider API calls
- No audit trail

### Neutral

- Different approach than traditional web apps
- Requires careful label encoding

## Migration Path

For future phases requiring:
- Multi-tenancy
- Usage tracking
- Audit logs
- Complex queries

Migrate to Cloudflare D1:

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

The current label-based approach provides enough data to bootstrap the database when migrating.

## Alternatives Considered

1. **Cloudflare D1 from start**
   - Rejected: Added complexity for MVP, not needed

2. **Cloudflare KV as primary store**
   - Rejected: No list/query capabilities without maintaining indexes

3. **External database (PlanetScale, Neon)**
   - Rejected: Added latency, complexity, cost for MVP
