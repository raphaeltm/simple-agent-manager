# Data Model: Projects and Tasks Foundation MVP

**Phase 1 output** | **Date**: 2026-02-18

## Overview

This model introduces project-first planning entities on top of existing user/workspace infrastructure.

New entities:
- `projects`
- `tasks`
- `task_dependencies`
- `task_status_events`

Existing entities referenced:
- `users`
- `github_installations`
- `workspaces`

## Entity Definitions

### Project

Top-level user-owned planning container linked to one GitHub repository context in MVP.

| Field | Type | Notes |
|------|------|------|
| `id` | TEXT (PK) | ULID |
| `user_id` | TEXT (FK -> users.id) | Owner |
| `name` | TEXT | Display name |
| `normalized_name` | TEXT | Case/whitespace-normalized uniqueness key |
| `description` | TEXT nullable | Optional |
| `installation_id` | TEXT (FK -> github_installations.id) | GitHub app installation row |
| `repository` | TEXT | `owner/repo` |
| `default_branch` | TEXT | Default execution branch |
| `created_by` | TEXT (FK -> users.id) | Audit |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |

**Constraints**:
- Unique index on (`user_id`, `normalized_name`)
- Unique index on (`user_id`, `installation_id`, `repository`) for MVP single-repo mapping
- FK ownership consistency enforced in application layer (`project.user_id == installation.user_id`)

---

### Task

Project-scoped work item with lifecycle state and optional decomposition link.

| Field | Type | Notes |
|------|------|------|
| `id` | TEXT (PK) | ULID |
| `project_id` | TEXT (FK -> projects.id) | Parent project |
| `user_id` | TEXT (FK -> users.id) | Denormalized owner for efficient ownership filters |
| `parent_task_id` | TEXT nullable (FK -> tasks.id) | Optional decomposition parent |
| `workspace_id` | TEXT nullable (FK -> workspaces.id) | Set on delegation |
| `title` | TEXT | Required |
| `description` | TEXT nullable | Optional detail/prompt |
| `status` | TEXT | See lifecycle below |
| `priority` | INTEGER | Higher means more urgent |
| `agent_profile_hint` | TEXT nullable | Planning hint only in MVP |
| `started_at` | TEXT nullable | Execution metadata |
| `completed_at` | TEXT nullable | Execution metadata |
| `error_message` | TEXT nullable | Failure reason |
| `output_summary` | TEXT nullable | Result summary |
| `output_branch` | TEXT nullable | Git branch produced |
| `output_pr_url` | TEXT nullable | PR URL |
| `created_by` | TEXT (FK -> users.id) | Audit |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |

**Constraints**:
- FK ownership consistency checks in application layer:
  - `task.user_id == project.user_id`
  - `workspace.user_id == task.user_id` for delegation
- Indexes for list/filter:
  - (`project_id`, `status`, `priority`, `updated_at`)
  - (`project_id`, `created_at`)

---

### TaskDependency

Explicit directed dependency edge (`task_id` depends on `depends_on_task_id`).

| Field | Type | Notes |
|------|------|------|
| `task_id` | TEXT (FK -> tasks.id) | Dependent task |
| `depends_on_task_id` | TEXT (FK -> tasks.id) | Prerequisite task |
| `created_by` | TEXT (FK -> users.id) | Audit |
| `created_at` | TEXT | ISO timestamp |

**Primary Key**: (`task_id`, `depends_on_task_id`)

**Constraints**:
- `task_id != depends_on_task_id`
- Both tasks must belong to same `project_id`
- Dependency write must not introduce cycles

---

### TaskStatusEvent

Append-only lifecycle audit trail for status transitions and delegation events.

| Field | Type | Notes |
|------|------|------|
| `id` | TEXT (PK) | ULID |
| `task_id` | TEXT (FK -> tasks.id) | Parent task |
| `from_status` | TEXT nullable | Nullable for initial creation event |
| `to_status` | TEXT | New status |
| `actor_type` | TEXT | `user` \| `system` \| `workspace_callback` |
| `actor_id` | TEXT nullable | User id, workspace id, or null for system |
| `reason` | TEXT nullable | Human-readable context |
| `created_at` | TEXT | ISO timestamp |

**Indexes**:
- (`task_id`, `created_at` desc)

## Relationships

- User `1:N` Projects
- User `1:N` Tasks (denormalized ownership)
- Project `1:N` Tasks
- Task `0..1:N` Task (parent-child decomposition)
- Task `N:N` Task via TaskDependency
- Task `1:N` TaskStatusEvent
- Workspace `1:N` Task (via `workspace_id` assignment history on task row; single active assignment in MVP)

## Lifecycle State Machines

### Task Lifecycle

Allowed statuses:
- `draft`
- `ready`
- `queued`
- `delegated`
- `in_progress`
- `completed`
- `failed`
- `cancelled`

Allowed transitions:
- `draft -> ready | cancelled`
- `ready -> queued | delegated | cancelled`
- `queued -> delegated | failed | cancelled`
- `delegated -> in_progress | failed | cancelled`
- `in_progress -> completed | failed | cancelled`
- `failed -> ready | cancelled`
- `cancelled -> ready` (optional reopen)

Terminal semantics:
- `completed` is terminal for MVP (reopen via explicit clone/new task, not direct transition)

Blocked-state rule:
- A task with unresolved dependencies is **blocked** and cannot move to `queued`, `delegated`, or `in_progress`.

## Validation Rules

### Ownership and Access

- Every Project route enforces `projects.user_id == authenticated_user.id`.
- Every Task/Dependency route enforces project ownership before mutation.
- Delegation enforces `workspaces.user_id == tasks.user_id`.
- Workspace callback updates require trusted callback token + workspace/task ownership alignment.

### Dependency Graph Integrity

- Reject self-dependencies.
- Reject edges across projects.
- Reject edge creates/updates that introduce cycles.
- Reject deletion of tasks that are dependency prerequisites unless dependency edges are removed first.

### Delegation Integrity

- Only `ready` and unblocked tasks can be delegated.
- Delegation requires workspace status compatible with execution (`running` in MVP).
- On delegation: set `workspace_id`, set/append status event, and update execution timestamps as status progresses.
- Trusted delegated-task callbacks are accepted via `POST /api/projects/:projectId/tasks/:taskId/status/callback` with callback-token verification and workspace/task binding checks.

## Suggested Migration Set (Conceptual)

1. Add `projects` table + indexes.
2. Add `tasks` table + indexes.
3. Add `task_dependencies` table + FK constraints.
4. Add `task_status_events` table + indexes.
5. Register new route modules and shared types.

## Configuration Hooks (Principle XI)

All operational limits/timeouts introduced by this feature must use env-overridable defaults:

- `MAX_PROJECTS_PER_USER`
- `MAX_TASKS_PER_PROJECT`
- `MAX_TASK_DEPENDENCIES_PER_TASK`
- `TASK_LIST_DEFAULT_PAGE_SIZE`
- `TASK_LIST_MAX_PAGE_SIZE`
- `TASK_CALLBACK_TIMEOUT_MS`
- `TASK_CALLBACK_RETRY_MAX_ATTEMPTS`

Pattern requirement:
- Default constants in code + environment overrides (no hardcoded runtime-only values).
