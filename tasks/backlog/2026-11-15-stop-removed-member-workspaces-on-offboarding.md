# Stop or Revoke a Removed Member's Workspaces on Offboarding

**Status:** backlog
**Priority:** high
**Created:** 2026-11-15

## Problem

Removing a member from a project (`applyProjectMemberOffboarding` in
`apps/api/src/services/project-offboarding-apply.ts`, which sets `project_members.status = 'removed'`)
does not stop the workspaces that member started. Offboarding blocks only on running tasks that
use the departing member's personal credentials
(`apps/api/src/services/project-offboarding-resource-actions.ts`). A workspace running on project or
platform credentials keeps running after removal: it keeps the project's repository checkout, its
git credentials and runtime env vars, and its workspace callback token, which is checked against the
workspace and node rows only (`assertWorkspaceAcceptsCallback`).

Branch `sam/fix-mcp-token-membership` closed the MCP part of this. `validateActiveWorkspaceMcpToken`
(`apps/api/src/services/mcp-token-lifecycle.ts`) now refuses, and deletes, the MCP token of a removed
member, so their agent loses SAM MCP tools and the GCP deployment identity endpoint. The workspace
itself, its callback-authenticated sinks (message persistence, git credential fetch, runtime
assets, AI proxy), and anything already copied into it still work until the workspace stops or its
callback token expires.

## Context

- Found while reviewing security finding `acf_419d610ae18fb307010da9106146546e` (MCP tokens ignored
  project membership and account status).
- MCP tokens live 8h sliding / 24h max. Workspace callback tokens live `CALLBACK_TOKEN_EXPIRY_MS`
  (24h by default) and are renewed while the workspace is active.
- A suspended account is the same problem in a recoverable form. Account suspension
  (`routes/admin.ts`) also leaves the user's workspaces running. Decide whether suspension should stop
  them, or only refuse callbacks while it lasts.

## Acceptance Criteria

- [ ] Offboarding a member (final status `removed`) stops, or puts into a state that refuses every
      callback, each non-deleted workspace in that project whose `user_id` is the removed member,
      whatever credential source it runs on.
- [ ] The offboarding preview lists those workspaces so the admin sees what will be stopped before
      applying.
- [ ] Workspace callback authentication (`assertWorkspaceAcceptsCallback`, the AI proxy auth, git
      credential and runtime-asset endpoints) refuses a workspace whose owner no longer has an
      active project membership, or the stop above makes that unreachable. The PR must say which
      and why.
- [ ] Decide on account suspension. Either suspended users' workspaces stop, or their callbacks are
      refused while the suspension lasts. Record the decision in
      `apps/www/src/content/docs/docs/architecture/security.md`.
- [ ] Capability test through the real offboarding apply route on a real SQL engine: a removed
      member's running workspace stops, or its callbacks are refused. Include a control showing that
      another member's workspace in the same project is untouched.
- [ ] The paragraph in `security.md` saying that removing a member does not stop their workspaces
      is updated.
