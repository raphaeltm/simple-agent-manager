# Feature Specification: Browser Terminal SaaS MVP

**Feature Branch**: `003-browser-terminal-saas`
**Created**: 2026-01-26
**Status**: Draft
**Input**: User description: "Browser Terminal SaaS MVP - Multi-tenant cloud workspaces with GitHub OAuth, Hetzner VMs, and browser-based terminal access"

## Overview

A multi-tenant SaaS platform where developers can spin up cloud-based AI coding environments on-demand. Users authenticate via GitHub, connect their own Hetzner Cloud account, and create workspaces that run in VMs with browser-based terminal access. Workspaces automatically terminate when idle to minimize costs.

**Key Design Principles**:
1. **Users bring their own cloud** - VMs run on user's Hetzner account (they pay Hetzner directly)
2. **Proper auth from day 1** - GitHub OAuth for authentication, GitHub App for repository access
3. **Browser-based terminal** - Single Go binary VM Agent serves embedded terminal UI
4. **Easy deploy/teardown** - Single commands to deploy or destroy the entire platform

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign In with GitHub (Priority: P1)

A new user visits the platform and signs in using their GitHub account. After authentication, they see their dashboard where they can manage their account and workspaces.

**Why this priority**: Authentication is foundational - nothing else works without it. This establishes user identity and enables all subsequent features.

**Independent Test**: User can complete GitHub OAuth flow and land on an authenticated dashboard showing their GitHub profile information.

**Acceptance Scenarios**:

1. **Given** an unauthenticated user on the landing page, **When** they click "Sign in with GitHub", **Then** they are redirected to GitHub's OAuth consent screen
2. **Given** the user approves the OAuth request, **When** GitHub redirects back, **Then** the user sees their dashboard with their GitHub avatar and username displayed
3. **Given** a user is already authenticated, **When** they return to the site, **Then** their session is restored and they go directly to the dashboard
4. **Given** a user on the dashboard, **When** they click "Sign Out", **Then** their session is cleared and they return to the landing page

---

### User Story 2 - Connect Hetzner Cloud Account (Priority: P2)

An authenticated user navigates to Settings and adds their Hetzner Cloud API token. The platform validates the token and securely stores it for workspace provisioning.

**Why this priority**: Without cloud credentials, users cannot create workspaces. This unlocks the core value proposition.

**Independent Test**: User can add their Hetzner API token, see confirmation that it's connected, and view their Hetzner account status (e.g., server locations available).

**Acceptance Scenarios**:

1. **Given** an authenticated user on the Settings page, **When** they enter a valid Hetzner API token and click "Connect", **Then** the token is validated against Hetzner's API and stored securely
2. **Given** a user enters an invalid or expired token, **When** they click "Connect", **Then** they see a clear error message explaining the issue
3. **Given** a user has connected their Hetzner account, **When** they view Settings, **Then** they see their account status (connected, available locations)
4. **Given** a user wants to update their token, **When** they enter a new token, **Then** the old token is replaced and the new one is validated

---

### User Story 3 - Install GitHub App for Repository Access (Priority: P3)

A user installs the platform's GitHub App on their personal account or organization to grant repository access. This enables the platform to clone repositories into workspaces.

**Why this priority**: Repository access is required to create useful workspaces. The GitHub App approach provides secure, scoped access without requiring users to share PATs.

**Independent Test**: User can install the GitHub App, return to the platform, and see a list of repositories they've granted access to.

**Acceptance Scenarios**:

1. **Given** a user without the GitHub App installed, **When** they attempt to create a workspace, **Then** they are prompted to install the GitHub App first
2. **Given** the user clicks "Install GitHub App", **When** they complete installation on GitHub, **Then** they are redirected back to the platform
3. **Given** the GitHub App is installed, **When** the user views the "Create Workspace" page, **Then** they see a list of repositories they can access
4. **Given** the user has installed the app on multiple organizations, **When** they view repositories, **Then** they can filter by organization

---

### User Story 4 - Create a Workspace (Priority: P4)

A user creates a new workspace by selecting a repository, branch, VM size, and location. The platform provisions a VM, clones the repository, and notifies the user when ready.

**Why this priority**: This is the core product functionality. All previous stories enable this one.

**Independent Test**: User can create a workspace, see it transition through provisioning states, and receive notification when it's ready.

**Acceptance Scenarios**:

1. **Given** a user with Hetzner connected and GitHub App installed, **When** they click "Create Workspace", **Then** they see a form to select repository, branch, VM size, and location
2. **Given** the user submits the workspace form, **When** provisioning begins, **Then** they see the workspace in "Creating" status on their dashboard
3. **Given** a workspace is provisioning, **When** the VM is ready and the repository is cloned, **Then** the workspace status changes to "Running" and the user can access it
4. **Given** provisioning fails (e.g., Hetzner API error), **When** the error is detected, **Then** the workspace shows "Error" status with an actionable error message
5. **Given** a user has multiple workspaces, **When** they view the dashboard, **Then** they see all workspaces with their current status, repository, and last activity time

---

### User Story 5 - Access Terminal in Browser (Priority: P5)

A user opens the terminal for a running workspace. The platform authenticates them via JWT and connects them to the VM Agent, which displays an interactive terminal in the browser.

**Why this priority**: This is how users interact with their workspaces. The terminal is the primary interface for AI coding work.

**Independent Test**: User can click "Open Terminal" on a running workspace and execute commands in the browser-based terminal.

**Acceptance Scenarios**:

1. **Given** a user with a running workspace, **When** they click "Open Terminal", **Then** a new browser tab opens with the terminal interface
2. **Given** the terminal is connecting, **When** authentication succeeds, **Then** the terminal displays a shell prompt inside the devcontainer
3. **Given** the terminal is connected, **When** the user types commands, **Then** they see real-time output in the terminal
4. **Given** the user resizes the browser window, **When** the terminal reflows, **Then** the terminal dimensions adjust accordingly
5. **Given** the user closes the terminal tab, **When** they reopen it, **Then** they get a new terminal session (previous session is not preserved)
6. **Given** the workspace is not running, **When** the user tries to open the terminal, **Then** they see a message indicating the workspace must be started first

---

### User Story 6 - Automatic Idle Shutdown (Priority: P6)

A workspace that has been idle (no terminal activity) for a configurable period automatically shuts down to save costs. The user receives notification before shutdown.

**Why this priority**: Cost control is essential for user trust. Users should not be surprised by unexpected cloud bills.

**Independent Test**: Leave a workspace idle beyond the threshold and verify it transitions to "Stopped" status.

**Acceptance Scenarios**:

1. **Given** a running workspace with no terminal activity, **When** 25 minutes have passed (5 minutes before threshold), **Then** the terminal displays a warning about impending shutdown
2. **Given** the warning is displayed, **When** the user performs any terminal activity, **Then** the idle timer resets
3. **Given** no activity occurs after the warning, **When** 30 minutes of idle time pass, **Then** the workspace shuts down automatically
4. **Given** a workspace auto-shuts down, **When** the user views the dashboard, **Then** they see the workspace in "Stopped" status with "Idle timeout" as the reason

---

### User Story 7 - Manual Workspace Management (Priority: P7)

A user can manually stop, restart, or delete workspaces from their dashboard.

**Why this priority**: Users need control over their workspaces beyond automatic behavior.

**Independent Test**: User can stop a running workspace and see it transition to "Stopped" status.

**Acceptance Scenarios**:

1. **Given** a running workspace, **When** the user clicks "Stop", **Then** the workspace transitions to "Stopping" and then "Stopped"
2. **Given** a stopped workspace, **When** the user clicks "Delete", **Then** they are asked to confirm, and the workspace is removed from their account
3. **Given** a stopped workspace, **When** the user clicks "Restart", **Then** a new VM is provisioned with the same configuration
4. **Given** a workspace in "Error" status, **When** the user clicks "Delete", **Then** any orphaned resources are cleaned up

---

### Edge Cases

- **GitHub App uninstalled**: If a user uninstalls the GitHub App after creating workspaces, existing workspaces continue to work but new workspaces cannot be created for those repos.
- **Hetzner token revoked**: If a user revokes their Hetzner token, running workspaces continue until stopped, but new workspaces cannot be created.
- **Hetzner rate limits**: If Hetzner API rate limits are hit during provisioning, the system retries with exponential backoff.
- **VM fails to start**: If cloud-init fails or the VM Agent doesn't start, the system marks the workspace as "Error" and provides debug information.
- **Multiple browser tabs**: Opening the terminal in multiple tabs creates separate sessions; they do not share state.
- **Network interruption**: If the WebSocket connection drops, the terminal attempts to reconnect automatically.
- **Workspace quota**: Users have a maximum number of concurrent workspaces (to prevent abuse).

## Requirements *(mandatory)*

### Functional Requirements

**Authentication & Authorization**:
- **FR-001**: System MUST authenticate users via GitHub OAuth using the BetterAuth library
- **FR-002**: System MUST support session persistence so users remain logged in across browser sessions
- **FR-003**: System MUST provide a GitHub App that users install to grant repository access
- **FR-004**: System MUST be able to list repositories the user has granted access to via the GitHub App
- **FR-005**: System MUST generate GitHub App installation access tokens for git operations

**Cloud Credentials**:
- **FR-006**: System MUST allow users to add their Hetzner Cloud API token
- **FR-007**: System MUST encrypt Hetzner tokens using AES-GCM before storing in the database
- **FR-008**: System MUST validate Hetzner tokens against the Hetzner API before accepting them
- **FR-009**: System MUST allow users to update or remove their Hetzner token at any time

**Workspace Provisioning**:
- **FR-010**: System MUST create Hetzner VMs using the user's own Hetzner API token
- **FR-011**: System MUST pass cloud-init configuration to bootstrap VMs with Docker, devcontainer CLI, and VM Agent
- **FR-012**: System MUST create Cloudflare DNS records pointing workspace subdomains to VM IPs
- **FR-013**: System MUST clone the selected repository into the workspace using GitHub App installation tokens
- **FR-014**: System MUST track workspace status (Creating, Running, Stopping, Stopped, Error)
- **FR-015**: System MUST provide VM size options (small, medium, large) corresponding to Hetzner server types

**Terminal Access**:
- **FR-016**: System MUST issue short-lived JWTs for terminal authentication
- **FR-017**: System MUST expose a JWKS endpoint for VM Agents to validate JWTs
- **FR-018**: VM Agent MUST serve an embedded web UI with terminal functionality
- **FR-019**: VM Agent MUST handle PTY sessions and WebSocket communication
- **FR-020**: VM Agent MUST execute shells inside the devcontainer (not on the host)

**Idle Detection & Lifecycle**:
- **FR-021**: VM Agent MUST track terminal activity and report idle status
- **FR-022**: System MUST warn users 5 minutes before idle shutdown
- **FR-023**: System MUST automatically stop workspaces after configurable idle period (default: 30 minutes)
- **FR-024**: System MUST clean up DNS records when workspaces are stopped or deleted
- **FR-025**: System MUST clean up Hetzner VMs when workspaces are stopped or deleted

**Self-Contained Deployment**:
- **FR-026**: Control plane MUST serve VM Agent binaries (not rely on external sources like GitHub)
- **FR-027**: VM Agent version served MUST match the control plane version
- **FR-028**: Cloud-init scripts MUST download VM Agent from the control plane URL

**Developer Experience**:
- **FR-029**: System MUST provide a single command to deploy all infrastructure to staging
- **FR-030**: System MUST provide a single command to deploy all infrastructure to production
- **FR-031**: System MUST provide a single command to tear down all infrastructure (with confirmation)
- **FR-032**: System MUST provide an interactive first-time setup script that configures secrets and creates resources
- **FR-033**: System MUST provide clear documentation for all setup and deployment procedures

### Key Entities

- **User**: Represents an authenticated user with GitHub profile information (id, email, name, avatar URL). Created upon first GitHub OAuth login.

- **Credential**: Stores encrypted cloud provider credentials linked to a user. Contains: user reference, provider type (hetzner), encrypted token, initialization vector for decryption.

- **GitHubInstallation**: Tracks GitHub App installations for a user. Contains: user reference, installation ID, account type (personal/organization), account name.

- **Workspace**: Represents a cloud coding environment. Contains: user reference, name, repository URL, branch, status, VM ID (from Hetzner), VM IP address, DNS record ID (from Cloudflare), created/updated timestamps, last activity timestamp.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: New users can complete sign-in and connect their Hetzner account in under 5 minutes
- **SC-002**: Workspace provisioning completes in under 4 minutes from request to "Running" status
- **SC-003**: Terminal connects and displays first prompt within 3 seconds of opening
- **SC-004**: Terminal input latency is under 100 milliseconds for typical commands
- **SC-005**: System supports at least 10 concurrent workspaces per user without degradation
- **SC-006**: Idle shutdown triggers within 5 minutes after the configured idle threshold is reached
- **SC-007**: Deploying the complete platform to staging takes under 3 minutes
- **SC-008**: First-time setup (including creating all cloud resources) completes in under 10 minutes with clear instructions
- **SC-009**: 95% of workspace creation attempts succeed on first try
- **SC-010**: Users can tear down and redeploy the entire platform without data loss in credentials or user accounts

## Assumptions

The following assumptions were made based on industry standards and the research conducted:

1. **GitHub App over OAuth App**: We use a GitHub App (not just OAuth App) because OAuth tokens cannot reliably perform git clone/push operations. GitHub Apps generate installation access tokens that work for git operations.

2. **Token expiration handling**: GitHub App installation access tokens expire after 1 hour. For MVP, this is acceptable since we only need the token for initial repository clone. Future iterations may implement token refresh for long-running operations.

3. **Single database**: We use a single Cloudflare D1 database for all tenants. D1's 10GB limit is sufficient for user/workspace metadata. If scaling issues arise, we can shard by user.

4. **VM Agent binary distribution**: The VM Agent binary is served by the control plane (not downloaded from GitHub). This ensures version alignment between control plane and VM Agent, enables self-hosting without external dependencies, and simplifies deployment.

5. **Devcontainer support**: We assume repositories have a `.devcontainer` configuration. For repositories without one, we use a default devcontainer with common development tools.

6. **HTTPS via Cloudflare**: SSL/TLS termination happens at Cloudflare's edge. The VM Agent serves HTTP, which is proxied through Cloudflare for HTTPS.

7. **No SSH access**: Users interact with workspaces exclusively through the browser terminal. We do not provide SSH access to VMs for security and simplicity.

## Non-Functional Considerations

### Security
- All secrets are stored in Cloudflare Workers secrets, never in source code
- User credentials are encrypted at rest with AES-GCM
- JWTs are signed with RS256 and expire after 1 hour
- VM Agents validate JWTs against a JWKS endpoint (no shared secrets)
- Session cookies are HttpOnly, Secure, and SameSite=Strict

### Reliability
- Workspace provisioning is idempotent - retrying a failed creation is safe
- DNS records are cleaned up even if VM deletion fails
- Orphaned resources are identified and can be cleaned up manually

### Observability
- All API requests are logged with request IDs
- Workspace state transitions are logged for debugging
- VM Agent reports health status to control plane

## Out of Scope for MVP

The following features are explicitly excluded from this MVP:

1. **Multiple Git providers** (GitLab, Bitbucket) - GitHub only for MVP
2. **Multiple cloud providers** (AWS, GCP, Scaleway) - Hetzner only for MVP
3. **Persistent workspaces** - Workspaces do not preserve state between restarts
4. **Team/organization features** - Single-user only for MVP
5. **Custom VM images** - We use standard Ubuntu with cloud-init
6. **File browser** - Terminal only, no visual file management
7. **Real-time collaboration** - No shared workspace sessions
8. **Usage billing/metering** - Users pay Hetzner directly, we don't track usage
9. **Custom domains** - All workspaces use our subdomain pattern
10. **SSH access** - Browser terminal only

## Appendix: Developer Experience Documentation

### First-Time Setup

Prerequisites:
- Node.js 20+ and pnpm installed
- Cloudflare account with Workers, D1, KV, and DNS access
- Hetzner Cloud account (for testing)
- GitHub account

Steps:
1. Clone the repository
2. Run `pnpm install` to install dependencies
3. Run `pnpm setup` to start the interactive setup wizard
4. The wizard will:
   - Guide you through creating a GitHub OAuth App
   - Guide you through creating a GitHub App
   - Prompt for your Cloudflare API token and zone ID
   - Generate JWT signing keys
   - Generate encryption keys
   - Create D1 database and KV namespace
   - Set all secrets in Cloudflare
   - Run database migrations

### Deployment Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start local development (miniflare + Vite) |
| `pnpm build` | Build all packages |
| `pnpm deploy:staging` | Deploy everything to staging environment |
| `pnpm deploy` | Deploy everything to production environment |
| `pnpm teardown:staging` | Destroy staging environment (with confirmation) |
| `pnpm teardown` | Destroy production environment (with confirmation) |
| `pnpm db:migrate:staging` | Run migrations on staging database |
| `pnpm db:migrate` | Run migrations on production database |

### Environment Architecture

| Environment | API URL | Web URL | Database |
|-------------|---------|---------|----------|
| Development | localhost:8787 | localhost:5173 | Local D1 (miniflare) |
| Staging | api-staging.workspaces.example.com | staging.workspaces.example.com | D1 staging |
| Production | api.workspaces.example.com | workspaces.example.com | D1 production |

### Required Cloudflare Resources

The deploy script creates these automatically:
- **D1 Database**: `workspaces-{env}` - stores users, credentials, workspaces
- **KV Namespace**: `workspaces-{env}-sessions` - stores BetterAuth sessions
- **R2 Bucket**: `workspaces-{env}-assets` - stores VM Agent binaries (served by control plane)
- **Worker**: `workspaces-api-{env}` - the Hono API
- **Pages Project**: `workspaces-{env}` - the React web UI
- **DNS Records**: Managed dynamically for workspace subdomains

### Required Secrets

Set via `wrangler secret put` or the setup wizard:
- `GITHUB_CLIENT_ID` - GitHub OAuth App client ID
- `GITHUB_CLIENT_SECRET` - GitHub OAuth App client secret
- `GITHUB_APP_ID` - GitHub App ID
- `GITHUB_APP_PRIVATE_KEY` - GitHub App private key (PEM format)
- `CF_API_TOKEN` - Cloudflare API token for DNS management
- `CF_ZONE_ID` - Cloudflare zone ID for the domain
- `JWT_PRIVATE_KEY` - RSA private key for signing JWTs
- `JWT_PUBLIC_KEY` - RSA public key for JWKS endpoint
- `ENCRYPTION_KEY` - AES-256 key for encrypting credentials
