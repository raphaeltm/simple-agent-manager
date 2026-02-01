# Research: Automated Self-Hosting Deployment (Revised)

**Feature Branch**: `005-automated-deployment`
**Research Date**: 2026-01-29
**Status**: Revised to use Pulumi + Wrangler hybrid approach

## Overview

This document contains research findings for implementing automated deployment using **Pulumi for infrastructure provisioning** and **Wrangler for application deployment**. The previous approach using custom Cloudflare API calls was deemed brittle due to lack of state management and drift detection.

## Research Questions

### RQ-1: Does @pulumi/cloudflare support all required resources?

**Decision**: Yes, `@pulumi/cloudflare` v6.12.0 supports all required Cloudflare resources.

**Findings**:
| Resource | Pulumi Type | Status |
|----------|-------------|--------|
| D1 Database | `cloudflare.D1Database` | ✅ Supported ([Docs](https://www.pulumi.com/registry/packages/cloudflare/api-docs/d1database/)) |
| KV Namespace | `cloudflare.WorkersKvNamespace` | ✅ Supported ([Docs](https://www.pulumi.com/registry/packages/cloudflare/api-docs/workerskvnamespace/)) |
| R2 Bucket | `cloudflare.R2Bucket` | ✅ Supported ([Docs](https://www.pulumi.com/registry/packages/cloudflare/api-docs/r2bucket/)) |
| DNS Records | `cloudflare.DnsRecord` | ✅ Supported ([Docs](https://www.pulumi.com/registry/packages/cloudflare/api-docs/dnsrecord/)) |

**Note**: D1Database replacement destroys all data. Pulumi handles this with `protect` option if needed.

**Alternatives Considered**:
- Terraform Cloudflare provider: Same underlying provider, but requires HCL learning curve
- Wrangler auto-provisioning: Lacks state management and drift detection
- Custom API calls: Brittle, no state tracking (rejected)

---

### RQ-2: How should Pulumi project be structured?

**Decision**: Create `infra/` directory at repository root with TypeScript Pulumi project.

**Rationale**:
- Separates infrastructure code from application code ([Pulumi Best Practices](https://www.pulumi.com/docs/iac/guides/basics/organizing-projects-stacks/))
- TypeScript provides type safety and IDE support
- Single project with production stack is sufficient for this use case

**Recommended Structure**:
```
infra/
├── Pulumi.yaml           # Project definition (name: sam-infra)
├── Pulumi.prod.yaml      # Production stack config
├── package.json          # Dependencies
├── tsconfig.json         # TypeScript config
├── index.ts              # Entry point - orchestrates all resources
├── resources/
│   ├── database.ts       # D1 database resource
│   ├── kv.ts             # KV namespace resource
│   ├── storage.ts        # R2 bucket resource
│   └── dns.ts            # DNS records (api, app, wildcard)
└── __tests__/
    └── index.test.ts     # Unit tests with mocks
```

**Alternatives Considered**:
- Monolithic single file: Harder to maintain as resources grow
- Multiple projects: Overkill for single deployment target
- Co-located with apps: Mixes concerns, harder to find

---

### RQ-3: How to test Pulumi code?

**Decision**: Use Pulumi's `setMocks()` API with Vitest for unit testing.

**Rationale**:
- Pulumi provides `pulumi.runtime.setMocks()` to mock provider calls ([Testing Docs](https://www.pulumi.com/docs/iac/guides/testing/unit/))
- Vitest aligns with project's existing testing framework
- Tests verify resource configuration without API calls

**Implementation Pattern**:
```typescript
import * as pulumi from "@pulumi/pulumi";
import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  pulumi.runtime.setMocks({
    newResource: (args) => ({
      id: `${args.name}-mock-id`,
      state: args.inputs,
    }),
    call: (args) => args.inputs,
  }, "test-project", "test-stack");
});

describe("D1 Database", () => {
  it("creates database with correct name", async () => {
    const { database } = await import("../resources/database");
    const name = await database.name.promise();
    expect(name).toBe("sam-production");
  });
});
```

**Alternatives Considered**:
- Integration tests against real Cloudflare: Too slow, requires account
- Jest: Project uses Vitest, no reason to mix
- No testing: Unacceptable for infrastructure code

---

### RQ-4: How to use Cloudflare R2 as Pulumi state backend?

**Decision**: Use S3-compatible URL with R2 API credentials.

**Rationale**:
- R2 provides S3-compatible API ([R2 as Backend Guide](https://kjune.com/posts/22/2024-06-30-using-cloudflare-r2-as-pulumi-backend/))
- Pulumi natively supports S3 backends ([State Docs](https://www.pulumi.com/docs/iac/concepts/state-and-backends/))
- Free tier includes 10GB storage
- Self-hosted, no Pulumi Cloud dependency

**Configuration**:
```bash
# Required environment variables
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export PULUMI_CONFIG_PASSPHRASE="<user-provided-passphrase>"

# Login to R2 backend
pulumi login 's3://sam-pulumi-state?endpoint=<account-id>.r2.cloudflarestorage.com&region=auto'
```

**Key Points**:
- User must create R2 bucket manually (ONE prerequisite)
- User must create R2 API token with Object Read & Write
- Passphrase encrypts secrets in state file

**Alternatives Considered**:
- Pulumi Cloud: Requires external service (rejected per requirements)
- AWS S3: Requires AWS account, adds dependency
- Local filesystem: Not suitable for CI/CD

---

### RQ-5: How to integrate Pulumi with GitHub Actions?

**Decision**: Use official `pulumi/actions@v5` with self-managed backend.

**Rationale**:
- Official action handles CLI installation ([GitHub Actions](https://github.com/pulumi/actions))
- Supports `cloud-url` parameter for self-managed backends
- Well-tested, maintained by Pulumi team

**Workflow Pattern**:
```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pulumi/actions@v5
        with:
          command: up
          stack-name: prod
          work-dir: infra
          cloud-url: 's3://sam-pulumi-state?endpoint=${{ secrets.CF_ACCOUNT_ID }}.r2.cloudflarestorage.com&region=auto'
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          PULUMI_CONFIG_PASSPHRASE: ${{ secrets.PULUMI_CONFIG_PASSPHRASE }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
```

**Alternatives Considered**:
- Manual CLI installation: More brittle, reinvents wheel
- Pulumi Deployments: Requires Pulumi Cloud

---

### RQ-6: How to pass Pulumi outputs to Wrangler?

**Decision**: Use `pulumi stack output --json` and TypeScript script to update wrangler.toml.

**Rationale**:
- Pulumi outputs can be exported as JSON ([CLI Docs](https://www.pulumi.com/docs/iac/cli/commands/pulumi_stack_output/))
- wrangler.toml requires resource IDs in specific format
- TypeScript provides type-safe transformation

**Implementation**:
```typescript
// scripts/deploy/sync-wrangler-config.ts
import { execSync } from "child_process";
import * as fs from "fs";
import * as TOML from "@iarna/toml";

interface PulumiOutputs {
  d1DatabaseId: string;
  kvNamespaceId: string;
  r2BucketName: string;
}

const outputs: PulumiOutputs = JSON.parse(
  execSync("pulumi stack output --json", { cwd: "infra" }).toString()
);

const configPath = "apps/api/wrangler.toml";
const config = TOML.parse(fs.readFileSync(configPath, "utf-8"));

// Update production environment
config.env.production.d1_databases[0].database_id = outputs.d1DatabaseId;
config.env.production.kv_namespaces[0].id = outputs.kvNamespaceId;
// R2 bucket_name is set by name, not ID

fs.writeFileSync(configPath, TOML.stringify(config));
```

**Alternatives Considered**:
- envsubst templating: Less type-safe, harder to validate
- Wrangler CLI flags: Not all bindings can be overridden
- Manual update: Error-prone, defeats automation purpose

---

### RQ-7: What's the recommended Pulumi + Wrangler division?

**Decision**: Pulumi for infrastructure provisioning, Wrangler for application deployment.

**Rationale**:
- [Cloudflare recommends this pattern](https://developers.cloudflare.com/pulumi/tutorial/dynamic-provider-and-wrangler/)
- Pulumi excels at infrastructure lifecycle (state, drift)
- Wrangler understands Worker internals (bundling, secrets)

**Division of Responsibility**:
| Tool | Resources Managed |
|------|-------------------|
| **Pulumi** | D1 database, KV namespace, R2 bucket, DNS records |
| **Wrangler** | Worker deployment, Pages deployment, migrations, secrets |

**Why Not Pure Pulumi?**
- `cloudflare.WorkersScript` loses Wrangler's bundling features
- No direct support for D1 migrations
- Secrets management is more complex

**Why Not Pure Wrangler?**
- Auto-provisioning (v4.45.0+) lacks state management
- No drift detection
- Can't easily teardown resources

**Alternatives Considered**:
- Pulumi only: Loses Wrangler bundling/migration features
- Wrangler only: No state management or drift detection
- Terraform + Wrangler: Same benefits, but HCL vs TypeScript

---

### RQ-8: What Cloudflare API token permissions are required?

**Decision**: Single API token with all required permissions.

**Required Permissions**:
| Permission | Access | Purpose |
|------------|--------|---------|
| D1 | Edit | Create/manage D1 databases |
| Workers KV Storage | Edit | Create/manage KV namespaces |
| Workers R2 Storage | Edit | Create/manage R2 buckets |
| DNS | Edit | Create/manage DNS records |
| Workers Scripts | Edit | Deploy Workers (Wrangler) |
| Cloudflare Pages | Edit | Deploy Pages (Wrangler) |
| Zone | Read | Access zone info for DNS |
| Account Settings | Read | Get account ID |

**Token Creation Steps**:
1. Go to Cloudflare Dashboard → API Tokens
2. Create Custom Token
3. Add all permissions above
4. Scope to specific account and zone
5. Create and copy token

**Alternatives Considered**:
- Multiple tokens: More secure but complex configuration
- Broad API key: Less secure than scoped token

---

## Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@pulumi/pulumi` | ^3.0.0 | Pulumi SDK core |
| `@pulumi/cloudflare` | ^6.12.0 | Cloudflare provider |
| `wrangler` | ^3.100.0 | Workers/Pages CLI |
| `@iarna/toml` | ^2.2.5 | TOML parsing (round-trip safe) |

## Implementation Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Actions Workflow                   │
├─────────────────────────────────────────────────────────────┤
│  1. Checkout code                                            │
│  2. Setup Node.js + pnpm                                     │
│  3. Install dependencies                                     │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Phase 1: Infrastructure (Pulumi)                        │ │
│  │  - Login to R2 backend                                  │ │
│  │  - pulumi up --yes                                      │ │
│  │  - Export outputs (D1 ID, KV ID, R2 name)              │ │
│  └─────────────────────────────────────────────────────────┘ │
│                            ↓                                 │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Phase 2: Configuration                                  │ │
│  │  - Update wrangler.toml with Pulumi outputs            │ │
│  │  - Generate security keys if needed                     │ │
│  └─────────────────────────────────────────────────────────┘ │
│                            ↓                                 │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Phase 3: Application Deployment (Wrangler)              │ │
│  │  - wrangler deploy (API Worker)                         │ │
│  │  - wrangler pages deploy (Web UI)                       │ │
│  │  - wrangler d1 migrations apply                         │ │
│  │  - wrangler secret put (all secrets)                    │ │
│  └─────────────────────────────────────────────────────────┘ │
│                            ↓                                 │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Phase 4: VM Agent & Validation                          │ │
│  │  - Build VM Agent binaries                              │ │
│  │  - Upload to R2                                         │ │
│  │  - Health check endpoints                               │ │
│  │  - Output deployment URLs                               │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Risk Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| R2 S3 compatibility | Low | High | Test with `pulumi preview` first |
| Pulumi provider bugs | Low | Medium | Pin exact version, monitor releases |
| State encryption issues | Medium | High | Document passphrase in setup guide |
| wrangler.toml parsing | Low | Medium | Use TOML library with round-trip support |
| Partial deployment | Medium | Medium | Track state, support resume |

## Conclusion

The Pulumi + Wrangler hybrid approach provides:
- **Proper state management** via Pulumi state in R2
- **Drift detection** via `pulumi preview`
- **Idempotent deployments** via Pulumi's reconciliation
- **Worker-aware deployment** via Wrangler
- **Self-hosted** without external dependencies (no Pulumi Cloud)

This replaces the brittle custom API approach with industry-standard IaC tooling while maintaining the single-action deployment experience.
