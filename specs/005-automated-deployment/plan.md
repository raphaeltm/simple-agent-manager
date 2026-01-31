# Implementation Plan: Automated Self-Hosting Deployment

**Branch**: `005-automated-deployment` | **Date**: 2026-01-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification with Pulumi + Wrangler hybrid approach

## Summary

Replace brittle custom Cloudflare API deployment with a **Pulumi + Wrangler hybrid approach**:
- **Pulumi** provisions infrastructure (D1, KV, R2, DNS) with proper state management stored in Cloudflare R2
- **Wrangler** deploys applications (Workers, Pages) and handles migrations/secrets
- Single GitHub Action triggers complete deployment; another handles teardown

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js 20+)
**Primary Dependencies**: `@pulumi/pulumi`, `@pulumi/cloudflare`, `wrangler`, `@iarna/toml`
**Storage**: Cloudflare R2 (Pulumi state), D1 (app data), KV (sessions)
**Testing**: Vitest with `pulumi.runtime.setMocks()` for infrastructure tests
**Target Platform**: GitHub Actions → Cloudflare (Workers, Pages, D1, KV, R2)
**Project Type**: Monorepo with new `infra/` directory for Pulumi code
**Performance Goals**: Deployment completes in under 10 minutes
**Constraints**: Self-hosted only (no Pulumi Cloud), R2 state bucket created manually
**Scale/Scope**: Single production environment (multi-env is out of scope)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source Sustainability | ✅ PASS | Pulumi + Wrangler are OSS; no proprietary lock-in |
| II. Infrastructure Stability | ✅ PASS | TDD for Pulumi code; tests with mocks |
| III. Documentation Excellence | ✅ PASS | Self-hosting guide updated; quickstart added |
| IV. Approachable Code & UX | ✅ PASS | Single-action deployment; clear error messages |
| V. Transparent Roadmap | ✅ PASS | Feature spec in /specs/ |
| VI. Automated Quality Gates | ✅ PASS | CI runs Pulumi tests; linting enforced |
| VII. Inclusive Contribution | ✅ PASS | Clear setup docs for contributors |
| VIII. AI-Friendly Repository | ✅ PASS | infra/ follows predictable patterns |
| IX. Clean Code Architecture | ✅ PASS | infra/ separate from apps/packages |
| X. Simplicity & Clarity | ✅ PASS | Uses official SDKs (@pulumi/cloudflare); justified new deps |
| IaC Tooling Strategy | ✅ PASS | Pulumi for infra, Wrangler for deployment per constitution |

## Project Structure

### Documentation (this feature)

```text
specs/005-automated-deployment/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Research findings
├── data-model.md        # Pulumi resource definitions
├── quickstart.md        # User deployment guide
├── contracts/           # API contracts (GitHub workflow inputs/outputs)
└── tasks.md             # Implementation tasks (Phase 2)
```

### Source Code (repository root)

```text
infra/                          # NEW: Pulumi infrastructure project
├── Pulumi.yaml                 # Project definition
├── Pulumi.prod.yaml            # Production stack config
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript config
├── index.ts                    # Entry point - exports all resources
├── resources/
│   ├── database.ts             # D1 database resource
│   ├── kv.ts                   # KV namespace resource
│   ├── storage.ts              # R2 bucket resource
│   └── dns.ts                  # DNS records
└── __tests__/
    └── index.test.ts           # Unit tests with mocks

scripts/deploy/                 # MODIFY: Update existing scripts
├── sync-wrangler-config.ts     # NEW: Sync Pulumi outputs to wrangler.toml
└── ... (keep existing scripts for local dev)

.github/workflows/
├── deploy-setup.yml            # MODIFY: Use Pulumi for provisioning
└── teardown-setup.yml          # MODIFY: Use Pulumi destroy

apps/api/wrangler.toml          # MODIFY: Production env uses Pulumi outputs
```

**Structure Decision**: Add new `infra/` directory for Pulumi code per constitution IaC guidelines. Keep monorepo structure with apps/, packages/, scripts/.

## Complexity Tracking

No violations requiring justification. The design follows constitution guidelines:
- Uses official SDKs (Pulumi, Wrangler) per Principle X
- Follows IaC Tooling Strategy (Pulumi for infra, Wrangler for deploy)
- Single new directory (`infra/`) with clear purpose

---

## Phase 0: Research Complete

See [research.md](./research.md) for detailed findings on:
- RQ-1: @pulumi/cloudflare resource support (D1, KV, R2, DNS)
- RQ-2: Pulumi project structure best practices
- RQ-3: Unit testing Pulumi with setMocks()
- RQ-4: R2 as Pulumi state backend configuration
- RQ-5: GitHub Actions + Pulumi integration
- RQ-6: Passing Pulumi outputs to Wrangler
- RQ-7: Pulumi + Wrangler division of responsibility
- RQ-8: Cloudflare API token permissions

---

## Phase 1: Design Artifacts

### 1.1 Data Model (Pulumi Resources)

See [data-model.md](./data-model.md) for complete Pulumi resource definitions.

**Summary of Resources**:

| Resource | Pulumi Type | Binding Name | Purpose |
|----------|-------------|--------------|---------|
| D1 Database | `cloudflare.D1Database` | `DATABASE` | Workspace metadata |
| KV Namespace | `cloudflare.WorkersKvNamespace` | `KV` | Sessions, tokens |
| R2 Bucket | `cloudflare.R2Bucket` | `R2` | VM Agent binaries |
| DNS Record (API) | `cloudflare.DnsRecord` | - | api.{domain} |
| DNS Record (App) | `cloudflare.DnsRecord` | - | app.{domain} |
| DNS Record (Wildcard) | `cloudflare.DnsRecord` | - | *.{domain} |

### 1.2 Contracts (Workflow I/O)

See [contracts/](./contracts/) for GitHub Actions workflow interfaces.

**Deploy Workflow Inputs**:
- `hostname` (required): Full hostname (e.g., `app.example.com`)
- `environment` (optional, default: `production`): Target environment

**Deploy Workflow Secrets**:
- `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- `PULUMI_CONFIG_PASSPHRASE`
- Optional: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`

**Deploy Workflow Outputs**:
- `api_url`: Deployed API URL
- `app_url`: Deployed Web UI URL
- `deployment_id`: Pulumi deployment identifier

### 1.3 Quickstart

See [quickstart.md](./quickstart.md) for user-facing deployment guide.

**Prerequisites** (one-time):
1. Cloudflare account with domain
2. Create R2 bucket for Pulumi state
3. Create R2 API token
4. Fork repository and configure secrets

**Deployment**:
1. Run "Deploy" GitHub Action
2. Wait for completion (~10 minutes)
3. Access deployed URLs from workflow output

---

## Phase 2: Implementation Tasks

> Generated by `/speckit.tasks` command (not this plan)

Key implementation areas:
1. Create `infra/` Pulumi project
2. Implement resource modules (database, kv, storage, dns)
3. Add Pulumi tests with mocks
4. Create sync-wrangler-config.ts script
5. Update GitHub Actions workflows
6. Update self-hosting documentation
7. Clean up old custom API code

---

## Deployment Flow Diagram

```
User Prerequisites (Manual, One-Time)
├── Create R2 bucket: sam-pulumi-state
├── Create R2 API token
├── Generate PULUMI_CONFIG_PASSPHRASE
└── Configure GitHub secrets (6 required)

GitHub Action: Deploy
├── Phase 1: Infrastructure (Pulumi)
│   ├── pulumi login 's3://sam-pulumi-state?endpoint=...'
│   ├── pulumi stack select prod (or init)
│   ├── pulumi up --yes
│   └── Export: D1_ID, KV_ID, R2_NAME, DNS records created
│
├── Phase 2: Configuration
│   ├── sync-wrangler-config.ts (update wrangler.toml)
│   └── Generate JWT keys if not provided
│
├── Phase 3: Application (Wrangler)
│   ├── wrangler deploy --env production (API)
│   ├── wrangler pages deploy (Web)
│   ├── wrangler d1 migrations apply
│   └── wrangler secret put (all secrets)
│
├── Phase 4: VM Agent
│   ├── Build: make -C packages/vm-agent build-all
│   └── Upload: wrangler r2 object put (binaries)
│
└── Phase 5: Validation
    ├── Health check: GET /health
    └── Output: api_url, app_url

GitHub Action: Teardown
├── pulumi login 's3://sam-pulumi-state?endpoint=...'
├── pulumi destroy --yes
└── Note: State bucket NOT deleted (user manages)
```

---

## Risk Mitigations

| Risk | Mitigation | Owner |
|------|------------|-------|
| R2 S3 compatibility | Test with `pulumi preview` in CI | Implementation |
| State bucket missing | Preflight check in workflow | Implementation |
| Passphrase forgotten | Document in quickstart; suggest password manager | Documentation |
| Partial deployment | Pulumi state tracks progress; re-run is safe | Architecture |
| wrangler.toml corruption | TOML library with round-trip support | Implementation |

---

## Success Criteria Mapping

| Criterion | Implementation |
|-----------|----------------|
| SC-001: 1 bucket + 6 secrets + 1 action | Workflow design matches |
| SC-002: Under 10 minutes | Parallel builds where possible |
| SC-003: Re-run without errors | Pulumi idempotency |
| SC-004: Teardown allows fresh deploy | `pulumi destroy` cleans state |
| SC-005: Single-page docs | quickstart.md |
| SC-006: Zero CLI commands | All in GitHub Action |
| SC-007: Clear progress | Pulumi output in workflow logs |
| SC-008: Drift detection | `pulumi preview` available |

---

## Post-Implementation Checklist

- [ ] `infra/` directory created with all resources
- [ ] Unit tests passing with mocks
- [ ] GitHub workflows updated
- [ ] wrangler.toml production env uses dynamic IDs
- [ ] quickstart.md complete
- [ ] Old custom API code removed from scripts/deploy/
- [ ] Constitution compliance verified
- [ ] End-to-end test on fresh Cloudflare account
