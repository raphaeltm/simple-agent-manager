# Data Model: Automated Self-Hosting Deployment (Pulumi)

**Date**: 2026-01-29 | **Feature**: 005-automated-deployment

## Overview

This document defines the Pulumi resource definitions and TypeScript interfaces for infrastructure-as-code deployment. The primary data model is the Pulumi resource graph, with supporting TypeScript types for configuration and outputs.

## Pulumi Resources

### 1. D1 Database

**Resource Type**: `cloudflare.D1Database`

```typescript
// infra/resources/database.ts
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

export const database = new cloudflare.D1Database("sam-database", {
  accountId: config.require("cloudflareAccountId"),
  name: `sam-${pulumi.getStack()}`,  // e.g., sam-prod
});

// Export outputs for wrangler.toml
export const databaseId = database.id;
export const databaseName = database.name;
```

**Inputs**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `accountId` | string | Yes | Cloudflare account ID |
| `name` | string | Yes | Database name (unique per account) |

**Outputs**:
| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Database UUID for wrangler.toml binding |
| `name` | string | Database name |

---

### 2. KV Namespace

**Resource Type**: `cloudflare.WorkersKvNamespace`

```typescript
// infra/resources/kv.ts
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

export const kvNamespace = new cloudflare.WorkersKvNamespace("sam-kv", {
  accountId: config.require("cloudflareAccountId"),
  title: `sam-${pulumi.getStack()}-sessions`,  // e.g., sam-prod-sessions
});

// Export outputs for wrangler.toml
export const kvNamespaceId = kvNamespace.id;
export const kvNamespaceName = kvNamespace.title;
```

**Inputs**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `accountId` | string | Yes | Cloudflare account ID |
| `title` | string | Yes | Namespace title (unique per account) |

**Outputs**:
| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Namespace ID for wrangler.toml binding |
| `title` | string | Namespace title |

---

### 3. R2 Bucket

**Resource Type**: `cloudflare.R2Bucket`

```typescript
// infra/resources/storage.ts
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

export const r2Bucket = new cloudflare.R2Bucket("sam-r2", {
  accountId: config.require("cloudflareAccountId"),
  name: `sam-${pulumi.getStack()}-assets`,  // e.g., sam-prod-assets
  location: "auto",  // Auto-select based on user location
});

// Export outputs for wrangler.toml
export const r2BucketName = r2Bucket.name;
```

**Inputs**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `accountId` | string | Yes | Cloudflare account ID |
| `name` | string | Yes | Bucket name (globally unique) |
| `location` | string | No | Storage location hint |

**Outputs**:
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Bucket name for wrangler.toml binding |

---

### 4. DNS Records

**Resource Type**: `cloudflare.DnsRecord`

```typescript
// infra/resources/dns.ts
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const zoneId = config.require("cloudflareZoneId");
const baseDomain = config.require("baseDomain");

// API subdomain (api.example.com → Worker)
export const apiDnsRecord = new cloudflare.DnsRecord("sam-dns-api", {
  zoneId: zoneId,
  name: `api.${baseDomain}`,
  type: "CNAME",
  content: "workspaces-api.workers.dev",  // Updated after Worker deploy
  proxied: true,
  ttl: 1,  // Auto TTL when proxied
  comment: "SAM API - managed by Pulumi",
});

// App subdomain (app.example.com → Pages)
export const appDnsRecord = new cloudflare.DnsRecord("sam-dns-app", {
  zoneId: zoneId,
  name: `app.${baseDomain}`,
  type: "CNAME",
  content: "workspaces-web.pages.dev",  // Updated after Pages deploy
  proxied: true,
  ttl: 1,
  comment: "SAM Web UI - managed by Pulumi",
});

// Wildcard subdomain (*.example.com → Worker for workspace routing)
export const wildcardDnsRecord = new cloudflare.DnsRecord("sam-dns-wildcard", {
  zoneId: zoneId,
  name: `*.${baseDomain}`,
  type: "CNAME",
  content: "workspaces-api.workers.dev",
  proxied: true,
  ttl: 1,
  comment: "SAM Workspaces - managed by Pulumi",
});

// Export record IDs for teardown
export const dnsRecordIds = {
  api: apiDnsRecord.id,
  app: appDnsRecord.id,
  wildcard: wildcardDnsRecord.id,
};
```

**Inputs**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `zoneId` | string | Yes | Cloudflare zone ID |
| `name` | string | Yes | Full record name |
| `type` | string | Yes | Record type (CNAME, A, etc.) |
| `content` | string | Yes | Target value |
| `proxied` | boolean | No | Enable Cloudflare proxy |
| `ttl` | number | No | Time to live (1 = auto) |
| `comment` | string | No | Record description |

**Outputs**:
| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Record ID for management |
| `hostname` | string | Full resolved hostname |

---

## Pulumi Stack Configuration

### Pulumi.yaml (Project Definition)

```yaml
name: sam-infra
runtime: nodejs
description: Simple Agent Manager Infrastructure
```

### Pulumi.prod.yaml (Stack Configuration)

```yaml
config:
  cloudflareAccountId: <from-secret>
  cloudflareZoneId: <from-secret>
  baseDomain: workspaces.example.com
```

**Note**: Sensitive values come from environment variables, not stack config.

---

## TypeScript Interfaces

### PulumiOutputs

Outputs consumed by deployment scripts:

```typescript
// scripts/deploy/types.ts

export interface PulumiOutputs {
  // Database
  d1DatabaseId: string;
  d1DatabaseName: string;

  // KV
  kvNamespaceId: string;
  kvNamespaceName: string;

  // R2
  r2BucketName: string;

  // DNS (for validation)
  dnsRecordIds: {
    api: string;
    app: string;
    wildcard: string;
  };
}
```

### DeploymentConfig

User-provided deployment configuration:

```typescript
export interface DeploymentConfig {
  // Pulumi backend (R2)
  pulumiStateBucket: string;
  pulumiConfigPassphrase: string;  // Sensitive

  // Cloudflare
  cloudflare: {
    accountId: string;
    apiToken: string;  // Sensitive
    zoneId: string;
  };

  // R2 credentials (for Pulumi backend)
  r2: {
    accessKeyId: string;  // Sensitive
    secretAccessKey: string;  // Sensitive
  };

  // Application
  baseDomain: string;
  environment: "production" | "staging";

  // Optional: GitHub App
  github?: {
    clientId: string;
    clientSecret: string;  // Sensitive
    appId: string;
    appPrivateKey: string;  // Sensitive
  };
}
```

### WranglerTomlBindings

Bindings section of wrangler.toml:

```typescript
export interface WranglerTomlBindings {
  d1_databases: Array<{
    binding: string;
    database_name: string;
    database_id: string;
  }>;

  kv_namespaces: Array<{
    binding: string;
    id: string;
  }>;

  r2_buckets: Array<{
    binding: string;
    bucket_name: string;
  }>;
}
```

---

## State Management

### Pulumi State (R2 Backend)

State is stored in user's R2 bucket:

```
s3://sam-pulumi-state/
├── .pulumi/
│   ├── stacks/
│   │   └── prod.json       # Production stack state
│   ├── history/
│   │   └── prod/           # Deployment history
│   └── backups/            # Automatic backups
```

**State File Contents** (encrypted):
- Resource definitions and their IDs
- Output values
- Dependency graph
- Deployment metadata

### State Encryption

- Secrets encrypted with `PULUMI_CONFIG_PASSPHRASE`
- State file itself stored in R2 (not encrypted at rest by Pulumi, but R2 encrypts)
- Passphrase must be consistent across deployments

---

## Resource Dependencies

```
┌─────────────────────────────────────────────┐
│              Pulumi Stack                    │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────────┐    ┌─────────────┐        │
│  │ D1 Database │    │ KV Namespace │        │
│  └─────────────┘    └─────────────┘        │
│         │                  │                │
│         └────────┬─────────┘                │
│                  ↓                          │
│          ┌─────────────┐                    │
│          │  R2 Bucket  │                    │
│          └─────────────┘                    │
│                  │                          │
│                  ↓                          │
│  ┌─────────────────────────────────────┐   │
│  │           DNS Records               │   │
│  │  ┌─────┐  ┌─────┐  ┌──────────┐   │   │
│  │  │ API │  │ App │  │ Wildcard │   │   │
│  │  └─────┘  └─────┘  └──────────┘   │   │
│  └─────────────────────────────────────┘   │
│                                             │
└─────────────────────────────────────────────┘
                    │
                    ↓ (Pulumi outputs)
┌─────────────────────────────────────────────┐
│              Wrangler Deploy                │
├─────────────────────────────────────────────┤
│  - Update wrangler.toml with IDs           │
│  - Deploy Worker (uses D1, KV, R2)         │
│  - Deploy Pages                             │
│  - Run migrations (D1)                      │
│  - Set secrets                              │
│  - Upload binaries (R2)                     │
└─────────────────────────────────────────────┘
```

---

## Validation Rules

### Resource Naming

| Resource | Pattern | Constraints |
|----------|---------|-------------|
| D1 | `sam-{stack}` | 1-64 chars, alphanumeric + hyphen |
| KV | `sam-{stack}-sessions` | 1-512 chars |
| R2 | `sam-{stack}-assets` | 3-63 chars, lowercase + hyphen |
| DNS | `{subdomain}.{baseDomain}` | Valid hostname |

### Configuration Validation

```typescript
export function validateConfig(config: DeploymentConfig): ValidationResult {
  const errors: string[] = [];

  // Account ID format
  if (!/^[a-f0-9]{32}$/.test(config.cloudflare.accountId)) {
    errors.push("Invalid Cloudflare account ID format");
  }

  // Zone ID format
  if (!/^[a-f0-9]{32}$/.test(config.cloudflare.zoneId)) {
    errors.push("Invalid Cloudflare zone ID format");
  }

  // Domain format
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(config.baseDomain)) {
    errors.push("Invalid base domain format");
  }

  // R2 bucket name
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.pulumiStateBucket)) {
    errors.push("Invalid R2 bucket name format");
  }

  return { valid: errors.length === 0, errors };
}
```

---

## Migration from Old Approach

The old `scripts/deploy/` code used custom API calls. Resources created by the old approach can be imported:

```bash
# Import existing D1 database
pulumi import cloudflare:index/d1Database:D1Database sam-database \
  '<account_id>/<database_id>'

# Import existing KV namespace
pulumi import cloudflare:index/workersKvNamespace:WorkersKvNamespace sam-kv \
  '<account_id>/<namespace_id>'

# Import existing R2 bucket
pulumi import cloudflare:index/r2Bucket:R2Bucket sam-r2 \
  '<account_id>/<bucket_name>'
```

This allows adopting Pulumi without recreating resources.

---

## Summary

The Pulumi data model provides:
1. **Declarative resources** with clear inputs/outputs
2. **Type-safe configuration** via TypeScript
3. **State management** in user's R2 bucket
4. **Dependency tracking** between resources
5. **Import capability** for existing resources

All resource definitions are idempotent and support incremental updates.
