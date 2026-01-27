# Data Model: Browser Terminal SaaS MVP

**Date**: 2026-01-26
**Status**: Complete
**Plan**: [plan.md](./plan.md)

This document defines the database schema, entity relationships, and data flow for the platform.

---

## Storage Overview

| Store | Technology | Purpose |
|-------|------------|---------|
| Primary Database | Cloudflare D1 (SQLite) | Users, credentials, workspaces, installations |
| Session Store | Cloudflare KV | BetterAuth session data |
| Binary Store | Cloudflare R2 | VM Agent binaries |

---

## Entity Relationship Diagram

```
┌──────────────────┐         ┌─────────────────────┐
│      users       │         │  github_installations│
├──────────────────┤    1:N  ├─────────────────────┤
│ id (PK)          │◄────────┤ id (PK)             │
│ github_id        │         │ user_id (FK)        │
│ email            │         │ installation_id     │
│ name             │         │ account_type        │
│ avatar_url       │         │ account_name        │
│ created_at       │         │ created_at          │
│ updated_at       │         │ updated_at          │
└──────────────────┘         └─────────────────────┘
         │
         │ 1:N                1:1
         ▼                     │
┌──────────────────┐           │
│   credentials    │           │
├──────────────────┤           │
│ id (PK)          │           │
│ user_id (FK)     │           │
│ provider         │           │
│ encrypted_token  │           │
│ iv               │           │
│ created_at       │           │
│ updated_at       │           │
└──────────────────┘           │
         │                     │
         │ 1:N                 │
         ▼                     │
┌──────────────────┐           │
│    workspaces    │◄──────────┘
├──────────────────┤
│ id (PK)          │
│ user_id (FK)     │
│ installation_id  │ (nullable - for git clone)
│ name             │
│ repository       │
│ branch           │
│ status           │
│ vm_size          │
│ vm_location      │
│ hetzner_server_id│
│ vm_ip            │
│ dns_record_id    │
│ last_activity_at │
│ error_message    │
│ created_at       │
│ updated_at       │
└──────────────────┘
```

---

## Schema Definition (Drizzle ORM)

```typescript
// apps/api/src/db/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// =============================================================================
// Users
// =============================================================================
export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // ULID or UUID
  githubId: text('github_id').notNull().unique(),
  email: text('email').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// =============================================================================
// Credentials (encrypted cloud provider tokens)
// =============================================================================
export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), // 'hetzner'
  encryptedToken: text('encrypted_token').notNull(), // AES-256-GCM ciphertext
  iv: text('iv').notNull(), // Initialization vector for decryption
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// =============================================================================
// GitHub App Installations
// =============================================================================
export const githubInstallations = sqliteTable('github_installations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  installationId: text('installation_id').notNull().unique(), // GitHub's installation ID
  accountType: text('account_type').notNull(), // 'personal' | 'organization'
  accountName: text('account_name').notNull(), // GitHub username or org name
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// =============================================================================
// Workspaces
// =============================================================================
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(), // Used in subdomain: ws-{id}.workspaces.example.com
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  installationId: text('installation_id').references(() => githubInstallations.id),
  name: text('name').notNull(),
  repository: text('repository').notNull(), // 'owner/repo' format
  branch: text('branch').notNull().default('main'),
  status: text('status').notNull().default('pending'),
  // ^ 'pending' | 'creating' | 'running' | 'stopping' | 'stopped' | 'error'
  vmSize: text('vm_size').notNull(), // 'small' | 'medium' | 'large'
  vmLocation: text('vm_location').notNull(), // 'nbg1' | 'fsn1' | 'hel1'
  hetznerServerId: text('hetzner_server_id'), // Set after VM is created
  vmIp: text('vm_ip'), // Set after VM is created
  dnsRecordId: text('dns_record_id'), // Cloudflare DNS record ID
  lastActivityAt: text('last_activity_at'), // Updated by VM Agent heartbeat
  errorMessage: text('error_message'), // Set when status is 'error'
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

---

## BetterAuth Schema

BetterAuth generates additional tables for session management. These are automatically migrated:

```typescript
// BetterAuth auto-generated tables (managed by better-auth-cloudflare)
// - sessions: Session records (stored in D1 or KV based on config)
// - accounts: OAuth provider accounts linked to users
// - verifications: Email verification tokens (unused in MVP)
```

For this project, we configure BetterAuth to use KV for sessions (faster reads) and D1 for accounts.

---

## Type Definitions

```typescript
// packages/shared/src/types.ts

// =============================================================================
// User
// =============================================================================
export interface User {
  id: string;
  githubId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Credential
// =============================================================================
export type CredentialProvider = 'hetzner';

export interface Credential {
  id: string;
  userId: string;
  provider: CredentialProvider;
  encryptedToken: string; // Never expose to client
  iv: string; // Never expose to client
  createdAt: string;
  updatedAt: string;
}

// API response (safe to expose)
export interface CredentialResponse {
  id: string;
  provider: CredentialProvider;
  connected: boolean;
  createdAt: string;
}

// =============================================================================
// GitHub Installation
// =============================================================================
export type AccountType = 'personal' | 'organization';

export interface GitHubInstallation {
  id: string;
  userId: string;
  installationId: string;
  accountType: AccountType;
  accountName: string;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Workspace
// =============================================================================
export type WorkspaceStatus =
  | 'pending'    // Initial state, not yet provisioning
  | 'creating'   // VM being created, cloud-init running
  | 'running'    // VM Agent responding, terminal accessible
  | 'stopping'   // VM being deleted
  | 'stopped'    // VM deleted, workspace record remains
  | 'error';     // Provisioning or runtime error

export type VMSize = 'small' | 'medium' | 'large';

export type VMLocation = 'nbg1' | 'fsn1' | 'hel1';

export interface Workspace {
  id: string;
  userId: string;
  installationId: string | null;
  name: string;
  repository: string;
  branch: string;
  status: WorkspaceStatus;
  vmSize: VMSize;
  vmLocation: VMLocation;
  hetznerServerId: string | null;
  vmIp: string | null;
  dnsRecordId: string | null;
  lastActivityAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// API response (includes computed fields)
export interface WorkspaceResponse extends Workspace {
  url: string; // Computed: https://ws-{id}.workspaces.example.com
}

// Create request
export interface CreateWorkspaceRequest {
  name: string;
  repository: string; // 'owner/repo'
  branch?: string; // default: 'main'
  vmSize: VMSize;
  vmLocation: VMLocation;
}
```

---

## Status Transitions

```
                    ┌──────────────────────────────────────┐
                    │                                      │
                    ▼                                      │
┌─────────┐    ┌──────────┐    ┌─────────┐    ┌─────────┐ │
│ pending │───►│ creating │───►│ running │───►│stopping │─┘
└─────────┘    └──────────┘    └─────────┘    └─────────┘
     │              │               │              │
     │              │               │              ▼
     │              │               │         ┌─────────┐
     │              │               └────────►│ stopped │
     │              │                         └─────────┘
     │              │                              ▲
     │              ▼                              │
     │         ┌─────────┐                         │
     └────────►│  error  │─────────────────────────┘
               └─────────┘   (delete cleans up)
```

### Transition Rules

| From | To | Trigger |
|------|----|---------|
| pending | creating | User submits create form |
| creating | running | VM Agent health check passes |
| creating | error | cloud-init fails, timeout, API error |
| running | stopping | User clicks Stop, idle timeout |
| stopping | stopped | VM deleted, DNS cleaned up |
| running | error | VM Agent unresponsive, VM deleted externally |
| error | stopped | User deletes workspace (cleanup) |

---

## Indexes

```sql
-- Performance indexes (add to migrations)
CREATE INDEX idx_credentials_user_id ON credentials(user_id);
CREATE INDEX idx_github_installations_user_id ON github_installations(user_id);
CREATE INDEX idx_workspaces_user_id ON workspaces(user_id);
CREATE INDEX idx_workspaces_status ON workspaces(status);
CREATE INDEX idx_workspaces_user_status ON workspaces(user_id, status);
```

---

## Data Retention

| Entity | Retention | Notes |
|--------|-----------|-------|
| Users | Indefinite | Deleted on account deletion |
| Credentials | Indefinite | Deleted on account deletion |
| GitHubInstallations | Until uninstalled | Removed via webhook |
| Workspaces | 30 days after stopped | Future: auto-cleanup job |
| Sessions (KV) | 30 days | BetterAuth default TTL |

---

## Encryption at Rest

### Credential Token Encryption

All cloud provider tokens are encrypted before storage:

```typescript
// Storage flow
const { ciphertext, iv } = await encrypt(hetznerToken, env.ENCRYPTION_KEY);
await db.insert(credentials).values({
  id: generateId(),
  userId,
  provider: 'hetzner',
  encryptedToken: ciphertext,
  iv,
});

// Retrieval flow
const credential = await db.query.credentials.findFirst({
  where: eq(credentials.userId, userId),
});
const token = await decrypt(credential.encryptedToken, credential.iv, env.ENCRYPTION_KEY);
```

### Key Rotation

Future enhancement: Support multiple encryption keys with key ID stored alongside ciphertext.

---

## VM Size Mapping

```typescript
// packages/shared/src/constants.ts
export const VM_SIZE_CONFIG: Record<VMSize, { hetznerType: string; cpus: number; ram: string }> = {
  small: { hetznerType: 'cx22', cpus: 2, ram: '4GB' },
  medium: { hetznerType: 'cx32', cpus: 4, ram: '8GB' },
  large: { hetznerType: 'cx42', cpus: 8, ram: '16GB' },
};

export const VM_LOCATIONS: Record<VMLocation, { name: string; country: string }> = {
  nbg1: { name: 'Nuremberg', country: 'DE' },
  fsn1: { name: 'Falkenstein', country: 'DE' },
  hel1: { name: 'Helsinki', country: 'FI' },
};
```

---

## Summary

The data model consists of 4 primary entities:

1. **users** - GitHub-authenticated users
2. **credentials** - Encrypted cloud provider tokens (AES-256-GCM)
3. **github_installations** - GitHub App installations for repo access
4. **workspaces** - Cloud coding environments with lifecycle state

All data is stored in Cloudflare D1 (SQLite) except sessions (KV) and binaries (R2).
