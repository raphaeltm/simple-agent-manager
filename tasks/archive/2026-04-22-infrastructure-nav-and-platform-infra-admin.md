# Make Personal Infrastructure Visible and Add Platform Infra Admin Surface

## Problem Statement

The control plane currently hides the `Infrastructure` navigation section behind a superadmin-only UI gate even though the underlying `Nodes` and `Workspaces` pages already scope results to the authenticated user's own infrastructure. This creates an unnecessary UX restriction for regular users.

Separately, admins need a dedicated operational surface for monitoring platform-managed nodes provisioned with admin infrastructure credentials and associating those nodes with users, especially for trial flows. That association must remain operational metadata and must not weaken the existing ownership and authorization model for personal infrastructure.

## Research Findings

1. `apps/web/src/components/NavSidebar.tsx` and `apps/web/src/components/AppShell.tsx` gate the Infrastructure nav behind `isSuperadmin`, while the routes themselves are already available under the authenticated app shell.
   - Implementation action: remove the superadmin-only nav restriction and expose personal infrastructure links to all authenticated users.

2. `apps/api/src/routes/nodes.ts` and `apps/api/src/routes/workspaces/crud.ts` already scope data to the current user, so personal infrastructure visibility can be expanded without broadening backend ownership.
   - Implementation action: keep existing personal infra endpoints unchanged and avoid weakening ownership checks.

3. The frontend auth model is too coarse for the admin split. The app primarily relies on `isSuperadmin`, but the backend already distinguishes `user`, `admin`, and `superadmin`.
   - Implementation action: add explicit admin capability flags for UI routing and admin-surface visibility.

4. Platform-managed node monitoring should not reuse personal infra APIs. A separate admin surface is needed for operational workflows around platform-funded nodes.
   - Implementation action: add dedicated `/api/admin/platform-infra/*` endpoints and a dedicated admin page/tab.

5. Trial infrastructure can be linked to a sentinel or operational owner, so "associate node to user" must be metadata rather than a change to resource ownership.
   - Implementation action: store associations separately from node ownership and include an explicit association reason (`trial`, `support`, `migration`, `other`).

6. UI changes touch admin navigation and a new admin page, so `/do` requires unit coverage and a Playwright visual audit before review.
   - Implementation action: add/update unit tests and add a Playwright audit for the new admin page plus changed nav behavior.

## Implementation Checklist

- [x] Add a task state file for the `/do` workflow and keep it updated throughout execution.
- [x] Expose `Nodes` and `Workspaces` in the main navigation for all authenticated users while keeping their existing user-scoped data behavior unchanged.
- [x] Extend frontend auth state with explicit admin capabilities instead of relying only on `isSuperadmin`.
- [x] Add backend schema and migration support for platform node association metadata.
- [x] Add admin API endpoints for listing platform-managed nodes and creating/removing node-to-user associations with an explicit reason.
- [x] Add an admin UI surface for platform infrastructure, including node summaries, trial context, association controls, and empty/error states.
- [x] Restrict the new admin platform infra surface to `admin` and `superadmin`, while keeping the broader admin tabs limited appropriately for non-superadmins.
- [x] Add/update unit tests for nav visibility, admin tab behavior, the new admin API route, and the new admin platform infra page.
- [x] Add a Playwright visual audit for the new/changed UI surfaces with mobile and desktop coverage.
- [x] Run local validation required by `/do`: lint, typecheck, tests, build, and specialist review.

## Implementation Notes

- The implementation was first developed in the primary workspace, then migrated into the `/do` feature worktree `../sam-infrastructure-nav-admin`.
- Phase 2 baseline validation in the worktree required small follow-up fixes for missing type re-exports and import/export ordering in changed files before `pnpm typecheck` and `pnpm lint` passed.
- The Playwright visual audit initially exposed brittle assertions in the new audit spec rather than UI defects; the spec was corrected to match the real API error shape and to use unambiguous locators before the mobile/desktop screenshots were regenerated successfully.
- The mobile UX guide was updated to reflect that Infrastructure navigation is available to all authenticated users while the platform infrastructure admin surface remains admin-only.
- Full-suite validation exposed a stale infra test that still assumed the old hardcoded `sam-` naming prefix. The test now asserts against the configured `prefix` export instead so `pnpm test` validates the current naming contract instead of obsolete behavior.

## Acceptance Criteria

- [x] Any authenticated user can see `Infrastructure`, `Nodes`, and `Workspaces` in the main navigation.
- [x] Regular users only see their own nodes and workspaces through the existing personal infrastructure pages.
- [x] `admin` users can access a dedicated platform infrastructure admin page without receiving the full superadmin tab set.
- [x] The platform infrastructure admin page only operates on platform-managed nodes and does not alter node ownership.
- [x] Admins can associate a platform-managed node with an active user and a reason, and can clear that association.
- [x] Trial-related node context is visible on the admin platform infra page when relevant.
- [x] Updated tests cover both the personal-infra visibility change and the platform-infra admin behavior.
- [x] A Playwright audit demonstrates the changed UI renders without overflow or clipping on mobile and desktop.

## References

- `apps/web/src/components/NavSidebar.tsx`
- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/AuthProvider.tsx`
- `apps/web/src/pages/Admin.tsx`
- `apps/api/src/routes/nodes.ts`
- `apps/api/src/routes/workspaces/crud.ts`
- `docs/architecture/credential-security.md`
- `.codex/prompts/do.md`
- `.claude/rules/09-task-tracking.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/17-ui-visual-testing.md`
