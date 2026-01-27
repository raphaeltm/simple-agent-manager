# Feature Specification: Local Mock Mode

**Feature Branch**: `002-local-mock-mode`
**Created**: 2025-01-25
**Status**: Draft
**Input**: User description: "Plan a mock mode since the docker runner didn't work. Have a mock Hetzner API for endpoints we call. Run a simple devcontainer (not a devcontainer inside a container pretending to be a VM). Create a way to run the control plane in mock mode that interacts with that API instead of the real one."

## Clarifications

### Session 2025-01-25

- Q: Docker-in-Docker provider disposition (delete, archive, or deprecate)? → A: Delete entirely. The development environment is already a Docker container with DinD enabled, making nested DinD (another level deeper) too complex to configure reliably.
- Q: Concurrent workspace limit in mock mode? → A: Single workspace only. Must stop existing workspace before creating a new one.

## Summary

Enable local development and testing of the control plane UI and API without requiring real cloud infrastructure (Hetzner/Cloudflare). This feature provides:

1. A **DevcontainerProvider** that uses the native `devcontainer` CLI to create workspaces directly as devcontainers
2. A **mock DNS service** that bypasses Cloudflare for local development
3. A **development mode** toggle for the API that switches providers
4. Cleanup of the existing broken Docker-in-Docker provider

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run Control Plane Locally (Priority: P1)

As a developer, I want to start the control plane (API + Web UI) in mock mode so I can develop and test UI features without cloud credentials or infrastructure costs.

**Why this priority**: This is the core value - enabling local development without external dependencies.

**Independent Test**: Can be fully tested by running `pnpm dev:mock` and verifying the web UI loads and connects to the mock API.

**Acceptance Scenarios**:

1. **Given** a developer has cloned the repository, **When** they run `pnpm dev:mock`, **Then** the API starts in mock mode and the web UI connects to it successfully
2. **Given** the control plane is running in mock mode, **When** the developer views the dashboard, **Then** they see the workspace list (empty initially) without any errors
3. **Given** mock mode is active, **When** the developer has no cloud credentials configured, **Then** the system operates normally without authentication errors

---

### User Story 2 - Create Local Workspace (Priority: P1)

As a developer, I want to create a workspace in mock mode that runs as a local devcontainer so I can test the full workspace creation flow.

**Why this priority**: Creating workspaces is the primary user action - critical for testing.

**Independent Test**: Can be tested by creating a workspace via the UI and verifying a devcontainer starts locally.

**Acceptance Scenarios**:

1. **Given** the control plane is in mock mode, **When** I create a workspace with a public GitHub repository, **Then** a devcontainer is created locally with the repository cloned
2. **Given** I'm creating a workspace, **When** the devcontainer starts successfully, **Then** the workspace status changes from "creating" to "running"
3. **Given** the workspace is running, **When** I view its details, **Then** I see the local container information (container ID, local IP)

---

### User Story 3 - Stop and Delete Local Workspace (Priority: P2)

As a developer, I want to stop and delete workspaces in mock mode so I can test the full lifecycle.

**Why this priority**: Lifecycle management is secondary to creation but still important for complete testing.

**Independent Test**: Can be tested by stopping a running workspace and verifying the container is removed.

**Acceptance Scenarios**:

1. **Given** a workspace is running locally, **When** I click "Stop Workspace", **Then** the devcontainer is stopped and removed
2. **Given** I've stopped a workspace, **When** I view the workspace list, **Then** the workspace no longer appears

---

### User Story 4 - Access Local Workspace Terminal (Priority: P3)

As a developer, I want to execute commands in a local workspace so I can verify the workspace environment works correctly.

**Why this priority**: Terminal access is valuable for debugging but not essential for basic flow testing.

**Independent Test**: Can be tested by running a command via `devcontainer exec` and seeing output.

**Acceptance Scenarios**:

1. **Given** a workspace is running locally, **When** I access its terminal endpoint, **Then** I can execute commands in the devcontainer
2. **Given** I'm in the workspace terminal, **When** I run `pwd`, **Then** I see the workspace directory path

---

### Edge Cases

- What happens when Docker is not running? System provides clear error message on startup.
- What happens when the devcontainer CLI is not installed? System provides installation instructions.
- What happens when a repository doesn't have a devcontainer.json? System creates a default configuration.
- What happens when a workspace creation fails? System reports the error and cleans up partial resources.
- What happens when stopping a workspace that's already stopped? System handles gracefully without errors.
- What happens when creating a workspace while one already exists? System returns an error prompting user to stop the existing workspace first.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a development mode that uses local devcontainers instead of cloud VMs
- **FR-002**: System MUST detect when the `devcontainer` CLI is available and provide installation guidance if missing
- **FR-003**: System MUST use the `devcontainer up` command to create workspaces from repositories
- **FR-004**: System MUST create a default devcontainer.json for repositories that lack one
- **FR-005**: System MUST use `devcontainer exec` to run commands in workspaces
- **FR-006**: System MUST stop and remove devcontainers when workspaces are deleted
- **FR-007**: System MUST provide a mock DNS service that stores DNS records in memory (bypassing Cloudflare)
- **FR-008**: System MUST provide a `pnpm dev:mock` command that starts both API and UI in development mode
- **FR-009**: System MUST track workspace metadata (ID, status, repository, creation time) in memory during mock mode
- **FR-010**: System MUST delete the existing Docker-in-Docker provider implementation (docker.ts, scripts/docker/, and all references)
- **FR-011**: System MUST expose workspace connection details (container ID, local ports) via the API
- **FR-012**: System MUST enforce a single workspace limit in mock mode; creating a new workspace requires stopping any existing one first

### Key Entities

- **DevcontainerWorkspace**: Represents a local workspace running as a devcontainer
  - ID (generated UUID)
  - Container ID (from Docker)
  - Repository URL
  - Status (creating, running, stopping, stopped, failed)
  - Creation timestamp
  - Local workspace folder path

- **MockDNSRecord**: In-memory DNS record storage
  - Record name
  - Record value (local IP/hostname)
  - Created timestamp

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Developers can start the full control plane locally with a single command (`pnpm dev:mock`)
- **SC-002**: Workspace creation in mock mode completes within 2 minutes for a simple repository
- **SC-003**: The mock mode requires zero cloud credentials or external service configuration
- **SC-004**: All primary UI workflows (create, list, view, delete workspaces) function identically in mock mode
- **SC-005**: The existing Docker-in-Docker code is removed or archived, reducing codebase complexity

## Assumptions

- Docker Desktop or Docker Engine is installed and running on the developer's machine
- The development environment itself runs inside a Docker container with DinD enabled (nested DinD is not viable)
- The `devcontainer` CLI can be installed via npm (`npm install -g @devcontainers/cli`)
- Developers have sufficient local resources (4GB+ RAM, 10GB+ disk) for running devcontainers
- Mock mode is for development only - not intended for production use
- Port mapping for devcontainers will use dynamic port allocation

## Out of Scope

- HTTPS/TLS for local development (uses HTTP)
- Idle detection and auto-termination in mock mode
- GitHub App integration in mock mode (uses public repos or basic token auth)
- CloudCLI web terminal integration (would require additional local proxy setup)
- Persistent workspace state across API restarts (in-memory storage only)
