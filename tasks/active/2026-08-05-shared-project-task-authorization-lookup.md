# Fix shared-project task authorization lookup consistency

## Problem

Active project admins and maintainers have `task:write` and can already modify owner-created project tasks through the general CRUD/status paths. Some execution/lifecycle paths still perform owner-only task lookup after the project capability check, causing authorized project members to be rejected.

Scope is R1 finding 1 only: switch task lookup semantics for the affected task operations to project-authorized lookup while preserving caller-scoped credentials, compute, workspace ownership, and cleanup safety.

## Research Findings

- `apps/api/src/routes/tasks/run.ts` checks `requireProjectCapability(..., 'task:write')` but then calls `requireOwnedTask(...)`, which blocks admins/maintainers from running owner-created tasks.
- The run path also loads the project with `project.id AND project.userId = caller`, which blocks shared project members after task lookup is fixed. This needs project lookup via the already-authorized project resource while keeping GitHub repo access and credentials evaluated for the caller.
- Run dependency status lookup is currently filtered by `tasks.userId = caller`; for shared project tasks, dependency resolution must remain project-scoped so owner-created dependencies are evaluated correctly.
- `apps/api/src/routes/tasks/crud.ts` delegate path checks `task:write` but calls `requireOwnedTask(...)`, which blocks admins/maintainers. The target workspace lookup must remain `requireOwnedWorkspace(...)` so a member cannot delegate into or delete another user's workspace.
- `apps/api/src/routes/tasks/crud.ts` conversation close checks `task:write` but calls `requireOwnedTaskById(...)`, which blocks admins/maintainers. Its cleanup query already filters workspace by caller user/project; preserve that safety so closing another user's conversation task cannot delete their workspace.
- Terminal-status cleanup via `POST /status` already uses project-scoped task lookup and delegates to shared cleanup. Manual `POST /run/cleanup` still calls `requireOwnedTask(...)` and should use project-scoped task lookup while the underlying cleanup service preserves task/workspace ownership semantics.
- Existing project task CRUD/status routes use `requireProjectTaskById(...)` after `requireProjectCapability(...)`; that is the intended lookup pattern for project-owned tasks.

## Implementation Checklist

- [x] Update run task lookup to project-scoped semantics after `task:write` authorization.
- [x] Update run project/dependency lookup to support shared project members without weakening caller-scoped credentials, repo-access, or compute attribution.
- [x] Update manual terminal cleanup task lookup to project-scoped semantics only.
- [x] Update delegate task lookup to project-scoped semantics while preserving caller-owned workspace requirement.
- [x] Update conversation close task lookup to project-scoped semantics while preserving caller-owned workspace cleanup filter.
- [x] Add positive tests for admin/maintainer acting on owner-created tasks across run, delegate, terminal cleanup, and conversation close.
- [x] Add negative tests for viewer, nonmember, wrong project, cross-user workspace, and cleanup/close safety.
- [x] Run relevant API quality checks and local reviewer validations.
- [ ] Open a tightly scoped PR and do not merge it.

## Acceptance Criteria

- Active project admin/maintainer with `task:write` can run, delegate, clean up terminal runs, and close conversation-mode tasks created by another project member.
- Viewers and nonmembers cannot perform write operations.
- Wrong-project task IDs are not accessible through another project route.
- Delegate requires a running workspace owned by the caller.
- Conversation close never deletes another user's workspace.
- Run uses the caller's cloud credentials, repo access, identity, and compute context.
- Public API shape, defaults, response formats, and existing owner behavior remain unchanged.

