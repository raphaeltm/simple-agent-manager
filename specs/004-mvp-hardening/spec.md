# Feature Specification: MVP Hardening

**Feature Branch**: `004-mvp-hardening`
**Created**: 2026-01-27
**Status**: Draft
**Input**: User description: "MVP Hardening: Security, reliability, and UX improvements for production readiness"

## Clarifications

### Session 2026-01-27

- Q: What happens when VM fails to reach control plane during bootstrap window? → A: Retry with exponential backoff until token expires, then fail to Error status

## Overview

This specification addresses critical gaps identified during architecture review that must be resolved before the MVP can be considered production-ready. The changes span three areas:

1. **Security** - Prevent exposure of sensitive credentials and enforce proper access control
2. **Reliability** - Handle failure cases gracefully and maintain stable connections
3. **User Experience** - Provide clear, predictable idle shutdown behavior

**Key Design Principle**: These improvements focus on hardening existing functionality rather than adding new features. The goal is production readiness for self-hosted deployments.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Secure Credential Handling (Priority: P1)

A platform operator deploys Simple Agent Manager and creates workspaces for their team. They need assurance that sensitive credentials (cloud provider tokens, authentication tokens) are not visible in cloud provider consoles, VM metadata, or logs.

**Why this priority**: This is a critical security issue. Currently, secrets embedded in cloud-init are visible in the Hetzner console to anyone with account access. For self-hosted deployments, this may expose credentials to unintended parties (e.g., shared team accounts, contractor access to cloud console).

**Independent Test**: Operator can verify that after creating a workspace, examining the VM's cloud-init user data in Hetzner console reveals no sensitive tokens.

**Acceptance Scenarios**:

1. **Given** a user creates a new workspace, **When** the VM is provisioned, **Then** the cloud-init script contains no plaintext secrets (Hetzner token, JWT callback token, GitHub access token)
2. **Given** a VM is running, **When** an operator views the VM metadata in Hetzner console, **Then** no sensitive credentials are visible
3. **Given** a VM needs to authenticate with the control plane, **When** it starts up, **Then** it retrieves credentials via a secure one-time bootstrap mechanism
4. **Given** a one-time bootstrap token is used, **When** the VM attempts to reuse it, **Then** the request is rejected

---

### User Story 2 - Workspace Access Control (Priority: P2)

A multi-user deployment has several users creating workspaces. Each user must only be able to view, access, and manage their own workspaces. No user should be able to access another user's workspace through URL manipulation or API calls.

**Why this priority**: Without proper ownership validation, users could access each other's workspaces by guessing or enumerating workspace IDs (IDOR vulnerability). Even in self-hosted scenarios, this is a fundamental security control.

**Independent Test**: User can verify that attempting to access another user's workspace ID returns an access denied error.

**Acceptance Scenarios**:

1. **Given** User A has created a workspace, **When** User B attempts to view it via the dashboard, **Then** User B sees only their own workspaces
2. **Given** User A has a workspace with ID "abc123", **When** User B makes an API request to `/workspaces/abc123`, **Then** the API returns a 403 Forbidden or 404 Not Found response
3. **Given** User A has a workspace with ID "abc123", **When** User B attempts to delete it via API, **Then** the request is rejected
4. **Given** User A has a workspace, **When** User B attempts to connect to its terminal via WebSocket, **Then** the connection is rejected

---

### User Story 3 - Reliable Workspace Provisioning (Priority: P3)

A user creates a workspace but the VM provisioning fails silently (cloud-init hangs, devcontainer build fails, network issues). The user should not be left with a workspace stuck in "Creating" status indefinitely.

**Why this priority**: Stuck workspaces consume cloud resources, confuse users, and require manual intervention. Automatic cleanup ensures a self-healing system.

**Independent Test**: User can verify that a workspace that fails to become ready within the timeout period is automatically marked as failed with a clear error message.

**Acceptance Scenarios**:

1. **Given** a workspace is created, **When** the VM does not report "ready" within 10 minutes, **Then** the workspace status changes to "Error" with reason "Provisioning timeout"
2. **Given** a workspace enters "Error" status due to timeout, **When** the user views the dashboard, **Then** they see a clear error message explaining the failure
3. **Given** a workspace enters "Error" status, **When** the user clicks "Delete", **Then** the system cleans up any orphaned VM and DNS resources
4. **Given** a workspace is provisioning, **When** the VM successfully reports ready, **Then** the timeout timer is cancelled and status changes to "Ready"

---

### User Story 4 - Stable Terminal Connections (Priority: P4)

A user is working in a terminal session when their network briefly disconnects (WiFi switching, VPN reconnection, laptop sleep/wake). The terminal should automatically reconnect without losing their session context.

**Why this priority**: Network interruptions are common. Without auto-reconnect, users must manually refresh the page, which is frustrating and breaks workflow.

**Independent Test**: User can verify that temporarily disabling network connectivity and re-enabling it results in automatic terminal reconnection.

**Acceptance Scenarios**:

1. **Given** a user has an active terminal connection, **When** the WebSocket connection drops, **Then** the terminal displays "Reconnecting..." status
2. **Given** the terminal is in "Reconnecting" state, **When** the network becomes available, **Then** the terminal reconnects automatically within 5 seconds
3. **Given** the terminal cannot reconnect, **When** multiple reconnection attempts fail, **Then** the user sees a "Connection failed - Click to retry" message
4. **Given** the terminal has reconnected, **When** the user types commands, **Then** input is processed normally (though previous terminal output may be lost)
5. **Given** the terminal is reconnecting, **When** the workspace has been stopped during disconnection, **Then** the user sees "Workspace is no longer running" message

---

### User Story 5 - Predictable Idle Shutdown (Priority: P5)

A user is working in a workspace and wants to know exactly when it will shut down due to inactivity. Instead of vague "idle timeout" messages, they see a specific deadline that extends when they interact with the workspace.

**Why this priority**: Users need predictability to plan their work. A deadline-based model ("Shutting down at 3:45 PM") is clearer than duration-based ("Idle for 25 minutes").

**Independent Test**: User can verify that the terminal status bar shows a specific shutdown time that updates when they perform actions.

**Acceptance Scenarios**:

1. **Given** a user opens a workspace terminal, **When** they view the status bar, **Then** they see "Auto-shutdown at [specific time]" (e.g., "3:45 PM")
2. **Given** a workspace has a shutdown deadline in 30 minutes, **When** the user types a command or performs any activity, **Then** the deadline extends by 30 minutes from the current time
3. **Given** the shutdown deadline is in 5 minutes, **When** the user views the status bar, **Then** they see a warning: "Shutting down in 5 minutes at [time]"
4. **Given** the shutdown deadline passes with no activity, **When** the idle timeout triggers, **Then** the workspace shuts down and the user sees "Workspace stopped due to inactivity"
5. **Given** a user is viewing the dashboard, **When** they look at a running workspace, **Then** they see the shutdown deadline time

---

### User Story 6 - Consolidated Terminal Experience (Priority: P6)

Developers maintaining the platform need a single, shared terminal component used across both the control plane web UI and the VM agent UI. This enables consistent behavior and easier maintenance.

**Why this priority**: This is an internal quality improvement that enables P4 (reconnection) and P5 (deadline display) to be implemented once and used everywhere.

**Independent Test**: Developer can verify that both web UI and VM agent UI import the terminal component from the same shared package.

**Acceptance Scenarios**:

1. **Given** the web UI renders a terminal, **When** inspecting the code, **Then** it uses the shared terminal package
2. **Given** the VM agent UI renders a terminal, **When** inspecting the code, **Then** it uses the same shared terminal package
3. **Given** a change is made to terminal styling, **When** both UIs are rebuilt, **Then** both reflect the same styling change
4. **Given** reconnection logic is implemented in the shared package, **When** either UI experiences a disconnect, **Then** both exhibit the same reconnection behavior

---

### Edge Cases

- **Bootstrap token replay attack**: If an attacker captures a one-time bootstrap token, they should not be able to reuse it to obtain credentials
- **Workspace deletion during provisioning**: If a user deletes a workspace while it's still provisioning, the system should cancel the timeout and clean up resources
- **Rapid network flapping**: If the network drops and reconnects repeatedly in quick succession, the terminal should not spawn multiple reconnection attempts
- **Timezone handling for shutdown deadline**: Shutdown times should be displayed in the user's local timezone
- **Clock skew between VM and control plane**: The idle detection should handle reasonable clock differences between systems

## Requirements *(mandatory)*

### Functional Requirements

**Secure Secret Handling**:
- **FR-001**: System MUST NOT include plaintext secrets in cloud-init user data
- **FR-002**: System MUST provide a secure one-time bootstrap mechanism for VMs to retrieve credentials
- **FR-003**: Bootstrap tokens MUST be single-use and expire after first use or after 5 minutes (whichever comes first)
- **FR-004**: VMs MUST retrieve their operational credentials (Hetzner token for self-destruct, callback token) via the bootstrap mechanism
- **FR-004a**: If the VM cannot reach the control plane during bootstrap, it MUST retry with exponential backoff until the bootstrap token expires, then transition the workspace to "Error" status with reason "Bootstrap failed"

**Access Control**:
- **FR-005**: All workspace API endpoints MUST validate that the authenticated user owns the requested workspace
- **FR-006**: Workspace list endpoints MUST filter results to only show workspaces owned by the authenticated user
- **FR-007**: Terminal WebSocket connections MUST validate workspace ownership before establishing the connection
- **FR-008**: Failed ownership validation MUST return a 403 or 404 response (not reveal existence to unauthorized users)

**Provisioning Reliability**:
- **FR-009**: System MUST track workspace creation time and enforce a provisioning timeout
- **FR-010**: Workspaces that do not receive a "ready" callback within the timeout MUST transition to "Error" status
- **FR-011**: Error status MUST include a human-readable reason (e.g., "Provisioning timed out after 10 minutes")
- **FR-012**: Deleting a workspace in any status MUST clean up associated cloud resources (VM, DNS records)

**Connection Stability**:
- **FR-013**: Terminal connections MUST automatically attempt reconnection when the WebSocket closes unexpectedly
- **FR-014**: Reconnection attempts MUST use exponential backoff (starting at 1 second, max 30 seconds)
- **FR-015**: Terminal UI MUST display connection state to the user (Connected, Reconnecting, Failed)
- **FR-016**: After maximum reconnection attempts (5), the terminal MUST stop retrying and display a manual retry option

**Idle Shutdown Experience**:
- **FR-017**: System MUST track a shutdown deadline (absolute timestamp) rather than idle duration
- **FR-018**: Any user activity MUST extend the shutdown deadline by the configured idle timeout period
- **FR-019**: Terminal status bar MUST display the current shutdown deadline in user's local time
- **FR-020**: System MUST display a warning when shutdown deadline is within 5 minutes
- **FR-021**: Heartbeat responses from control plane MUST include the current shutdown deadline

**Code Consolidation**:
- **FR-022**: A shared terminal package MUST provide the core terminal component
- **FR-023**: Both web UI and VM agent UI MUST consume the shared terminal package
- **FR-024**: Shared terminal package MUST include WebSocket connection management with reconnection logic

### Key Entities

- **Bootstrap Token**: A single-use, short-lived token that allows a newly created VM to retrieve its operational credentials. Contains: workspace ID, expiration time, used flag.

- **Shutdown Deadline**: An absolute timestamp representing when a workspace will automatically shut down. Stored per-workspace and extended on activity.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After creating a workspace, examining VM user data in cloud provider console reveals zero sensitive tokens
- **SC-002**: 100% of workspace API endpoints return 403/404 for unauthorized access attempts
- **SC-003**: Workspaces stuck in "Creating" status are automatically marked as "Error" within 15 minutes of creation
- **SC-004**: Terminal reconnects successfully within 10 seconds of network restoration (when workspace is still running)
- **SC-005**: Users can see their workspace shutdown deadline at all times while connected
- **SC-006**: Activity extends shutdown deadline correctly 100% of the time
- **SC-007**: Both web UI and VM agent UI use identical terminal component with consistent behavior

## Assumptions

The following assumptions were made based on the existing system architecture and industry standards:

1. **Provisioning timeout of 10 minutes**: Based on typical VM boot + cloud-init + devcontainer build times. This can be made configurable in future iterations.

2. **Bootstrap token 5-minute expiry**: Provides enough time for VM boot and initial network setup while limiting exposure window.

3. **Exponential backoff for reconnection**: Standard practice (1s, 2s, 4s, 8s, 16s, 30s max) balances responsiveness with avoiding connection flooding.

4. **5-minute warning before shutdown**: Consistent with the existing spec's 5-minute warning period.

5. **30-minute idle timeout**: Using existing configured value from constants.

6. **404 vs 403 for unauthorized access**: Returning 404 prevents information disclosure about workspace existence. This follows security best practices.

## Out of Scope

The following are explicitly NOT part of this hardening effort:

- Rate limiting (deprioritized for self-hosted deployments)
- Agent binary signing (tracked in Issue #1, post-MVP)
- Workspace persistence (tracked in Issue #2, post-MVP)
- Multi-provider support
- Custom idle timeout configuration per workspace
