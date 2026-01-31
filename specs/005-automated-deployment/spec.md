# Feature Specification: Automated Self-Hosting Deployment

**Feature Branch**: `005-automated-deployment`
**Created**: 2026-01-29
**Status**: Draft (Revised)
**Input**: User description: "Streamline self-hosting to: setup Cloudflare account with domain, get API key, configure GitHub secrets, run one GitHub Action to deploy everything, run another to tear down. No manual wrangler commands, no manual resource creation."

## Problem Statement

The current self-hosting process requires 15+ manual steps across multiple platforms:
- Manual creation of D1 database, KV namespace, and R2 bucket via CLI
- Manual editing of wrangler.toml with resource IDs
- Manual execution of deploy commands
- Manual DNS record configuration
- Manual secret generation and configuration

The initial implementation attempted to solve this with custom TypeScript code calling Cloudflare REST APIs directly. This approach is **brittle** because:
- No state management (relies on name-based lookups)
- No drift detection
- Manual API maintenance burden
- Regex-based wrangler.toml manipulation

The solution uses a **Pulumi + Wrangler hybrid approach**:
- **Pulumi** provisions infrastructure (D1, KV, R2, DNS) with proper state management
- **Wrangler** deploys applications (Workers, Pages) and runs migrations
- State stored in Cloudflare R2 (self-hosted, no Pulumi Cloud dependency)

The process should be: fork repo → create state bucket → configure secrets → run action → done.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - First-Time Deployment (Priority: P1)

A developer wants to deploy SAM to their own Cloudflare account. They have a Cloudflare account with a domain already configured and want to get SAM running without executing any CLI commands manually.

**Why this priority**: This is the core value proposition - enabling self-hosting without DevOps expertise or manual infrastructure management.

**Independent Test**: Can be fully tested by forking the repository, creating the state bucket, configuring GitHub secrets, and running the deploy workflow. Delivers a fully functional SAM instance.

**Acceptance Scenarios**:

1. **Given** a user has forked the SAM repository, created an R2 state bucket, and configured required GitHub secrets,
   **When** they run the "Deploy" GitHub Action with their hostname,
   **Then** all Cloudflare resources (D1, KV, R2, Worker, Pages) are provisioned and deployed automatically.

2. **Given** a user runs the Deploy action,
   **When** deployment completes successfully,
   **Then** the user receives output URLs (app URL, API URL) and can immediately access the web interface.

3. **Given** a user has provided a valid Cloudflare API token,
   **When** the Deploy action runs,
   **Then** DNS records are automatically created for the specified hostname.

---

### User Story 2 - Re-Running Deployment (Priority: P1)

A developer needs to re-run the deployment action (after a failed run, after code updates, or to verify idempotency). The action should succeed without errors or duplicate resources.

**Why this priority**: Robustness and re-runnability are essential for production use and CI/CD workflows.

**Independent Test**: Can be tested by running the Deploy action twice in succession. Second run should complete without errors and without creating duplicate resources.

**Acceptance Scenarios**:

1. **Given** a deployment was previously completed (or partially completed),
   **When** the user runs the Deploy action again,
   **Then** Pulumi detects existing state and performs only necessary updates.

2. **Given** a deployment failed midway (e.g., DNS creation succeeded but Pages failed),
   **When** the user fixes the issue and re-runs Deploy,
   **Then** Pulumi resumes from the recorded state without recreating successful resources.

3. **Given** infrastructure has drifted (manual changes in Cloudflare dashboard),
   **When** the user runs Deploy,
   **Then** Pulumi detects drift and reconciles to match the declared state.

---

### User Story 3 - Clean Teardown (Priority: P2)

A developer wants to completely remove their SAM deployment, either to start fresh or because they no longer need the platform. All resources should be deleted cleanly.

**Why this priority**: Essential for cost management and clean slate reinstallation, but less frequently used than deployment.

**Independent Test**: Can be tested by running Teardown after a successful Deploy. All resources should be removed and Cloudflare dashboard should show no SAM-related resources.

**Acceptance Scenarios**:

1. **Given** a SAM deployment exists,
   **When** the user runs the "Teardown" GitHub Action,
   **Then** Pulumi destroys all managed resources (D1, KV, R2, Worker, Pages, DNS records).

2. **Given** a partial deployment exists (some resources created, others not),
   **When** the user runs Teardown,
   **Then** Pulumi destroys only the resources in its state, without errors.

3. **Given** teardown has been completed,
   **When** the user runs Deploy again,
   **Then** a fresh deployment is created successfully (state bucket persists).

---

### User Story 4 - GitHub App Configuration (Priority: P2)

A developer needs to set up GitHub App integration for repository access. While some manual GitHub steps are unavoidable (GitHub doesn't allow programmatic App creation), the process should be clearly guided.

**Why this priority**: Required for full functionality but involves external platform (GitHub) that cannot be fully automated.

**Independent Test**: Can be tested by following the guided setup after deployment. GitHub App should successfully authenticate and list repositories.

**Acceptance Scenarios**:

1. **Given** deployment has completed,
   **When** the user follows the GitHub App setup guide,
   **Then** they can create and configure a GitHub App with clear instructions for each field.

2. **Given** a user has created a GitHub App,
   **When** they add the App credentials to GitHub secrets and re-run Deploy,
   **Then** the app is configured and GitHub authentication works.

---

### Edge Cases

- What happens when the Cloudflare API token lacks required permissions?
  - Pulumi fails early with a clear error from the Cloudflare provider.

- What happens when the R2 state bucket doesn't exist?
  - Pulumi login fails with a clear error explaining the prerequisite.

- What happens when the hostname is already in use by another Cloudflare resource?
  - Pulumi detects the conflict and provides guidance via provider error.

- What happens when DNS propagation is slow?
  - Action completes successfully; user is informed that DNS may take up to 24 hours.

- What happens when deployment is interrupted (user cancels, network failure)?
  - Pulumi state captures progress; subsequent runs continue from last known state.

- What happens when the user's Cloudflare account hits resource limits?
  - Pulumi fails with a clear error from the Cloudflare provider indicating the limit.

- What happens when PULUMI_CONFIG_PASSPHRASE is wrong on re-run?
  - Pulumi fails to decrypt state with a clear authentication error.

## Requirements *(mandatory)*

### Functional Requirements

**Prerequisites (Manual One-Time Setup):**

- **FR-001**: User MUST create an R2 bucket for Pulumi state storage before first deployment.
- **FR-002**: User MUST create R2 API credentials (Access Key ID, Secret Access Key) for Pulumi backend access.
- **FR-003**: User MUST generate a passphrase for Pulumi state encryption.

**Deployment Workflow:**

- **FR-004**: System MUST provide a GitHub Actions workflow that deploys all SAM components with a single manual trigger.
- **FR-005**: System MUST use Pulumi with `@pulumi/cloudflare` provider to provision infrastructure resources.
- **FR-006**: System MUST use Cloudflare R2 as Pulumi state backend (S3-compatible).
- **FR-007**: System MUST provision Cloudflare D1 database via Pulumi.
- **FR-008**: System MUST provision Cloudflare KV namespace via Pulumi.
- **FR-009**: System MUST provision Cloudflare R2 bucket (for VM agent binaries) via Pulumi.
- **FR-010**: System MUST create required DNS records via Pulumi.
- **FR-011**: System MUST deploy the API Worker via Wrangler after Pulumi provisioning.
- **FR-012**: System MUST deploy the Web UI to Cloudflare Pages via Wrangler.
- **FR-013**: System MUST generate security keys (JWT key pair, encryption key) if not provided.
- **FR-014**: System MUST configure all Worker secrets via Wrangler.
- **FR-015**: System MUST build and upload VM Agent binaries to R2.
- **FR-016**: System MUST run database migrations via Wrangler.

**Teardown Workflow:**

- **FR-017**: System MUST provide a GitHub Actions workflow that removes all SAM components with a single manual trigger.
- **FR-018**: System MUST use `pulumi destroy` to remove all managed infrastructure.
- **FR-019**: Teardown MUST NOT delete the Pulumi state bucket (user manages this separately).

**Idempotency & State Management:**

- **FR-020**: Pulumi MUST track all provisioned resources in state stored in R2.
- **FR-021**: Re-running Deploy MUST detect existing resources and perform incremental updates only.
- **FR-022**: Pulumi MUST detect and report infrastructure drift.
- **FR-023**: State MUST be encrypted using PULUMI_CONFIG_PASSPHRASE.

**Configuration:**

- **FR-024**: System MUST accept hostname as a workflow input (e.g., `app.example.com`).
- **FR-025**: System MUST accept Cloudflare credentials via GitHub secrets.
- **FR-026**: System MUST accept R2 backend credentials via GitHub secrets.
- **FR-027**: System MUST accept optional GitHub App credentials via GitHub secrets.
- **FR-028**: System MUST provide clear output of deployed URLs upon successful deployment.

**Error Handling:**

- **FR-029**: System MUST validate prerequisites (state bucket accessible, token permissions) before deployment.
- **FR-030**: System MUST provide clear, actionable error messages leveraging Pulumi/Wrangler output.
- **FR-031**: System MUST fail fast on configuration errors rather than partially deploying.

### Configuration Inputs

**Required GitHub Secrets:**

| Secret                    | Description                                              |
|---------------------------|----------------------------------------------------------|
| `CF_API_TOKEN`            | Cloudflare API token with required permissions           |
| `CF_ACCOUNT_ID`           | Cloudflare account ID                                    |
| `CF_ZONE_ID`              | Cloudflare zone ID for the domain                        |
| `R2_ACCESS_KEY_ID`        | R2 API access key for Pulumi state bucket                |
| `R2_SECRET_ACCESS_KEY`    | R2 API secret key for Pulumi state bucket                |
| `PULUMI_CONFIG_PASSPHRASE`| Passphrase for encrypting Pulumi state secrets           |

**Required GitHub Variables (or Workflow Inputs):**

| Variable            | Description                                              |
|---------------------|----------------------------------------------------------|
| `HOSTNAME`          | Full hostname for deployment (e.g., `app.example.com`)   |
| `PULUMI_STATE_BUCKET` | Name of R2 bucket for Pulumi state (e.g., `sam-pulumi-state`) |

**Optional GitHub Secrets (for full functionality):**

| Secret                    | Description                              |
|---------------------------|------------------------------------------|
| `GITHUB_APP_ID`           | GitHub App ID for repository access      |
| `GITHUB_APP_PRIVATE_KEY`  | GitHub App private key (base64 encoded)  |

### Key Entities

- **Deployment**: Represents a complete SAM installation with associated Cloudflare resources.
- **Pulumi Stack**: The infrastructure state for a deployment, stored in R2.
- **Cloudflare Resources**: D1 database, KV namespace, R2 bucket, Worker, Pages project (managed by Pulumi).
- **DNS Configuration**: API record, App record, wildcard record for workspaces (managed by Pulumi).
- **Security Keys**: JWT key pair for terminal authentication, encryption key for credential storage.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can deploy SAM by creating 1 state bucket, configuring 6 required secrets, and running one workflow action.
- **SC-002**: Total deployment time is under 10 minutes from workflow start to accessible application.
- **SC-003**: Re-running Deploy on existing infrastructure completes without errors 100% of the time (Pulumi idempotency).
- **SC-004**: Teardown removes all Pulumi-managed resources, allowing a fresh Deploy to succeed immediately after.
- **SC-005**: Self-hosting documentation fits on a single page with fewer than 10 manual steps.
- **SC-006**: Zero manual CLI commands required by the user during deployment (after initial state bucket setup).
- **SC-007**: Deployment workflow provides clear progress indicators via Pulumi output.
- **SC-008**: Infrastructure drift is detectable by running `pulumi preview` in CI.

## Scope

### In Scope

- GitHub Actions workflows for deploy and teardown
- Pulumi infrastructure code for Cloudflare resources (TypeScript)
- Pulumi state management via Cloudflare R2 backend
- Automatic Cloudflare resource provisioning (D1, KV, R2, DNS) via Pulumi
- Automatic Worker and Pages deployment via Wrangler
- Automatic security key generation
- Automatic VM Agent binary build and upload
- Database migration execution via Wrangler
- Idempotent operations via Pulumi state
- Clear error messages from Pulumi/Wrangler
- Documentation for one-time state bucket setup

### Out of Scope

- Multi-environment support (staging + production) - future enhancement
- Alternative cloud providers (AWS, Azure) - future enhancement
- Pulumi Cloud backend (using self-hosted R2 instead)
- Local development setup automation (existing scripts sufficient)
- GitHub App programmatic creation (GitHub limitation)
- Automatic Cloudflare account creation
- Automatic domain purchase/registration
- Automatic R2 state bucket creation (intentional manual prerequisite)

## Assumptions

- Users have a Cloudflare account on free tier or higher
- Users have a domain already added to Cloudflare with nameservers configured
- Users know how to create API tokens in Cloudflare dashboard
- Users can create an R2 bucket and R2 API token (documented prerequisite)
- Users know how to configure GitHub repository secrets
- Pulumi Cloudflare provider is stable and production-ready
- R2 S3-compatible API works reliably as Pulumi backend
- GitHub Actions has sufficient permissions to run Pulumi and Wrangler commands
- Users accept that GitHub App setup requires some manual steps (platform limitation)

## Dependencies

- **Pulumi CLI** (v3.x+) - infrastructure provisioning
- **@pulumi/cloudflare** - Cloudflare provider for Pulumi
- **Wrangler CLI** (v3.x+) - Worker/Pages deployment, migrations, secrets
- **cloudflare** npm package - official TypeScript SDK (if direct API calls needed)
- **Cloudflare R2** - S3-compatible state storage for Pulumi
- **GitHub Actions runners** - with Node.js and Go support

## Risks

| Risk                                               | Likelihood | Impact | Mitigation                                                        |
|----------------------------------------------------|------------|--------|-------------------------------------------------------------------|
| R2 S3-compatibility issues with Pulumi             | Low        | High   | Test extensively; R2 S3 API is well-documented                    |
| Pulumi Cloudflare provider bugs                    | Low        | Medium | Pin provider version; monitor releases; report issues upstream    |
| State bucket access issues                         | Low        | High   | Clear prerequisite documentation; preflight validation            |
| PULUMI_CONFIG_PASSPHRASE lost by user              | Medium     | High   | Document passphrase importance; suggest password manager          |
| Cloudflare API rate limits during deployment       | Low        | Medium | Pulumi handles retries; configure backoff if needed               |
| GitHub Actions runner resource constraints for Go  | Low        | Medium | Pre-build VM Agent binaries in CI; cache dependencies             |
| DNS propagation delays cause confusion             | Medium     | Low    | Clear documentation that DNS may take 24 hours                    |

## Technical Notes

### Pulumi + Wrangler Division of Responsibility

This architecture follows industry best practices for Cloudflare deployments:

| Tool    | Responsibility                                           |
|---------|----------------------------------------------------------|
| Pulumi  | Create/manage D1, KV, R2, DNS records (infrastructure)   |
| Wrangler| Deploy Workers, Pages, run migrations, set secrets (app) |

**Rationale:**
- Pulumi provides proper state management, drift detection, and idempotency
- Wrangler understands Worker internals and deployment nuances
- This split is [recommended by practitioners](https://developers.cloudflare.com/pulumi/tutorial/dynamic-provider-and-wrangler/)

### Pulumi State Backend Configuration

```bash
# Login to R2 backend
pulumi login 's3://<bucket>?endpoint=<account_id>.r2.cloudflarestorage.com'

# Environment variables required
export AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY
export PULUMI_CONFIG_PASSPHRASE=$PULUMI_CONFIG_PASSPHRASE
```

### Official SDK Usage

Per constitution principle X (Simplicity & Clarity), all Cloudflare API interactions use official SDKs:
- Infrastructure: `@pulumi/cloudflare` provider
- Direct API (if needed): `cloudflare` npm package
- Deployment: Wrangler CLI
