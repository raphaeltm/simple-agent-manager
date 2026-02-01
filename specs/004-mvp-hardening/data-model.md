# Data Model: MVP Hardening

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)
**Date**: 2026-01-27

## Overview

This document defines data model changes for the MVP hardening feature. Changes are minimal - mostly additions to existing structures rather than new tables.

---

## Entity Changes

### 1. Bootstrap Token (NEW - KV Storage)

Bootstrap tokens enable secure credential delivery to VMs without embedding secrets in cloud-init.

**Storage**: Cloudflare KV (not D1)
**Key Pattern**: `bootstrap:{token}`
**TTL**: 300 seconds (5 minutes)

```typescript
interface BootstrapTokenData {
  workspaceId: string;
  hetznerToken: string;      // Encrypted
  callbackToken: string;     // JWT for API callbacks
  githubToken: string;       // Encrypted
  createdAt: string;         // ISO 8601
}
```

**Lifecycle**:
1. **Created**: When workspace provisioning begins
2. **Redeemed**: When VM calls `/api/bootstrap/:token` (deleted immediately)
3. **Expired**: Automatically deleted after 5 minutes via KV TTL

**Validation Rules**:
- Token format: UUID v4
- Single use: Deleted on first successful redemption
- Expiry: 5 minutes from creation

---

### 2. Workspace (MODIFIED - D1 Table)

**Existing Table**: `workspaces`

**New Fields**:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `errorReason` | TEXT | NULL | Human-readable error message when status is 'error' |
| `shutdownDeadline` | TEXT (ISO 8601) | NULL | Absolute timestamp for automatic shutdown |

**Migration**:
```sql
ALTER TABLE workspaces ADD COLUMN error_reason TEXT;
ALTER TABLE workspaces ADD COLUMN shutdown_deadline TEXT;
```

**Drizzle Schema Update**:
```typescript
// apps/api/src/db/schema.ts
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  repository: text('repository').notNull(),
  branch: text('branch').notNull(),
  status: text('status').notNull(), // 'pending' | 'creating' | 'ready' | 'stopped' | 'error'
  vmId: text('vm_id'),
  dnsRecordId: text('dns_record_id'),
  createdAt: text('created_at').notNull(),
  // NEW FIELDS
  errorReason: text('error_reason'),
  shutdownDeadline: text('shutdown_deadline'),
});
```

**Status Transitions**:
```
                    ┌──────────────────────────┐
                    │                          │
                    ▼                          │
┌─────────┐    ┌──────────┐    ┌─────────┐    │
│ pending │───▶│ creating │───▶│  ready  │────┤
└─────────┘    └────┬─────┘    └────┬────┘    │
                    │               │          │
                    │ timeout       │ idle     │
                    ▼               ▼          │
               ┌─────────┐    ┌─────────┐     │
               │  error  │    │ stopped │◀────┘
               └─────────┘    └─────────┘
                                  │
                                  │ user delete
                                  ▼
                             [DELETED]
```

**State Descriptions**:
- `pending`: Workspace created, VM provisioning not started
- `creating`: VM provisioning in progress
- `ready`: VM running, terminal accessible
- `stopped`: VM terminated (idle timeout or user action)
- `error`: Provisioning or runtime error (see errorReason)

---

## API Response Changes

### WorkspaceResponse (MODIFIED)

```typescript
interface WorkspaceResponse {
  id: string;
  name: string;
  repository: string;
  branch: string;
  status: 'pending' | 'creating' | 'ready' | 'stopped' | 'error';
  url?: string;           // Only when ready
  createdAt: string;
  // NEW FIELDS
  errorReason?: string;   // Only when status is 'error'
  shutdownDeadline?: string; // ISO 8601, only when status is 'ready'
}
```

### HeartbeatResponse (MODIFIED)

```typescript
interface HeartbeatResponse {
  action: 'continue' | 'shutdown';
  // NEW FIELD
  shutdownDeadline: string; // ISO 8601 timestamp
}
```

### BootstrapResponse (NEW)

```typescript
interface BootstrapResponse {
  hetznerToken: string;   // Decrypted, for VM self-destruct
  callbackToken: string;  // JWT for API callbacks
  githubToken: string;    // Decrypted, for git operations
}
```

---

## Validation Rules

### Bootstrap Token
- Format: UUID v4 (`/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`)
- Must exist in KV
- Must not have been redeemed (deleted on redemption)

### Shutdown Deadline
- Must be valid ISO 8601 timestamp
- Must be in the future when set
- Extended by 30 minutes on activity

### Error Reason
- Max length: 500 characters
- Required when status is 'error'
- Human-readable (no stack traces or technical details)

---

## Indexes

No new indexes required. Existing indexes sufficient:
- `workspaces.userId` - Already indexed for ownership queries
- `workspaces.status` - May benefit from index for timeout query (optional optimization)

---

## Data Retention

| Data | Retention | Cleanup Method |
|------|-----------|----------------|
| Bootstrap Tokens | 5 minutes | KV TTL auto-expiry |
| Workspace records | Indefinite | User-initiated delete |
| Error reasons | Same as workspace | Deleted with workspace |

---

## Migration Strategy

1. **D1 Migration**: Add new columns with `ALTER TABLE` (non-breaking)
2. **Code Update**: Update Drizzle schema to include new fields
3. **Backward Compatibility**: New fields are nullable, existing code unaffected
4. **No Data Migration**: New fields populated going forward only
