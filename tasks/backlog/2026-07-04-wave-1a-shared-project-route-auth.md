# Wave 1A Shared Project Route Authorization

## Problem

The membership foundation is merged, but core project/chat/task/workspace API routes still authorize projects with `requireOwnedProject`. Active admin members therefore cannot use shared projects even though `project_members` and capability helpers exist. Migrate only the scoped Wave 1A route family to active membership/capability authorization while preserving owner-only deletion and user-scoped actor/credential boundaries.

## Research Findings

- `apps/api/src/middleware/project-auth.ts` exports `requireProjectAccess` and `requireProjectCapability`; admins have every capability except `project:delete`.
- Migration `0081_project_members.sql` backfilled owners into `project_members`, so replacing owner checks with membership checks should preserve existing owner access.
- Scoped route files still contain `requireOwnedProject` imports/calls across activity, chat, project CRUD, project credentials/files/repository access, task CRUD/run/submit/upload, and workspace CRUD.
- Existing middleware tests cover the helpers themselves, but this task needs route-level tests proving an active admin member reaches migrated shared-project routes and non-members are rejected.
- GitHub and credential token minting must remain user-scoped: route project access can become membership-based, but routes that validate or use the caller's GitHub/credential identity must not let a member act through the project owner's identity.
- Session/task/workspace creator semantics must be preserved where the current action acts on a concrete owner-scoped resource.

## Checklist

- [ ] Inspect each scoped route and classify current `requireOwnedProject` calls as read visibility, write/management, delete, or creator/user-scoped action.
- [ ] Replace scoped `requireOwnedProject` imports/calls with `requireProjectAccess` or `requireProjectCapability` using the narrowest relevant capability.
- [ ] Keep owner-only project deletion on `project:delete`.
- [ ] Preserve existing actor/audit `userId` usage and any task/session/workspace owner checks that protect concrete user-owned resources.
- [ ] Keep GitHub repository/token access user-scoped at token mint boundaries.
- [ ] Add focused route tests for active admin-member access and non-member rejection.
- [ ] Run relevant API/unit tests.
- [ ] Grep the scoped file list to verify `requireOwnedProject` no longer remains there.

## Acceptance Criteria

- Active admin project members can read/write the migrated shared-project route family where capability policy allows it.
- Non-members and inactive members remain rejected.
- Project deletion remains owner-only via `project:delete`.
- Route actions that submit messages to live sessions or mint/use personal GitHub credentials do not let one member impersonate another user.
- No `requireOwnedProject` usage remains in the scoped files listed in the task request.

## References

- `apps/api/src/middleware/project-auth.ts`
- `apps/api/src/db/migrations/0081_project_members.sql`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/routes/tasks/crud.ts`
- `apps/api/src/routes/workspaces/crud.ts`
- `.claude/rules/06-api-patterns.md`
- `.claude/rules/35-vertical-slice-testing.md`
