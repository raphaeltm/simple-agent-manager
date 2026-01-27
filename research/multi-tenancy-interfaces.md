# Multi-Tenancy Interface Design

> **Related docs:** [Architecture Notes](./architecture-notes.md) | [AI Agent Optimizations](./ai-agent-optimizations.md) | [DNS & Security](./dns-security-persistence-plan.md) | [Index](./README.md)

## Overview

This document defines interfaces that support multi-tenancy from day one, even though MVP will use a single "default" tenant. The key principle: **never hardcode tenant-specific values; always pass them explicitly**.

## Assessment

**Can the current architecture support multi-tenancy?**

**Yes.** The core architecture (serverless Workers, self-terminating VMs, cloud-init) is fundamentally compatible. Changes are needed at the interface/data model level, not architectural level.

---

## Multi-tenancy Models

### Model A: Shared Infrastructure (SaaS)
- Platform owns cloud provider accounts
- Platform owns domain (`*.vm.platform.com`)
- Users authenticate to platform
- Platform bills users based on usage

### Model B: Bring Your Own Cloud (BYOC)
- Users provide their own Hetzner/Scaleway API keys
- Users optionally provide their own domain
- Platform orchestrates but doesn't pay for VMs
- More privacy, users control infrastructure

### Model C: Hybrid (Recommended)
- Platform provides default infrastructure
- Users can optionally bring their own credentials/domain
- Maximum flexibility

---

## Core Interfaces

### Request Context

All API handlers receive tenant context:

```typescript
interface RequestContext {
  tenantId: string;
  userId: string;
  permissions: string[];
}

// MVP: Hardcoded default
const DEFAULT_CONTEXT: RequestContext = {
  tenantId: 'default',
  userId: 'default',
  permissions: ['*'],
};

// Future: Extracted from JWT
function getContext(request: Request): RequestContext {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) return DEFAULT_CONTEXT;
  return verifyAndDecodeJWT(token);
}
```

### Tenant Entity

```typescript
interface Tenant {
  id: string;
  name: string;
  email: string;
  createdAt: string;

  // Authentication
  authConfig: {
    provider: 'email' | 'github' | 'google' | 'oidc';
    // Provider-specific config
  };

  // Cloud provider credentials (references to encrypted storage)
  cloudProviders: {
    [providerName: string]: {
      credentialsKeyId: string;  // Reference to encrypted creds in KV
      defaultRegion?: string;
      sshKeyId?: string;
    };
  };

  // DNS configuration
  dnsConfig: DNSConfig;

  // Storage configuration
  storageConfig: StorageConfig;

  // Quotas and limits
  quotas: {
    maxConcurrentVMs: number;
    maxStorageGB: number;
    allowedProviders: string[];
  };
}
```

---

## Provider Interface

### Credentials (Passed Explicitly)

```typescript
interface ProviderCredentials {
  type: 'hetzner' | 'scaleway' | 'ovh' | 'digitalocean';
  apiToken: string;

  // Provider-specific
  sshKeyId?: string;
  region?: string;
  projectId?: string;  // For providers that use projects
}

// MVP: Get from env
// Future: Get from encrypted KV based on tenantId
async function getProviderCredentials(
  tenantId: string,
  providerName: string
): Promise<ProviderCredentials> {
  if (tenantId === 'default') {
    // MVP: Use environment variables
    return {
      type: 'hetzner',
      apiToken: env.HETZNER_TOKEN,
      sshKeyId: env.HETZNER_SSH_KEY_ID,
      region: env.HETZNER_REGION || 'fsn1',
    };
  }

  // Future: Fetch from encrypted storage
  const tenant = await getTenant(tenantId);
  const providerConfig = tenant.cloudProviders[providerName];
  const encryptedCreds = await env.CREDENTIALS_KV.get(
    providerConfig.credentialsKeyId
  );
  return decrypt(encryptedCreds, env.MASTER_KEY);
}
```

### Provider Interface

```typescript
interface VMConfig {
  name: string;
  repoUrl: string;
  size: 'small' | 'medium' | 'large';
  sshPublicKey?: string;
}

interface VMMetadata {
  tenantId: string;
  workspaceId: string;
  vmId: string;  // Our internal ID
}

interface VM {
  id: string;           // Our internal ID
  providerId: string;   // Provider's ID
  tenantId: string;
  workspaceId: string;
  provider: string;
  name: string;
  ip: string;
  status: 'creating' | 'running' | 'stopping' | 'stopped';
  createdAt: string;
  labels: Record<string, string>;
}

interface Provider {
  name: string;

  // Credentials passed explicitly, not stored in provider instance
  createVM(
    config: VMConfig,
    credentials: ProviderCredentials,
    metadata: VMMetadata
  ): Promise<VM>;

  deleteVM(
    providerId: string,
    credentials: ProviderCredentials
  ): Promise<void>;

  listVMs(
    credentials: ProviderCredentials,
    filter?: { tenantId?: string; labels?: Record<string, string> }
  ): Promise<VM[]>;

  getVM(
    providerId: string,
    credentials: ProviderCredentials
  ): Promise<VM | null>;

  // Size mapping (same for all tenants)
  getSizeConfig(size: VMConfig['size']): {
    providerType: string;
    ram: number;
    cpu: number;
    price: string;
  };

  // Generate cloud-init (may include tenant-specific config)
  generateCloudInit(
    config: VMConfig,
    metadata: VMMetadata,
    secrets: CloudInitSecrets
  ): string;
}

interface CloudInitSecrets {
  apiCallbackUrl: string;
  apiCallbackToken: string;
  providerToken: string;  // For self-destruct
  terminalPassword: string;
  workspaceEncryptionKey?: string;
  r2Credentials?: R2Credentials;
}
```

### Provider Implementation Example

```typescript
class HetznerProvider implements Provider {
  name = 'hetzner';

  async createVM(
    config: VMConfig,
    credentials: ProviderCredentials,
    metadata: VMMetadata
  ): Promise<VM> {
    const sizeConfig = this.getSizeConfig(config.size);

    const response = await fetch('https://api.hetzner.cloud/v1/servers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credentials.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: config.name,
        server_type: sizeConfig.providerType,
        image: 'ubuntu-24.04',
        ssh_keys: credentials.sshKeyId ? [credentials.sshKeyId] : [],
        location: credentials.region || 'fsn1',
        labels: {
          'managed-by': 'devcontainer-manager',
          'tenant-id': metadata.tenantId,
          'workspace-id': metadata.workspaceId,
          'vm-id': metadata.vmId,
        },
        user_data: this.generateCloudInit(config, metadata, secrets),
      }),
    });

    const data = await response.json();

    return {
      id: metadata.vmId,
      providerId: String(data.server.id),
      tenantId: metadata.tenantId,
      workspaceId: metadata.workspaceId,
      provider: this.name,
      name: config.name,
      ip: data.server.public_net.ipv4.ip,
      status: 'creating',
      createdAt: new Date().toISOString(),
      labels: data.server.labels,
    };
  }

  async listVMs(
    credentials: ProviderCredentials,
    filter?: { tenantId?: string }
  ): Promise<VM[]> {
    // Use label selector to filter by tenant
    const labelSelector = filter?.tenantId
      ? `tenant-id=${filter.tenantId}`
      : 'managed-by=devcontainer-manager';

    const response = await fetch(
      `https://api.hetzner.cloud/v1/servers?label_selector=${labelSelector}`,
      {
        headers: { 'Authorization': `Bearer ${credentials.apiToken}` },
      }
    );

    const data = await response.json();
    return data.servers.map(this.mapServerToVM);
  }
}
```

---

## DNS Interface

```typescript
type DNSConfigType = 'platform' | 'custom';

interface PlatformDNSConfig {
  type: 'platform';
  tenantSubdomain: string;  // e.g., 'tenant123' → *.vm-id.tenant123.vm.example.com
}

interface CustomDNSConfig {
  type: 'custom';
  zoneId: string;
  apiToken: string;  // Tenant's Cloudflare token (encrypted)
  baseDomain: string;
}

type DNSConfig = PlatformDNSConfig | CustomDNSConfig;

interface DNSManager {
  // Create wildcard record for VM
  createVMRecord(
    config: DNSConfig,
    vmId: string,
    ip: string
  ): Promise<{ hostname: string }>;

  // Delete record when VM terminates
  deleteVMRecord(
    config: DNSConfig,
    vmId: string
  ): Promise<void>;

  // Get the base hostname for a VM
  getVMHostname(config: DNSConfig, vmId: string): string;
}

// MVP: Get from env
// Future: Get from tenant config
async function getDNSConfig(tenantId: string): Promise<DNSConfig> {
  if (tenantId === 'default') {
    return {
      type: 'platform',
      tenantSubdomain: 'default',  // *.{vm-id}.default.vm.example.com
      // Or simpler for single tenant:
      // tenantSubdomain: '',  // *.{vm-id}.vm.example.com
    };
  }

  const tenant = await getTenant(tenantId);
  return tenant.dnsConfig;
}
```

### DNS Hostname Patterns

```
Single-tenant MVP:
  ui.{vm-id}.vm.example.com
  3000.{vm-id}.vm.example.com

Multi-tenant (platform DNS):
  ui.{vm-id}.{tenant-id}.vm.example.com
  3000.{vm-id}.{tenant-id}.vm.example.com

Multi-tenant (custom domain):
  ui.{vm-id}.vm.tenant-domain.com
  3000.{vm-id}.vm.tenant-domain.com
```

---

## Storage Interface

```typescript
type StorageConfigType = 'platform' | 'custom';

interface PlatformStorageConfig {
  type: 'platform';
  tenantPrefix: string;  // e.g., 'tenant123/' prefix in shared R2 bucket
}

interface CustomStorageConfig {
  type: 'custom';
  endpoint: string;      // S3-compatible endpoint
  bucket: string;
  accessKeyId: string;   // Encrypted
  secretAccessKey: string;  // Encrypted
  region?: string;
}

type StorageConfig = PlatformStorageConfig | CustomStorageConfig;

interface StorageManager {
  // Upload workspace backup
  uploadWorkspace(
    config: StorageConfig,
    workspaceId: string,
    data: ReadableStream,
    metadata?: Record<string, string>
  ): Promise<void>;

  // Download workspace backup
  downloadWorkspace(
    config: StorageConfig,
    workspaceId: string
  ): Promise<ReadableStream | null>;

  // Delete workspace backup
  deleteWorkspace(
    config: StorageConfig,
    workspaceId: string
  ): Promise<void>;

  // List workspaces (for tenant)
  listWorkspaces(
    config: StorageConfig
  ): Promise<{ workspaceId: string; size: number; lastModified: string }[]>;
}

// MVP: Get from env
async function getStorageConfig(tenantId: string): Promise<StorageConfig> {
  if (tenantId === 'default') {
    return {
      type: 'platform',
      tenantPrefix: 'default/',
    };
  }

  const tenant = await getTenant(tenantId);
  return tenant.storageConfig;
}
```

### Storage Key Structure

```
Platform R2 bucket: workspaces

Single-tenant:
  default/{workspace-id}/workspace.tar.gz.enc
  default/{workspace-id}/metadata.json

Multi-tenant:
  {tenant-id}/{workspace-id}/workspace.tar.gz.enc
  {tenant-id}/{workspace-id}/metadata.json
```

---

## Encryption Interface

```typescript
interface EncryptionConfig {
  // Master key for encrypting tenant keys (from env, never changes)
  masterKeyId: string;

  // Per-tenant key for encrypting workspace keys
  tenantKeyId: string;
}

interface EncryptionManager {
  // Generate new workspace encryption key
  generateWorkspaceKey(
    tenantId: string,
    workspaceId: string
  ): Promise<{ keyId: string; key: string }>;

  // Get workspace encryption key
  getWorkspaceKey(
    tenantId: string,
    workspaceId: string
  ): Promise<string>;

  // Rotate workspace key (re-encrypt backup with new key)
  rotateWorkspaceKey(
    tenantId: string,
    workspaceId: string
  ): Promise<{ newKeyId: string }>;

  // Delete workspace key
  deleteWorkspaceKey(
    tenantId: string,
    workspaceId: string
  ): Promise<void>;
}

// Key storage structure in KV:
// keys:{tenant-id}:{workspace-id} → encrypted workspace key
// Workspace key encrypted with tenant key
// Tenant key encrypted with master key
```

---

## API Endpoints with Tenant Scoping

```typescript
// All endpoints extract tenant from auth context

// VMs
POST   /vms                    // Create VM for authenticated tenant
GET    /vms                    // List VMs for authenticated tenant
GET    /vms/:id                // Get VM (must belong to tenant)
DELETE /vms/:id                // Delete VM (must belong to tenant)
POST   /vms/:id/cleanup        // VM callback (validated by token)

// Workspaces
GET    /workspaces             // List workspaces for tenant
GET    /workspaces/:id         // Get workspace (must belong to tenant)
DELETE /workspaces/:id         // Delete workspace and backup

// (Future) Tenant management
GET    /tenant                 // Get current tenant profile
PUT    /tenant                 // Update tenant settings
POST   /tenant/providers       // Add cloud provider credentials
DELETE /tenant/providers/:name // Remove cloud provider
POST   /tenant/dns             // Configure custom DNS
```

---

## Worker Environment

```typescript
interface Env {
  // Platform-level (from wrangler.toml secrets)
  JWT_SECRET: string;
  MASTER_ENCRYPTION_KEY: string;

  // Platform Cloudflare (for platform DNS)
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  BASE_DOMAIN: string;

  // Platform R2 (for platform storage)
  WORKSPACES_BUCKET: R2Bucket;

  // KV namespaces
  TENANTS: KVNamespace;      // Tenant profiles
  CREDENTIALS: KVNamespace;  // Encrypted provider credentials
  KEYS: KVNamespace;         // Encrypted workspace keys
  VMS: KVNamespace;          // VM metadata cache

  // MVP-only: Default credentials (remove in multi-tenant)
  HETZNER_TOKEN?: string;
  HETZNER_SSH_KEY_ID?: string;
}
```

---

## Migration Path: Single to Multi-Tenant

### Phase 1: MVP (Single Tenant)
- Use `DEFAULT_CONTEXT` for all requests
- Credentials from env vars
- Single DNS zone, no tenant prefix
- Single R2 bucket, `default/` prefix

### Phase 2: Add Authentication
- Implement JWT auth
- Extract tenantId from token
- Keep using env var credentials (all tenants share platform infra)

### Phase 3: Tenant Isolation
- Add tenant management endpoints
- Allow tenants to add their own cloud credentials
- Tenant-prefixed storage

### Phase 4: Full BYOC
- Custom DNS support
- Custom storage support
- Per-tenant billing/quotas

---

## Summary

The interfaces defined here support multi-tenancy from day one:

| Component | MVP Behavior | Multi-tenant Behavior |
|-----------|-------------|----------------------|
| Auth | Bearer token → default tenant | JWT → real tenantId |
| Provider creds | From env vars | From encrypted KV per tenant |
| DNS | `*.{vm}.vm.example.com` | `*.{vm}.{tenant}.vm.example.com` |
| Storage | `default/{workspace}/` | `{tenant}/{workspace}/` |
| Encryption | Per-workspace key | Tenant key → workspace key |
| VM listing | All platform VMs | Filtered by tenant label |

**No architectural changes needed** for multi-tenancy—just interface discipline from the start.
