# Wave 1B Automation/Context Membership Auth

## Problem

Wave 1B should migrate the automation/context route family from owner-only project authorization to membership/capability authorization. Shared project admins should be able to access and mutate representative automation/context resources, while non-members remain rejected.

## Research Findings

- Membership foundation is present in `apps/api/src/middleware/project-auth.ts` with `requireProjectAccess` and `requireProjectCapability`.
- Scoped files still use `requireOwnedProject` directly across route guards for agent profiles, cached commands, knowledge, library, mailbox, missions, orchestrator, policies, project agent, skills, triggers, and runtime routes.
- `apps/api/src/services/profile-runtime-assets.ts` exposes owner-scoped profile/skill helpers used by runtime and MCP profile-tool routes; these need project membership authorization while preserving `userId` for actor/creator fields.
- Trigger creation/update behavior must preserve existing credential attribution and avoid product-level credential changes.
- Remaining `requireOwnedProject` usage outside the listed Wave 1B files is intentionally out of scope for sibling waves.

## Checklist

- [ ] Replace direct `requireOwnedProject` imports/calls in scoped route files with `requireProjectAccess` for reads and `requireProjectCapability` for mutations.
- [ ] Update profile/skill runtime asset helpers so project-scoped resources authorize through membership/capabilities instead of owner-only project ownership.
- [ ] Preserve `userId` for actor, audit, creator, and per-user resources where the existing data model requires it.
- [ ] Add focused API/unit tests proving active admin members can access representative migrated routes and non-members are rejected.
- [ ] Run relevant API/unit tests and type/lint checks.
- [ ] Verify `requireOwnedProject` is gone from the specified Wave 1B file list, aside from non-runtime historical comments if intentionally retained.

## Acceptance Criteria

- Active project admins are not blocked solely because `projects.user_id` differs from the authenticated user on migrated automation/context routes.
- Non-members are rejected by migrated routes.
- No deployment route files or Wave 1A core project/chat/task/workspace routes are modified except for unavoidable shared test/helper changes.
- The output branch and PR are distinct from the stopped duplicate task.

## References

- `apps/api/src/middleware/project-auth.ts`
- `apps/api/src/routes/triggers/crud.ts`
- `apps/api/src/routes/agent-profiles.ts`
- `apps/api/src/routes/knowledge.ts`
- `apps/api/src/routes/skills.ts`
