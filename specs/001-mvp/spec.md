# Feature Specification: Simple Agent Manager MVP

**Feature Branch**: `001-mvp`
**Created**: 2026-01-24
**Updated**: 2026-01-25
**Status**: Draft
**Input**: User description: "Serverless platform to spin up AI coding agent environments on-demand with zero ongoing cost"

## Overview

A lightweight, serverless platform to create on-demand AI coding workspaces. Users can spin up a cloud VM with Claude Code pre-installed from any git repository (public or private), access it via a web-based interface, and have it automatically terminate when idle.

**Core Value Proposition**: "GitHub Codespaces, but optimized for Claude Code and AI-assisted development, with zero cost when not in use."

**Target User**: Claude Max subscriber who wants cloud-based AI coding environments without local setup.

## User Scenarios & Testing *(mandatory)*

### User Story 0 - Connect GitHub Account (Priority: P0)

A developer wants to work with their private repositories. Before creating workspaces, they connect their GitHub account by installing the platform's GitHub App. This grants the platform access to selected repositories for cloning.

**Why this priority**: Without repository access, users cannot work on private codebases—a fundamental capability for real-world development.

**Independent Test**: Can be tested by initiating GitHub App installation, selecting repositories, and verifying the installation is saved.

**Acceptance Scenarios**:

1. **Given** a user opens the control plane, **When** they click "Connect GitHub", **Then** they are redirected to GitHub to install the platform's GitHub App.

2. **Given** a user is on the GitHub App installation page, **When** they select specific repositories and approve, **Then** they are redirected back to the control plane with a success confirmation.

3. **Given** a user has installed the GitHub App, **When** they view their settings, **Then** they can see which repositories are accessible and modify the selection via GitHub.

4. **Given** a user has not connected GitHub, **When** they try to create a workspace from a private repository, **Then** they are prompted to connect GitHub first.

---

### User Story 1 - Create AI Coding Workspace (Priority: P1)

A developer wants to work on a project using Claude Code without setting up their local environment. They open the control plane, enter a git repository URL (public or from their connected GitHub), and create a workspace. Within minutes, they have a fully configured Claude Code environment accessible via their browser.

**Why this priority**: This is the core functionality—without workspace creation, the platform has no value. Everything else depends on this working.

**Independent Test**: Can be fully tested by creating a single workspace from a GitHub repo and verifying the environment is accessible. Delivers immediate value as a working AI coding environment.

**Acceptance Scenarios**:

1. **Given** a user is authenticated to the control plane, **When** they submit a valid git repository URL, **Then** a new workspace is created and the user sees a "Creating" status with estimated time.

2. **Given** a user selects a private repository from their connected GitHub, **When** they create a workspace, **Then** the repository is cloned successfully using the GitHub App's access token.

3. **Given** a workspace is being created, **When** the VM boots and configures successfully, **Then** the workspace status changes to "Running" and the access URL is displayed.

4. **Given** a workspace creation is in progress, **When** the VM fails to provision or configure, **Then** the workspace status changes to "Failed" with an error message, and no ongoing charges are incurred.

5. **Given** a user enters a repository URL, **When** the repository contains a `.devcontainer/devcontainer.json`, **Then** that configuration is used for the workspace environment.

6. **Given** a user enters a repository URL, **When** the repository has no devcontainer configuration, **Then** a default Claude Code-optimized configuration is applied automatically.

---

### User Story 1.5 - Authenticate Claude Code (Priority: P1)

A developer has a running workspace and needs to authenticate Claude Code with their Claude Max subscription. They access the workspace terminal via the CloudCLI web interface and run `claude login` to authenticate interactively.

**Why this priority**: Without Claude authentication, the AI coding assistant cannot function.

**Independent Test**: Can be tested by opening the terminal in CloudCLI, running `claude login`, completing browser authentication, and verifying Claude Code responds to prompts.

**Acceptance Scenarios**:

1. **Given** a workspace is running, **When** a user opens the CloudCLI interface, **Then** they can access an integrated terminal.

2. **Given** a user runs `claude login` in the terminal, **When** the browser authentication flow completes, **Then** Claude Code is authenticated and ready to use.

3. **Given** a user's Claude Max session has expired, **When** they try to use Claude Code, **Then** they are prompted to re-authenticate via `claude login`.

4. **Given** a user has authenticated, **When** they use Claude Code in subsequent sessions (within expiry), **Then** the authentication persists.

---

### User Story 2 - Access Running Workspace (Priority: P1)

A developer with a running workspace wants to start coding with Claude Code. They click the workspace URL in the control plane and are taken to a web-based interface where they can interact with Claude Code, view files, and use the terminal.

**Why this priority**: Without access to the workspace, the created VM is useless. This is equally critical to creation.

**Independent Test**: Can be tested by navigating to a workspace URL and verifying the web interface loads, authentication works, and Claude Code responds to prompts.

**Acceptance Scenarios**:

1. **Given** a workspace is running, **When** a user clicks the access URL, **Then** they are prompted for authentication credentials.

2. **Given** valid credentials are entered, **When** the user submits them, **Then** the CloudCLI web interface loads showing the project files and a Claude Code terminal.

3. **Given** the web interface is loaded, **When** the user sends a prompt to Claude Code, **Then** Claude Code responds using the user's authenticated Claude Max subscription.

4. **Given** the web interface is loaded, **When** the user browses files, uses git features, or accesses the terminal, **Then** these operations work correctly within the workspace.

5. **Given** the workspace is connected to a private repository, **When** the user commits and pushes changes via Claude Code or git CLI, **Then** the changes are successfully pushed to the remote repository.

---

### User Story 3 - View Workspace List (Priority: P2)

A developer wants to see all their workspaces—which ones are running, which have stopped, and their access URLs. The control plane shows a dashboard of all workspaces with their current status.

**Why this priority**: Users need visibility into their workspaces to manage them, but can initially work with a single workspace created via direct API calls if needed.

**Independent Test**: Can be tested by creating multiple workspaces and verifying the list displays correctly with accurate status for each.

**Acceptance Scenarios**:

1. **Given** a user has multiple workspaces, **When** they open the control plane dashboard, **Then** all workspaces are listed with name, status, and creation time.

2. **Given** a workspace is running, **When** it appears in the list, **Then** it shows a clickable access URL and a "Stop" action.

3. **Given** a workspace has terminated, **When** it appears in the list, **Then** it shows "Stopped" status and no access URL (workspace is deleted).

---

### User Story 4 - Manually Stop Workspace (Priority: P2)

A developer is done working and wants to immediately stop their workspace to avoid any further charges. They click "Stop" in the control plane, and the workspace terminates.

**Why this priority**: While auto-shutdown handles most cases, users need the ability to explicitly stop workspaces for cost control.

**Independent Test**: Can be tested by creating a workspace, then stopping it and verifying the VM is terminated and DNS cleaned up.

**Acceptance Scenarios**:

1. **Given** a workspace is running, **When** the user clicks "Stop", **Then** a confirmation is shown.

2. **Given** the user confirms stopping, **When** the action completes, **Then** the workspace status changes to "Stopped" and the VM is terminated.

3. **Given** a workspace is stopped, **When** the DNS is checked, **Then** the wildcard DNS record for that workspace has been removed.

---

### User Story 5 - Automatic Idle Shutdown (Priority: P3)

A developer forgets to stop their workspace. After 30 minutes of no activity (no file changes, no Claude processes, no web sessions), the workspace automatically shuts down and cleans up.

**Why this priority**: This is critical for cost control but the platform is usable without it during initial testing.

**Independent Test**: Can be tested by creating a workspace, leaving it idle, and verifying it terminates after the idle period with proper cleanup.

**Acceptance Scenarios**:

1. **Given** a workspace has been idle for 30 minutes, **When** the idle check runs, **Then** the workspace begins shutdown.

2. **Given** a workspace is shutting down due to idle, **When** the VM terminates, **Then** it first notifies the control plane to clean up DNS records.

3. **Given** a user is actively using the workspace, **When** the idle check runs, **Then** the workspace is NOT shut down (file changes, Claude processes, or web connections are detected).

4. **Given** Claude Code is processing a long-running request, **When** the idle check runs, **Then** the workspace is NOT shut down.

---

### Edge Cases

- What happens when the cloud provider API is unavailable during workspace creation?
  - System displays "Provider unavailable" error and allows retry.

- What happens when the git repository URL is invalid or inaccessible?
  - VM creation proceeds but devcontainer fails; workspace marked as "Failed" with clone error message.

- What happens when the user's Claude Max subscription is inactive?
  - Workspace runs but Claude Code shows authentication/subscription error when `claude login` is attempted.

- What happens when the user closes their browser during workspace creation?
  - Creation continues in background; user sees status when they return.

- What happens when two workspaces are created for the same repository?
  - Both are created independently with different VM IDs and DNS hostnames.

- What happens when DNS propagation is slow?
  - User may need to wait or retry; URL shows immediately but may not resolve for ~1 minute.

- What happens when the GitHub App installation is revoked?
  - Existing workspaces continue running but new workspaces cannot clone private repos; user is prompted to reconnect.

- What happens when the user tries to clone a private repo without GitHub connected?
  - Clone fails and workspace shows "Failed" with message prompting GitHub connection.

## Requirements *(mandatory)*

### Functional Requirements

**GitHub Integration**
- **FR-001**: System MUST provide a GitHub App that users can install to grant repository access.
- **FR-002**: GitHub App MUST request repository read and write permissions (contents: read and write) to enable cloning and pushing.
- **FR-003**: System MUST store GitHub App installation ID per user for generating access tokens.
- **FR-004**: System MUST generate short-lived installation access tokens with read and write permissions for private repository access (clone and push).
- **FR-005**: System MUST display which repositories are accessible after GitHub connection.

**Control Plane UI**
- **FR-006**: System MUST provide a web-based control plane accessible via browser.
- **FR-007**: Control plane MUST authenticate users via a pre-configured bearer token before allowing any actions.
- **FR-008**: Control plane MUST display a form to create new workspaces with fields for: git repository URL (with autocomplete for connected repos) and VM size selection.
- **FR-009**: Control plane MUST display a list of all workspaces with their current status, access URL (when running), and creation time.
- **FR-010**: Control plane MUST allow users to stop running workspaces.
- **FR-011**: Control plane MUST provide a "Connect GitHub" action for users to install the GitHub App.

**API Layer**
- **FR-012**: System MUST provide an API endpoint to create workspaces (POST /vms).
- **FR-013**: System MUST provide an API endpoint to list workspaces (GET /vms).
- **FR-014**: System MUST provide an API endpoint to delete workspaces (DELETE /vms/:id).
- **FR-015**: System MUST provide a callback endpoint for VMs to notify of cleanup (POST /vms/:id/cleanup).
- **FR-016**: API MUST authenticate all requests using bearer token authentication.
- **FR-017**: System MUST provide an API endpoint for GitHub App OAuth callback.
- **FR-018**: System MUST provide an API endpoint to list accessible repositories (GET /github/repos).

**VM Provisioning**
- **FR-019**: System MUST provision VMs via cloud provider API using cloud-init for configuration.
- **FR-020**: System MUST create wildcard DNS records pointing to VM IP addresses.
- **FR-021**: VMs MUST install and start a reverse proxy with TLS termination and basic authentication.
- **FR-022**: VMs MUST clone the specified git repository using provided credentials (public URL or GitHub token).
- **FR-023**: VMs MUST start a devcontainer after cloning the repository.
- **FR-024**: VMs MUST install and run Claude Code with the CloudCLI web interface.
- **FR-025**: VMs MUST detect existing `.devcontainer/devcontainer.json` or create a Claude Code-optimized default.
- **FR-026**: CloudCLI MUST provide integrated terminal access for running `claude login`.
- **FR-027**: VMs MUST NOT have ANTHROPIC_API_KEY environment variable set (users authenticate interactively).

**Idle Management**
- **FR-028**: VMs MUST run an idle detection check every 5 minutes.
- **FR-029**: Idle detection MUST consider: recent file changes, active Claude/Node processes, active web connections, and SSH sessions.
- **FR-030**: VMs MUST self-terminate after 30 minutes of continuous idle state.
- **FR-031**: Before self-termination, VMs MUST call the cleanup API endpoint to trigger DNS record removal.
- **FR-032**: VMs MUST be able to delete themselves via the cloud provider API.

**DNS Management**
- **FR-033**: System MUST create a wildcard A record for each workspace (*.{vm-id}.vm.{domain}).
- **FR-034**: System MUST delete DNS records when a workspace is stopped or self-terminates.
- **FR-035**: DNS records MUST be proxied through the DNS provider for DDoS protection.

**Security**
- **FR-036**: Web interface MUST require basic authentication with auto-generated credentials.
- **FR-037**: API credentials and tokens MUST NOT be stored in git repositories.
- **FR-038**: Cloud provider tokens on VMs MUST have minimal permissions (delete own server only).
- **FR-039**: GitHub installation tokens MUST be short-lived and scoped to selected repositories.

**Local Testing Infrastructure**
- **FR-040**: System MUST support a "local" provider mode using Docker for testing.
- **FR-041**: Local provider MUST create Docker containers with Docker-in-Docker capability to simulate VMs.
- **FR-042**: Local provider MUST run devcontainers inside the Docker container.
- **FR-043**: Local provider MUST be usable for automated end-to-end testing without cloud credentials.
- **FR-044**: Local provider MUST expose the same ports and DNS patterns as production (via localhost).

### Key Entities

- **Workspace**: Represents a single AI coding environment. Contains: unique ID, git repository URL, status (creating/running/stopping/stopped/failed), VM provider ID, IP address, DNS hostname, creation timestamp, and reference to associated secrets.

- **VM**: The underlying cloud server (or Docker container in local mode). Contains: provider-specific ID, IP address, server type, region, and labels for identification/filtering.

- **GitHubConnection**: User's GitHub App installation. Contains: installation ID, list of accessible repository IDs/names, installation timestamp, and status (active/revoked).

- **Secrets**: Sensitive configuration not stored in workspace entity. Includes: basic auth password, cloud provider token for self-destruct, and GitHub installation access token (short-lived, generated on demand).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can create a workspace and access Claude Code via web browser within 5 minutes of initiating creation.

- **SC-002**: System incurs zero ongoing cost when no workspaces are running (serverless control plane, VMs terminate completely).

- **SC-003**: Idle workspaces automatically terminate within 35 minutes of last activity (30 min idle threshold + 5 min check interval).

- **SC-004**: Users can interact with Claude Code through the web interface with the same capabilities as the local CLI (file access, terminal, git operations).

- **SC-005**: Users can manually stop any running workspace within 30 seconds of clicking "Stop".

- **SC-006**: 95% of workspace creation attempts succeed when given valid inputs (repository URL, GitHub connection, provider availability).

- **SC-007**: DNS hostnames resolve correctly within 2 minutes of workspace reaching "Running" status.

- **SC-008**: Web interface authentication prevents unauthorized access—only users with correct credentials can access workspaces.

- **SC-009**: Users can clone private repositories after connecting their GitHub account via the GitHub App.

- **SC-010**: Users can authenticate Claude Code with their Max subscription via `claude login` in the terminal within 2 minutes.

- **SC-011**: End-to-end tests can run locally using Docker provider without any cloud credentials.

## Assumptions

1. **Single User**: MVP supports one user; authentication is a simple bearer token from environment variable.

2. **Single Cloud Provider**: MVP uses Hetzner Cloud for production; provider abstraction supports local Docker for testing.

3. **Ephemeral Workspaces**: No persistence between sessions; workspace data is lost when VM terminates. Persistence is planned for a future phase.

4. **No Port Forwarding**: Only the CloudCLI port (3001) is exposed via DNS subdomain; port discovery and dynamic forwarding are future features.

5. **GitHub Repositories**: MVP focuses on GitHub repositories via GitHub App; other git providers are a future enhancement.

6. **Claude Max Subscription**: Users are Claude Max subscribers who authenticate via `claude login`; API key users are not supported in MVP.

7. **Wildcard DNS**: User has access to a domain with Cloudflare DNS management for wildcard record creation.

8. **CloudCLI Terminal Access**: CloudCLI (claude-code-ui) provides integrated shell terminal for running `claude login`.

## Out of Scope

The following are explicitly NOT part of this MVP:

- Workspace persistence (R2 backup/restore)
- Multiple cloud providers (Scaleway, OVH) for production
- Port discovery and dynamic forwarding
- Multi-tenancy and user management
- GitLab/Bitbucket repository support
- Anthropic API key based authentication (only Claude Max)
- Cloudflare Tunnel integration
- Token usage tracking and billing
- Custom MCP server configuration UI

## Dependencies

- **Cloudflare Account**: For Pages (UI hosting), Workers (API), and DNS management.
- **Hetzner Cloud Account**: For VM provisioning with API access.
- **Domain with Cloudflare DNS**: For wildcard DNS record management.
- **GitHub Developer Account**: For creating the GitHub App.
- **Docker**: For local testing and E2E tests.
- **Claude Max Subscription**: User-provided for Claude Code functionality (via interactive login).

## Testing Strategy

### Local E2E Testing with Docker Provider

To enable comprehensive end-to-end testing without cloud credentials, the system includes a local Docker-based provider:

1. **Docker Provider**: A provider implementation that creates Docker containers instead of Hetzner VMs
   - Containers run with `--privileged` flag for Docker-in-Docker capability
   - Uses the same cloud-init scripts (adapted for Docker)
   - Exposes ports on localhost for testing

2. **Test Flow**:
   - API receives workspace creation request
   - Docker provider creates container with DinD
   - Container runs devcontainer setup
   - Tests verify CloudCLI is accessible at localhost port
   - Container is destroyed after test

3. **Automated Tests**:
   - Integration tests mock the provider interface
   - E2E tests use the Docker provider for real container lifecycle
   - CI/CD runs E2E tests without cloud credentials

## References

- [Architecture Notes](../../research/architecture-notes.md)
- [AI Agent Optimizations](../../research/ai-agent-optimizations.md)
- [DNS, Security & Persistence Plan](../../research/dns-security-persistence-plan.md)
- [Multi-tenancy Interfaces](../../research/multi-tenancy-interfaces.md)
- [GitHub Apps Documentation](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)
- [CloudCLI (Claude Code UI)](https://github.com/siteboon/claudecodeui)
- [Claude Code Authentication](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)
