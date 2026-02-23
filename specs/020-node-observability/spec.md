# Feature Specification: Node-Level Observability & Log Aggregation

**Feature Branch**: `020-node-observability`
**Created**: February 23, 2026
**Status**: Draft
**Input**: User description: "Better observability at the node level. A unified log viewer on the node info page that aggregates VM agent logs, cloud-init logs, Docker container logs, and systemd journal entries. Fix the broken Docker container listing. Migrate VM agent from Go log package to slog for structured logging."

**Goal**: Provide complete visibility into node-level activity by aggregating all log sources (VM agent, cloud-init, Docker containers, systemd) into a unified, filterable log viewer on the node info page, and fix the broken Docker container listing that currently shows no containers even when devcontainers are running.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Diagnose Overnight Agent Failures (Priority: P1)

As a user who leaves agents running overnight, I want to view all node logs from the control plane so that when I find 500 errors the next morning, I can quickly identify what went wrong without needing to SSH into the VM.

**Why this priority**: This is the core problem motivating the feature. Without log visibility, overnight failures are a black box. Users cannot diagnose issues, leading to wasted time and lost confidence in the platform.

**Independent Test**: Create a node with a running workspace, trigger an error condition (e.g., restart Docker to cause temporary container failures), then navigate to the node info page and verify the error appears in the log viewer with enough context to diagnose the root cause.

**Acceptance Scenarios**:

1. **Given** a running node with workspaces, **When** I navigate to the node info page, **Then** I see a Logs section that displays recent log entries from the VM agent.
2. **Given** a node that experienced errors (e.g., agent crashes, Docker failures, endpoint 500s), **When** I view the log viewer, **Then** I can see error-level entries clearly highlighted with timestamps, source identification, and the error details.
3. **Given** a node with accumulated logs, **When** I filter by log level (e.g., "error" or "warning"), **Then** I see only entries matching that severity, allowing me to quickly find problems without scrolling through info-level noise.
4. **Given** a node with logs from multiple sources, **When** I filter by source (e.g., "agent", "docker", "cloud-init"), **Then** I see only entries from that source, allowing me to isolate issues to a specific subsystem.
5. **Given** the log viewer is open, **When** new log entries are generated on the node, **Then** I see them appear in near-real-time without needing to manually refresh the page.

---

### User Story 2 - View Docker Container Status Accurately (Priority: P1)

As a user, I want to see which Docker containers are actually running on my node so that I can confirm my devcontainers are up and troubleshoot when they are not.

**Why this priority**: The Docker container listing is currently broken — it shows "No running containers" even when containers are running. This is a critical observability gap that undermines trust and blocks basic troubleshooting. It is equal priority with log viewing because it is a bug fix, not a new feature.

**Independent Test**: Create a node, provision a workspace with a devcontainer, then navigate to the node info page and verify the container appears in the Docker section with accurate status information.

**Acceptance Scenarios**:

1. **Given** a node with running devcontainers, **When** I view the Docker section on the node info page, **Then** I see all running containers listed with their name, image, status, and resource usage.
2. **Given** a node with containers in various states (running, stopped, exited), **When** I view the Docker section, **Then** I see containers in all states, not just running ones, with clear status indicators.
3. **Given** a node where the container query fails (e.g., Docker daemon is unresponsive), **When** I view the Docker section, **Then** I see a clear error message indicating the query failed, rather than "No running containers."
4. **Given** a node with multiple containers (devcontainers plus utility containers like repo-copy), **When** I view the Docker section, **Then** all containers are shown, not just those matching specific labels.

---

### User Story 3 - View Cloud-Init Provisioning Logs (Priority: P2)

As a user, I want to view the cloud-init logs from when my node was first provisioned so that when provisioning fails or behaves unexpectedly, I can see what happened during VM setup.

**Why this priority**: Provisioning failures are common during initial setup and after platform updates. Cloud-init logs are currently trapped on the VM with no way to access them from the control plane. This is important but less frequently needed than ongoing runtime logs.

**Independent Test**: Create a new node, wait for provisioning to complete, then navigate to the node info page and verify that cloud-init log entries are visible in the log viewer.

**Acceptance Scenarios**:

1. **Given** a node that has completed provisioning, **When** I filter the log viewer to "cloud-init" source, **Then** I see the cloud-init setup output including package installation, service setup, and any errors.
2. **Given** a node where cloud-init partially failed (e.g., a package failed to install), **When** I view the cloud-init logs, **Then** I can see the specific failure message and which step failed.
3. **Given** a newly created node still in the "creating" state, **When** I view the log viewer, **Then** I can see cloud-init progress in real-time as provisioning proceeds.

---

### User Story 4 - View Docker Container Logs (Priority: P2)

As a user, I want to view the stdout/stderr output from individual Docker containers so that I can debug application-level issues within my devcontainers.

**Why this priority**: Container logs are essential for debugging workspace-level issues (e.g., build failures, dependency errors, agent crashes inside containers). This extends the log viewer beyond system-level observability into application-level debugging.

**Independent Test**: Create a workspace with a devcontainer that produces output (e.g., runs a build), then navigate to the node info page, filter logs to that container, and verify the build output is visible.

**Acceptance Scenarios**:

1. **Given** a node with running containers, **When** I filter the log viewer to a specific container name, **Then** I see the stdout/stderr output from that container.
2. **Given** a container that has exited with an error, **When** I view its logs, **Then** I see the error output that caused it to exit.
3. **Given** multiple containers running on a node, **When** I view all Docker logs without filtering to a specific container, **Then** each log entry is clearly labeled with the container name it came from.

---

### User Story 5 - Search and Navigate Logs (Priority: P3)

As a user, I want to search through logs using keywords so that I can find specific events without manually scrolling through potentially thousands of entries.

**Why this priority**: Search is a quality-of-life improvement that becomes essential as log volume grows. Basic viewing and filtering (Stories 1-4) must work first, but search makes the log viewer truly useful for diagnosing complex issues.

**Independent Test**: Accumulate logs on a node, then use the search functionality to find a specific error message and verify it highlights and navigates to matching entries.

**Acceptance Scenarios**:

1. **Given** the log viewer with accumulated entries, **When** I enter a search term (e.g., "connection refused"), **Then** the viewer highlights or filters to entries containing that term.
2. **Given** a search with multiple matches, **When** I view the results, **Then** I can see how many matches were found and navigate between them.
3. **Given** a long log history, **When** I combine search with source and level filters, **Then** the filters compose correctly (e.g., search "timeout" within "error" level from "agent" source).

---

### Edge Cases

- What happens when a node is stopped and then restarted — are logs from before the restart still accessible?
- What happens when log volume exceeds the configured disk cap on the VM — how is the user informed?
- What happens when the VM agent restarts (e.g., after a crash or update) — are pre-restart logs preserved?
- What happens when a container is removed — are its logs still available?
- What happens when the user has a slow or intermittent network connection — does the real-time log stream reconnect gracefully?
- What happens when hundreds of log entries arrive per second (e.g., during a build) — does the UI remain responsive?
- What happens when the log viewer is open but the node becomes unreachable — is the user informed clearly?

## Requirements *(mandatory)*

**Definitions**:
- "Log source" is an origin of log entries: VM agent, cloud-init, Docker container, or systemd journal.
- "Log entry" is a single line/event from a log source with timestamp, level, source identifier, and message content.
- "Log viewer" is the UI component on the node info page that displays, filters, and searches log entries.

**Out of Scope (for this feature)**:
- Log forwarding to external services (e.g., Elasticsearch, Loki, Datadog).
- Workspace-level log viewers (this feature is node-level only).
- Log-based alerting or automated notifications.
- Log export/download to files.
- Cross-node log aggregation or centralized log search across multiple nodes.

**Assumptions**:
- Nodes run Ubuntu with systemd and journald available (current cloud-init template confirms this).
- Docker is installed on nodes and containers produce stdout/stderr output (current setup confirms this).
- The VM agent has filesystem access to cloud-init log files at standard locations.
- Users access the log viewer through the existing authenticated control plane UI.
- Log retention is bounded by VM disk space and configurable limits.

**Dependencies**:
- The VM agent can read from systemd journal, cloud-init log files, and Docker container logs.
- The VM agent can expose log data via authenticated HTTP endpoints.
- The control plane can proxy log requests to the VM agent (existing pattern via `nodeAgentRequest()`).
- The existing node info page can accommodate an additional section for the log viewer.

### Functional Requirements

#### Log Collection (VM Agent)

- **FR-001**: The VM agent MUST produce structured log entries with at minimum: timestamp, severity level, source identifier, and message content.
- **FR-002**: The VM agent MUST persist its own log entries to a location readable after agent restarts, so that logs are not lost when the process restarts.
- **FR-003**: The VM agent MUST collect log entries from cloud-init output files (`/var/log/cloud-init.log` and `/var/log/cloud-init-output.log` on standard Ubuntu).
- **FR-004**: The VM agent MUST collect log entries from all Docker containers on the node, including devcontainers, utility containers, and any other containers managed by the platform.
- **FR-005**: The VM agent MUST collect log entries from the systemd journal for its own service unit.
- **FR-006**: The total disk space used by persisted logs MUST be bounded by a configurable maximum (with a sensible default) to prevent disk exhaustion. When the limit is approached, the oldest logs MUST be discarded.
- **FR-007**: Log collection MUST NOT degrade VM agent performance or interfere with workspace operations. Log writing and aggregation MUST happen asynchronously.

#### Log Retrieval (VM Agent Endpoints)

- **FR-008**: The VM agent MUST expose an authenticated endpoint that returns log entries in reverse chronological order with pagination support (cursor-based).
- **FR-009**: The log retrieval endpoint MUST support filtering by: log source (agent, cloud-init, docker, all), log level (debug, info, warn, error), container name (for Docker source), and time range.
- **FR-010**: The VM agent MUST expose an authenticated endpoint for real-time log streaming so that new entries are delivered to the client as they occur.
- **FR-011**: Each log entry returned by the endpoints MUST include: timestamp, severity level, source identifier (e.g., "agent", "cloud-init", "docker:container-name"), and message content.

#### Docker Container Listing (Bug Fix)

- **FR-012**: The system MUST accurately list all Docker containers on the node, including containers in all states (running, stopped, exited, paused, created).
- **FR-013**: When the Docker container query fails (daemon unreachable, timeout, permission error), the system MUST surface a clear error state to the user rather than showing "No running containers."
- **FR-014**: The Docker container listing MUST include: container ID, name, image, current status, and resource usage (CPU, memory) for running containers.
- **FR-015**: The Docker section MUST distinguish between "no containers exist" and "unable to query containers" states in the UI.

#### Control Plane Proxy

- **FR-016**: The control plane API MUST expose proxy endpoints for node log retrieval and streaming, following the same authentication and authorization patterns as existing node proxy endpoints.
- **FR-017**: The control plane MUST enforce that only the node owner can access log endpoints for their nodes.

#### Log Viewer UI

- **FR-018**: The node info page MUST include a Logs section that displays log entries from all sources in a unified, chronologically ordered view.
- **FR-019**: The log viewer MUST provide filter controls for: log source (agent, cloud-init, docker, all), log level (debug, info, warn, error), and optionally container name.
- **FR-020**: The log viewer MUST support a real-time streaming mode where new entries appear automatically as they are generated.
- **FR-021**: The log viewer MUST support pausing the real-time stream so the user can read entries without them scrolling away.
- **FR-022**: The log viewer MUST provide a text search capability to find entries containing specific keywords.
- **FR-023**: Log entries in the viewer MUST be visually differentiated by severity level (e.g., errors highlighted differently from info messages).
- **FR-024**: The log viewer MUST remain responsive when displaying large volumes of log entries (e.g., virtualized scrolling for hundreds or thousands of entries).
- **FR-025**: The log viewer MUST gracefully handle the node becoming unreachable (e.g., showing a disconnected state and attempting to reconnect).

#### Structured Logging Migration

- **FR-026**: The VM agent MUST use structured logging (key-value pairs) for all internal log output, replacing unstructured text logging.
- **FR-027**: The structured logging MUST use log levels consistently: DEBUG for diagnostic detail, INFO for normal operations, WARN for recoverable issues, ERROR for failures requiring attention.
- **FR-028**: The structured logging MUST bridge any existing standard-library log calls so that third-party library output is also captured in structured format.

### Key Entities

- **Log Entry**: A single event from any source on a node; includes timestamp, severity level (debug/info/warn/error), source identifier (agent, cloud-init, docker:{container-name}, systemd), and message content. Optionally includes structured key-value metadata.
- **Log Source**: An origin of log entries on a node. Types: agent (VM agent application logs), cloud-init (provisioning logs), docker (container stdout/stderr), systemd (journal entries for the agent service unit).
- **Log Stream**: A real-time feed of new log entries from a node, delivered via persistent connection, supporting the same filters as the retrieval endpoint.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can view VM agent logs, cloud-init logs, and Docker container logs from the node info page without needing SSH or direct VM access.
- **SC-002**: At least 95% of Docker container listing requests accurately reflect the actual container state on the node (i.e., if containers are running, they appear in the listing).
- **SC-003**: When a Docker query fails, 100% of failure cases show an error indicator in the UI rather than the misleading "No running containers" message.
- **SC-004**: Users can find a specific error event in the log viewer within 30 seconds using source/level filters and text search.
- **SC-005**: New log entries appear in the real-time streaming view within 5 seconds of being generated on the node.
- **SC-006**: The log viewer remains responsive (no visible lag or freezing) when displaying 10,000+ accumulated log entries.
- **SC-007**: Log disk usage on the node does not exceed the configured maximum, even after extended periods of high-volume logging.
- **SC-008**: The log viewer correctly reconnects after temporary network interruptions without losing the user's filter/search state.
- **SC-009**: All VM agent log output is structured (key-value format) rather than unstructured text, enabling consistent parsing and filtering.
