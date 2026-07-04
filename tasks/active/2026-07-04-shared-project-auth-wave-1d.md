# Wave 1D Shared Project Authorization Consolidation

## Problem Statement

Waves 1A, 1B, and 1C migrated the major route families from owner-only project authorization to membership/capability checks. Wave 1D is the consolidation sweep: verify no route call sites still use `requireOwnedProject`, migrate any missed project authorization boundaries needed for a coherent Phase 1 shared-project foundation, and add cross-cutting tests that prove active admin members can use representative APIs while non-members and owner-only/creator-only boundaries stay protected.

## Research Findings

- `main` has merged the prerequisite wave task records and currently contains no `requireOwnedProject` usage under `apps/api/src/routes`; the only source usage is the exported helper in `apps/api/src/middleware/project-auth.ts`.
- `requireOwnedProject` is intentionally retained in middleware for narrow owner/private use and direct unit coverage in `apps/api/tests/unit/middleware/project-auth.test.ts`; no current route imports it.
- Existing wave tests cover representative activity (`shared-project-route-auth.test.ts`) and deployment environments (`deployment-membership-auth.test.ts`) plus wave-specific route behavior.
- `GET /api/projects` still filters by `projects.userId = caller`, which means active shared-project admins can call direct project APIs but cannot discover shared projects from the project list. This is a coherence gap for Phase 1.
- Project creation duplicate/count checks remain intentionally user-owned because they enforce per-user project limits and per-user GitHub repository linking.
- `DELETE /api/projects/:id` uses `requireProjectCapability(..., 'project:delete')`; the capability model grants this to owners only. The delete SQL still includes `projects.userId = userId` as defense-in-depth and should remain owner-only.
- Chat `/prompt` and `/cancel` first accept project `task:write` capability but then resolve a workspace and running agent session scoped to the active `userId`. This preserves the creator-only/session-owner boundary for message submission and cancellation.
- GitHub/repository token minting and credential routes retain caller-scoped `userId` checks. These are intentionally user-scoped and must not be widened in this wave.
- `apps/api/src/services/profile-runtime-assets.ts` still stores and reads runtime asset values by active user; this is credential/secret attribution and should remain user-scoped.
- `apps/api/src/durable-objects/trial-orchestrator/helpers.ts` has no `requireOwnedProject` use; its sentinel anonymous user warning is trial-internal and not a route authorization boundary.
- Broader `projects.userId` matches in Account Map, dashboard, SAM MCP DO tools, workspace lifecycle/agent-session routes, deployment node calls, and composable credential attachment flows need file/function-level classification in the PR summary. Most are intentionally personal views, creator-only workspace/session actions, credential/token attribution, or deferred MCP/runtime follow-up rather than direct `requireOwnedProject` route misses.

## Implementation Checklist

- [x] Re-run and record full `requireOwnedProject` grep across `apps/api/src`.
- [x] Classify remaining `requireOwnedProject` usage as intentionally retained, migration target, or follow-up.
- [x] Migrate `GET /api/projects` to include active project memberships so active admins can discover shared projects.
- [x] Preserve user-owned project creation limits, duplicate checks, GitHub token access, personal credential attribution, and creator-only workspace/session action boundaries.
- [x] Add cross-cutting route tests proving an active admin can see shared projects in the project list and non-members cannot.
- [x] Add or adjust tests proving owner-only project deletion remains denied for an admin member via the real capability model.
- [x] Add or adjust tests proving creator-only chat prompt/session action boundaries still reject a shared-project admin who is not the session/workspace creator.
- [x] Document intentionally retained/deferred owner-private or user-scoped boundaries in this task and the PR summary.
- [x] Run focused tests for changed routes and relevant full validation (`grep`, lint, typecheck, tests/build as appropriate).

## Consolidation Classification

- Intentionally retained: `apps/api/src/middleware/project-auth.ts:requireOwnedProject()` remains exported and unit-tested as the owner/private guard for any future narrow owner-only resource checks.
- Migrated in Wave 1D: `apps/api/src/routes/projects/crud.ts` project list now uses active `project_members` membership instead of `projects.user_id = active user`, so admin members can discover shared projects.
- Intentionally retained user/private boundaries: project creation quota and duplicate checks, GitHub repository/token checks, project runtime credential value attribution, profile/skill runtime asset value attribution, personal Account Map/dashboard views, and workspace/session lifecycle routes that operate on concrete user-owned workspaces/agent sessions.
- Deferred follow-up: SAM MCP Durable Object tools still contain project-owner query patterns. These are agent-runtime control-plane surfaces rather than the migrated HTTP route families and need a dedicated MCP/tool authorization wave so token/session semantics are handled consistently.

## Validation Evidence

- Grep: `find apps/api/src -type f -name '*.ts' -print | xargs grep -n "requireOwnedProject"` returns only `apps/api/src/middleware/project-auth.ts:188`.
- Focused tests passed: `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/shared-project-consolidation-auth.test.ts tests/unit/routes/chat-prompt-cancel.test.ts tests/unit/routes/shared-project-route-auth.test.ts tests/unit/routes/deployment-membership-auth.test.ts tests/unit/middleware/project-auth.test.ts` (5 files, 45 tests).
- API typecheck passed: `pnpm --filter @simple-agent-manager/api typecheck`.
- API lint passed with existing warnings only: `pnpm --filter @simple-agent-manager/api lint`.
- Full API test suite passed: `pnpm --filter @simple-agent-manager/api test` (369 files, 5702 tests).

## Acceptance Criteria

- No `requireOwnedProject` route call sites remain under `apps/api/src/routes`.
- Any remaining `requireOwnedProject` source usage is documented with file/function-level rationale.
- Active admin members can discover and access representative shared-project APIs across the merged route-family waves.
- Non-members remain rejected by membership-protected project APIs.
- Project deletion remains owner-only.
- Chat prompt/cancel message actions remain creator/user-scoped despite project-level membership visibility.
- GitHub token minting and personal credential access remain scoped to the active user's identity.

## References

- `apps/api/src/middleware/project-auth.ts`
- `apps/api/src/routes/projects/crud.ts`
- `apps/api/src/routes/chat-workspace-resolver.ts`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/services/profile-runtime-assets.ts`
- `apps/api/src/durable-objects/trial-orchestrator/helpers.ts`
- `tasks/archive/2026-07-04-wave-1a-shared-project-route-auth.md`
- `tasks/archive/2026-07-04-wave-1b-automation-context-membership-auth.md`
- `tasks/archive/2026-07-04-wave-1c-deployment-membership-auth.md`
- `.claude/rules/35-vertical-slice-testing.md`
