# Feature Specification: Projects and Tasks Foundation MVP

**Feature Branch**: `016-mvp-project-and`  
**Created**: February 18, 2026  
**Status**: Draft  
**Input**: User description: "Run /speckit.specify for the first two orchestration components: GitHub projects as first-class citizens and tasks; design an MVP with broader-system context and prior-art input."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create and Manage Projects as the Primary Unit (Priority: P1)

A user can create a Project that represents a GitHub repository they have access to via the installed GitHub App. The Project becomes the main place to manage backlog tasks, linked workspaces, and future orchestration.

**Why this priority**: Without Projects, the platform remains workspace-first and cannot support backlog-driven delegation.

**Independent Test**: User creates a Project from an accessible repository, views it in a project list, opens project detail, and edits metadata.

**Acceptance Scenarios**:

1. **Given** an authenticated user with at least one GitHub installation, **When** they create a Project with a valid repository and branch, **Then** the Project is persisted and appears in their Projects list.
2. **Given** a Project exists, **When** the user opens Project details, **Then** they see repository metadata, default branch, and summary counts (tasks by status, linked workspaces).
3. **Given** a user attempts to create a Project from a repository outside their accessible installations, **When** they submit, **Then** the system rejects the request with an authorization error.

---

### User Story 2 - Build and Triage a Project Task Backlog (Priority: P1)

A user can create, edit, prioritize, and move Tasks through a lifecycle on a project-scoped board so work is structured before delegation.

**Why this priority**: Structured tasks are required before any reliable delegation/orchestration can occur.

**Independent Test**: User creates multiple tasks in one Project, edits fields, moves statuses on board/list views, and filters by status/priority.

**Acceptance Scenarios**:

1. **Given** a Project exists, **When** the user creates a Task with title/description/priority, **Then** the Task is saved with default status `draft`.
2. **Given** a Task is `draft`, **When** the user marks it `ready`, **Then** it appears in the ready column/list for delegation preparation.
3. **Given** many tasks exist, **When** the user filters for `in_progress` + high priority, **Then** only matching tasks are returned in consistent sort order.

---

### User Story 3 - Model Task Dependencies Safely (Priority: P1)

A user can define dependency edges between Tasks to express ordering constraints, and the system prevents invalid graphs.

**Why this priority**: Dependency safety is core to future parallelization and orchestration correctness.

**Independent Test**: User adds dependencies, attempts an invalid cycle, and confirms blocked tasks cannot move into executable states until prerequisites complete.

**Acceptance Scenarios**:

1. **Given** Task B depends on Task A, **When** Task A is not `completed`, **Then** Task B is marked blocked for execution and cannot move to `queued`, `delegated`, or `in_progress`.
2. **Given** Task A and Task B already exist, **When** the user tries to create both A->B and B->A, **Then** the second dependency creation is rejected as a cycle.
3. **Given** Task D depends on B and C, **When** B and C become `completed`, **Then** Task D is unblocked and can transition to execution states.

---

### User Story 4 - Manually Delegate a Task to a Workspace (Priority: P2)

A user can assign a `ready` task to an existing workspace (or create a workspace from project context) and track execution output in the task record.

**Why this priority**: MVP needs a bridge from project/tasks to today's workspace runtime without implementing full orchestration automation.

**Independent Test**: User assigns a ready task to a workspace, sees status move to `delegated`/`in_progress`, and records completion metadata (summary, branch, PR URL).

**Acceptance Scenarios**:

1. **Given** a Task is `ready` and unblocked, **When** the user delegates it to a running workspace, **Then** the Task stores `workspaceId`, transitions to `delegated`, and appears in in-flight views.
2. **Given** a delegated task, **When** workspace callbacks report progress/completion, **Then** status and output fields are updated with timestamped history.
3. **Given** a task has output branch and PR URL, **When** the user opens task detail, **Then** they can review result metadata without opening raw workspace session logs.

---

### Edge Cases

- Project creation attempted with a repository that was accessible earlier but lost access (installation removed/revoked).
- Duplicate project names with case/whitespace variants (must normalize uniqueness per user scope).
- Task dependency references a task in a different project (must be rejected).
- Deep dependency chains or high fan-in/fan-out graphs that exceed configurable dependency limits.
- Dependency edits while tasks are actively moving states (must preserve graph consistency).
- Delegation attempted on a blocked task or a task not in `ready` state.
- Workspace assigned to task belongs to another user (must be rejected by ownership checks).
- Workspace deleted/stopped during task execution; task must transition to a recoverable failure/blocked state with explicit reason.

## Requirements *(mandatory)*

**Definitions**:
- "Project" means a project-scoped control-plane entity backed by a GitHub repository reference.
- "Task" means a project-scoped work item with lifecycle state and optional dependency edges.
- "Manual delegation" means user-initiated task assignment to a workspace without scheduler/orchestrator automation.

### Functional Requirements

#### Projects (GitHub Repos as First-Class Entities)

- **FR-001**: System MUST allow authenticated users to create a Project with at least: project name, GitHub installation reference, repository (`owner/repo`), and default branch.
- **FR-002**: System MUST allow users to list and view only Projects they own.
- **FR-003**: System MUST allow users to update Project metadata (name, description, default branch) without changing project identity.
- **FR-004**: System MUST enforce repository access checks against the user's current GitHub installation permissions at Project create/update time.
- **FR-005**: System MUST enforce normalized unique Project names per user scope.
- **FR-006**: System MUST persist Project ownership (`user_id`) and audit fields (`created_by`, timestamps) for all Project records.
- **FR-007**: System MUST provide project-scoped summary data (task counts by status, linked workspace count) on Project detail responses.
- **FR-008**: System MUST provide Project CRUD API endpoints under `/api/projects` with consistent error response format.

#### Tasks (Work Items and Lifecycle)

- **FR-009**: System MUST allow users to create Tasks under a Project with required title and optional description, priority, and agent-profile hint.
- **FR-010**: System MUST support task lifecycle states: `draft`, `ready`, `queued`, `delegated`, `in_progress`, `completed`, `failed`, `cancelled`.
- **FR-011**: System MUST enforce valid task state transitions and reject invalid transitions with a structured error.
- **FR-012**: System MUST allow users to list/filter/sort tasks by project, status, priority, and creation/update time.
- **FR-013**: System MUST allow users to edit task title/description/priority while preserving immutable ownership and identity fields.
- **FR-014**: System MUST persist task execution metadata fields: `workspaceId`, `startedAt`, `completedAt`, `errorMessage`, `outputSummary`, `outputBranch`, `outputPrUrl`.
- **FR-015**: System MUST expose task CRUD and status update endpoints under `/api/projects/:projectId/tasks` (or equivalent project-scoped route family).

#### Task Dependencies (DAG Constraints)

- **FR-016**: System MUST allow users to create and remove dependency edges between tasks in the same Project.
- **FR-017**: System MUST reject self-dependency and any dependency write that creates a cycle in the task graph.
- **FR-018**: System MUST compute and expose whether a task is blocked based on unresolved dependencies.
- **FR-019**: System MUST prevent blocked tasks from entering executable states (`queued`, `delegated`, `in_progress`).
- **FR-020**: System MUST support parent-child task decomposition via optional `parentTaskId` while keeping dependency edges explicit.
- **FR-021**: System MUST provide dependency-management endpoints and return dependency information in task detail responses.

#### Manual Delegation Bridge (MVP Integration with Existing Workspace Model)

- **FR-022**: System MUST allow users to manually assign a `ready` and unblocked task to an owned workspace.
- **FR-023**: On manual assignment, System MUST set `workspaceId`, transition task state to `delegated`, and append status-history metadata.
- **FR-024**: System MUST accept trusted workspace callback updates to move delegated tasks into `in_progress`, `completed`, or `failed`.
- **FR-025**: System MUST enforce ownership checks on delegation and callback paths (`task.userId`, `project.userId`, `workspace.userId` must match authenticated/validated caller context).
- **FR-026**: System MUST preserve existing workspace lifecycle APIs and behavior; this feature adds project/task context but does not replace workspace control flows.

#### Configuration and Constitution Alignment

- **FR-027**: System MUST make all new operational limits configurable (for example: `MAX_PROJECTS_PER_USER`, `MAX_TASKS_PER_PROJECT`, `MAX_TASK_DEPENDENCIES_PER_TASK`, pagination limits) with documented defaults.
- **FR-028**: System MUST make any new timeout/retry behavior introduced for task assignment or callbacks configurable via environment variables with defaults.
- **FR-029**: System MUST avoid hardcoded internal service URLs; all internal URL construction must derive from existing environment-driven patterns (for example `BASE_DOMAIN` subdomain rules).
- **FR-030**: System MUST return API errors in the project-standard format `{ error, message }`.

### Key Entities *(include if feature involves data)*

- **Project**: Top-level user-owned planning container representing a GitHub repository context. Key attributes: `id`, `userId`, `name`, `description`, `installationId`, `repository`, `defaultBranch`, audit timestamps.
- **Task**: Project-scoped work item with lifecycle, priority, optional parent relation, and execution metadata. Key attributes: `id`, `projectId`, `parentTaskId`, `title`, `description`, `status`, `priority`, `workspaceId`, output fields.
- **TaskDependency**: Directed edge representing "Task A depends on Task B" within one project. Key attributes: `taskId`, `dependsOnTaskId`, timestamps.
- **TaskStatusEvent**: Immutable status transition log entry for observability/audit. Key attributes: `taskId`, `fromStatus`, `toStatus`, `actorType`, `actorId`, `timestamp`, optional `reason`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 90% of users can create a Project from an accessible GitHub repository in under 2 minutes.
- **SC-002**: At least 95% of Project list/detail requests return in under 500 ms at P95 under normal load.
- **SC-003**: At least 95% of task create/update operations return in under 300 ms at P95 under normal load.
- **SC-004**: 100% of attempted dependency cycle creations are rejected with deterministic validation errors.
- **SC-005**: At least 95% of users can move a task from `draft` to `ready` and delegate it manually within 3 minutes.
- **SC-006**: At least 95% of delegated tasks that receive workspace callbacks reflect status changes in the task view within 5 seconds.
- **SC-007**: 100% of unauthorized cross-user project/task/workspace operations are rejected by ownership checks.
- **SC-008**: Operational limits and timeouts introduced by this feature are fully configurable and documented before rollout.

## Assumptions

- Existing GitHub App installation/repository listing APIs remain available and continue to provide repository access context.
- Existing workspace CRUD and callback flows remain the execution runtime; this feature only adds project/task planning and linking.
- MVP remains single-user ownership scope (no organization/team sharing in this feature).
- Task board/list UI can be delivered incrementally (table first, board view next) without changing underlying task lifecycle semantics.

## Scope Boundaries

### In Scope

- Project CRUD with repository linkage and ownership enforcement.
- Project-scoped task CRUD, lifecycle transitions, filtering, and prioritization.
- Task dependency CRUD with DAG validation and blocked-state enforcement.
- Manual task-to-workspace delegation and callback-driven status updates.
- Configurable limits/timeouts for newly introduced project/task operations.

### Out of Scope

- Automated orchestration scheduling/provisioning ("delegate selected" scheduler).
- Orchestration runs, lead/worker coordination, and SAM MCP server tooling.
- Organization multi-tenancy, RBAC expansion, and shared project ownership.
- Full multi-repo execution semantics (cross-repo task routing and branch coordination).
- Bi-directional sync with external trackers (GitHub Issues/Projects, Linear, Jira) beyond initial repository linkage.

## Prior Art and Best-Practice Inputs

- GitHub Projects emphasizes flexible views (table/board/roadmap), custom fields, and workflow automation; this informs the MVP requirement for project-scoped task lifecycle fields and board/list workflows before heavy automation.
- GitHub Issues supports both sub-issues and explicit issue dependencies; this informs separate modeling of parent-child decomposition (`parentTaskId`) and explicit dependency edges (`TaskDependency`).
- Linear and Jira both model "blocked by" relationships as first-class planning constraints; this supports enforcing blocked-state gating before execution transitions.
- GitHub's project and issue APIs provide a path for future sync/automation, but MVP keeps SAM as source-of-truth for project/task state to reduce coupling and rollout risk.

Reference links:
- https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects
- https://docs.github.com/en/issues/tracking-your-work-with-issues/about-sub-issues
- https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies
- https://linear.app/docs/issue-relations-and-dependencies
- https://support.atlassian.com/jira-software-cloud/docs/what-are-issue-links/
