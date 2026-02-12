# Feature Specification: Multi-Workspace Nodes

**Feature Branch**: `[014-multi-workspace-nodes]`  
**Created**: February 10, 2026  
**Status**: Draft  
**Input**: User description: "I would like to set this project up so that our APIs and UI follow this structure... you have Nodes which are managed by the control plane, then you have Workspaces within the nodes, and you have Agent Sessions within the Workspaces. Right now we have a 1-to-1 mappy from Nodes to Workspaces. But I can see a world where I dont want to spin up multiple nodes, but I _do_ want to spin up multiple \"Workspaces\" (devcontainers) in a single Node (maybe I want multiple, isolated instances of a project in one vm because its the same project and I want to quickly iterate with running projects that wont play nice in one devcontainer).

Use sequential thinking to break down the UI and APIs well need across different systems to make that work. So it should be a bit like: User --has-many--> Nodes --has-many--> Workspaces --has-many--> Agents Sessions Nodes have a single VM Agent, which manages Workspaces and provides an API and UI to deal with"

**Goal**: Enable multiple isolated Workspaces per Node (without provisioning multiple Nodes) while making Agent Sessions a clear, manageable concept within each Workspace.

**Target hierarchy**: User has many Nodes; Node has many Workspaces; Workspace has many Agent Sessions. Each Node runs exactly one Node Agent responsible for managing Workspaces and Agent Sessions on that Node.

## Clarifications

### Session 2026-02-10

- Q: Are Nodes single-user or shareable? -> A: Nodes are owned by exactly one user (no sharing).
- Q: What does stopping/restarting a Workspace mean? -> A: Stop preserves files/config; processes and sessions stop; restart resumes the same Workspace.
- Q: Do Agent Sessions survive Workspace stop/restart? -> A: No; stopping/restarting a Workspace terminates its Agent Sessions and they cannot be re-attached.
- Q: Are Workspace names unique within a Node? -> A: System auto-adjusts duplicate names to a unique name (e.g., by suffixing).
- Q: Do Workspaces need port/network isolation? -> A: Yes; Workspaces can run the same ports concurrently without conflicts via per-Workspace access.

### Session 2026-02-11

- Q: Should this feature include automatic idle shutdown? -> A: No. This feature supports explicit shutdown actions only.
- Q: Is Workspace rename in scope? -> A: Yes. Rename is in scope and uniqueness remains Node-scoped.
- Q: Should Node Agent expose event/log APIs? -> A: Yes. Node-level and Workspace-level event/log endpoints are required.
- Q: Can Node backend endpoints be directly reachable? -> A: Yes, if all sensitive routes remain strongly authenticated/authorized and routing context checks are enforced.
- Q: Do we need a production migration plan for legacy Workspace=VM data? -> A: No. This project is pre-production and can adopt the new model directly.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run Multiple Workspaces on One Node (Priority: P1)

As a user, I can create a Node once and then create multiple isolated Workspaces inside that Node, so I can run separate instances of a project (or different projects) without provisioning multiple Nodes.

**Why this priority**: This is the core value: reducing Node churn while enabling fast iteration with isolated runtime environments.

**Independent Test**: Create a Node, create two Workspaces on that Node, confirm both can be opened and operated independently, then stop one Workspace and confirm the other keeps running.

**Acceptance Scenarios**:

1. **Given** I have no Nodes, **When** I create a Node, **Then** I can see the Node in my Nodes list with a clear status until it is ready to host Workspaces.
2. **Given** I have a ready Node, **When** I create Workspace A on that Node, **Then** Workspace A appears under the Node and becomes ready to use.
3. **Given** I have Workspace A ready on a Node, **When** I create Workspace B on the same Node, **Then** both Workspaces are available and usable at the same time.
4. **Given** two running Workspaces on the same Node, **When** I stop Workspace A, **Then** Workspace A stops and Workspace B remains running and usable.
5. **Given** two Workspaces on the same Node, **When** I make a change (files, processes, runtime state) inside Workspace A, **Then** Workspace B is not affected by that change.

---

### User Story 2 - Create and Manage Agent Sessions in a Workspace (Priority: P2)

As a user, I can start one or more Agent Sessions within a Workspace and later re-open or attach to those sessions, so I can run multiple concurrent coding sessions within the same Workspace context.

**Why this priority**: Once multiple Workspaces exist per Node, users need an equally clear way to manage multiple active sessions within each Workspace.

**Independent Test**: In a single Workspace, start an Agent Session, verify it is listed, refresh the page and attach to it, then start a second session and stop the first.

**Acceptance Scenarios**:

1. **Given** I have a ready Workspace, **When** I start an Agent Session, **Then** I can see that session in the Workspace's session list with a clear running/started status.
2. **Given** an Agent Session is running and the Workspace remains running, **When** I refresh or return later, **Then** I can attach to the same running session.
3. **Given** I have one running Agent Session, **When** I start a second Agent Session in the same Workspace, **Then** both sessions are visible and independently controllable.
4. **Given** I have a running Agent Session, **When** I stop that session, **Then** it transitions to a stopped state and no longer consumes Workspace resources.

---

### User Story 3 - Manage Node Lifecycle Safely (Priority: P3)

As a user, I can stop or delete a Node while understanding the impact on its Workspaces and Agent Sessions, so I can control costs and clean up resources without confusion or accidental data loss.

**Why this priority**: Nodes become longer-lived host resources once they can contain multiple Workspaces; safe lifecycle controls prevent accidental disruption.

**Independent Test**: Create a Node with two running Workspaces and at least one running Agent Session, then stop the Node and observe that the UI clearly communicates what happens to Workspaces/sessions.

**Acceptance Scenarios**:

1. **Given** a Node has one or more running Workspaces, **When** I choose to stop the Node, **Then** I am warned that stopping the Node will stop all Workspaces and Agent Sessions on it.
2. **Given** I confirm stopping the Node, **When** the stop completes, **Then** the Node and its Workspaces are shown as stopped (or unavailable) in the UI.
3. **Given** a Node is stopped, **When** I delete the Node, **Then** the Node is removed from my list and I can no longer access its Workspaces or sessions.

---

### Edge Cases

- What happens when a Node is at capacity and cannot host an additional Workspace?
- What happens when Workspace creation fails part-way through (e.g., dependencies fail, bootstrap fails)?
- What happens when a Workspace is stopped while Agent Sessions are running?
- What happens when the user loses network connectivity while attached to an Agent Session?
- Duplicate Workspace name requests should be automatically adjusted to a unique display name and shown to the user.
- What happens when two Workspaces attempt to run services on the same default port (e.g., both start a web server on the same port)?
- What happens when a Node becomes unhealthy while Workspaces are running?

## Requirements *(mandatory)*

**Definitions**:
- "Control Plane" is the central app users interact with to manage Nodes and access Workspaces.
- "Node Agent" is software running on each Node that manages Workspaces and Agent Sessions within that Node.

**Out of Scope (for this feature)**:
- Automatically moving a running Workspace from one Node to another Node.
- Advanced autoscaling/scheduling policies beyond letting the user choose a Node for a Workspace.
- Shared services between Workspaces (e.g., shared filesystem/process namespace) by default.
- Fine-grained resource quotas per Workspace beyond basic safety limits and clear error handling.
- Sharing Nodes between users or teams.
- Automatic idle shutdown/auto-stop policies.

**Assumptions**:
- Users are already authenticated and the system can reliably identify ownership for Nodes, Workspaces, and Agent Sessions.
- A Node can host multiple Workspaces at the same time, and Workspaces can be created from the same project/repository repeatedly.

**Dependencies**:
- The Node Agent can create, stop, delete, and report status for Workspaces and Agent Sessions.
- The Node Agent can expose Node-level and Workspace-level events/logs for UI and API consumption.
- The Node Agent can send periodic Node health check-ins so stale/unhealthy Nodes can be detected.
- The Node Agent can request credentials from the Control Plane on demand when provisioning/managing Workspaces.
- The Control Plane exposes Node Agent callback endpoints for ready/check-in signaling using callback JWT auth.
- The Control Plane can route a user to the correct Node/Workspace/session access experience while enforcing authorization.

### Functional Requirements

#### Node Management (Control Plane)

- **FR-001**: System MUST allow a user to create a Node that can host one or more Workspaces.
- **FR-002**: System MUST allow a user to list their Nodes and view each Node's status (e.g., creating, ready, stopping, stopped, error).
- **FR-002a**: System MUST track and surface Node health freshness (for example last successful Node Agent heartbeat/check-in) so unhealthy Nodes can be detected and shown to users.
- **FR-002b**: System MUST compute and surface a Node health state (at minimum `healthy` | `stale` | `unhealthy`) using a configurable staleness threshold (for example `NODE_HEARTBEAT_STALE_SECONDS`) rather than a hardcoded timeout.
- **FR-003**: System MUST allow a user to stop a Node, and stopping a Node MUST stop all Workspaces and Agent Sessions running on that Node.
- **FR-004**: System MUST allow a user to delete a Node, and deletion MUST make its Workspaces and sessions inaccessible to the user.

#### Workspace Management (Within a Node)

- **FR-005**: System MUST allow a user to create multiple Workspaces within the same Node.
- **FR-006**: System MUST allow a user to select which Node a new Workspace is created on.
- **FR-007**: System MUST allow a user to list Workspaces within a Node and view each Workspace's status (e.g., creating, ready, stopping, stopped, error).
- **FR-007a**: When a user creates or renames a Workspace to a display name that already exists within the same Node, System MUST automatically adjust it to a unique display name and show the final name to the user.
- **FR-007b**: System MUST allow a user to rename a Workspace without changing its identity, ownership, or URL.
- **FR-008**: System MUST allow a user to open a Workspace and interact with it (at minimum: an interactive terminal plus the ability to browse and edit files within the Workspace).
- **FR-009**: System MUST allow a user to stop, restart, and delete a Workspace without disrupting other Workspaces on the same Node.
- **FR-009a**: When a Workspace is stopped, System MUST preserve the Workspace's files and configuration, and MUST stop any running processes and Agent Sessions within that Workspace.
- **FR-009b**: When a Workspace is restarted, System MUST resume the same Workspace (with preserved files and configuration) and provide a user-visible indication that prior Agent Sessions are no longer running.
- **FR-009c**: System MUST NOT automatically stop Nodes or Workspaces due to idle detection in this feature; lifecycle changes are explicit user/system actions only.
- **FR-009d**: System MUST NOT display idle-shutdown countdowns or warnings in Workspace/Node user interfaces for this feature.
- **FR-010**: System MUST support creating multiple Workspaces from the same repository/project at the same time, within the same Node.
- **FR-011**: By default, Workspaces on the same Node MUST be isolated such that changes within one Workspace (files, running processes, runtime state) do not affect another Workspace.
- **FR-011b**: Workspaces on the same Node MUST be isolated such that two Workspaces can run network services using the same ports at the same time without conflicts, and users can access each Workspace's services independently.

#### Agent Sessions (Within a Workspace)

- **FR-012**: System MUST allow a user to create an Agent Session within a Workspace.
- **FR-012a**: System MUST support idempotent Agent Session creation (for example via client-provided idempotency key) so retried create actions do not create duplicate sessions unintentionally.
- **FR-013**: System MUST allow a user to list Agent Sessions for a Workspace, including whether they are running or stopped.
- **FR-014**: System MUST allow a user to attach to (resume viewing/controlling) a running Agent Session.
- **FR-014a**: System MUST only allow attaching to an Agent Session while it is running within a running Workspace; after a Workspace stop/restart, prior sessions MUST be shown as stopped and MUST not be attachable.
- **FR-014b**: System MUST define deterministic concurrent-attach behavior (single active interactive attachment by default) and return a clear conflict response when another interactive attachment is active unless the caller explicitly requests takeover.
- **FR-014c**: System MUST define deterministic attach/stop race handling; if stop wins, attach fails with a clear non-running conflict, and if attach wins then later stop occurs, the session emits stopped state and closes cleanly.
- **FR-015**: System MUST allow a user to stop an Agent Session without stopping the Workspace.

#### Access Control, Safety, and Observability

- **FR-016**: System MUST enforce that Nodes are owned by exactly one user and only the owner can view and operate on Nodes, Workspaces, and Agent Sessions.
- **FR-016a**: System MUST enforce trusted routing context for proxied Workspace traffic using both Node and Workspace identifiers, and MUST validate user/session auth against the routed Workspace before serving terminal/agent traffic.
- **FR-016b**: System MUST strip any client-supplied routing headers (including `X-SAM-Node-Id` and `X-SAM-Workspace-Id`) at the Control Plane boundary and inject authoritative routing headers derived from trusted Control Plane state.
- **FR-017**: When an action cannot be completed (e.g., Node at capacity, provisioning failure), System MUST show a clear, user-actionable error message.
- **FR-018**: System MUST surface sufficient status and recent activity to let users understand what is happening during Node/Workspace creation (e.g., progress states and recent events).
- **FR-018a**: System MUST provide Node-level and Workspace-level event/log streams so users can inspect provisioning and runtime issues from the Control Plane.
- **FR-018b**: System MUST surface Node heartbeat freshness and health-state transitions in the UI/API within one heartbeat window plus processing delay so users can identify stale Nodes quickly.

**Functional Requirement Coverage (Acceptance Criteria Mapping)**:
- User Story 1 acceptance scenarios validate FR-001, FR-002 through FR-002b, FR-005 through FR-011b, and FR-016 through FR-018b.
- User Story 2 acceptance scenarios validate FR-012 through FR-015 (including FR-012a and FR-014b/FR-014c) and FR-016 through FR-016b.
- User Story 3 acceptance scenarios validate FR-003, FR-004, FR-009c through FR-009d, and FR-016 through FR-018b.

### Key Entities *(include if feature involves data)*

- **Node**: A compute host owned by exactly one user that can run multiple Workspaces and has a single managing agent; includes an identifier, owner, lifecycle status, and basic health information.
- **Workspace**: A user-owned isolated development environment running within a Node; includes an identifier, node association, lifecycle status, and metadata such as display name and source project/repository reference.
- **Agent Session**: A user-owned interactive session running within a Workspace; includes an identifier, workspace association, lifecycle status, timestamps, and user-visible session label.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can create a single Node and successfully create at least 2 Workspaces on that Node without creating additional Nodes.
- **SC-002**: In a usability test, at least 90% of users can create a second Workspace on an existing Node within 2 minutes of starting from the Nodes/Workspaces UI.
- **SC-003**: At least 95% of Workspace creation attempts reach a user-visible "ready" state within 5 minutes under normal operating conditions.
- **SC-004**: Stopping or deleting a Workspace does not interrupt other running Workspaces on the same Node in at least 99% of attempts.
- **SC-005**: At least 95% of attempts to attach to an existing running Agent Session succeed (including after a browser refresh).
- **SC-006**: For users who create multiple Workspaces for the same project, the average number of Nodes created per user decreases by at least 30% compared to baseline.
- **SC-007**: At least 95% of failed Node/Workspace operations include a user-visible event/log entry within 10 seconds of failure.
- **SC-008**: Metrics needed to evaluate SC-002 and SC-006 are captured by telemetry instrumentation in staging before production rollout.
- **SC-009**: At least 95% of stale Node heartbeat conditions are surfaced as `stale` in API/UI within `NODE_HEARTBEAT_STALE_SECONDS` + 30 seconds.
