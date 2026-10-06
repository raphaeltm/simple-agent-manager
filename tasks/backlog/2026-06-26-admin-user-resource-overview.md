# Admin User Resource Overview

## Problem

Admins can approve and manage user roles, and there is a separate Admin Usage drill-in for node/vCPU usage, but there is no unified user detail page that shows what a user is consuming and lets a superadmin stop platform-owned compute on behalf of the platform.

The feature must preserve the boundary between platform-owned resources and user-owned resources. Admins may see that user-owned nodes exist, but must not see sensitive details such as IP addresses or receive controls that act through the user's own cloud provider key.

## Research Findings

- Admin users list exists at `GET /api/admin/users` and `apps/web/src/pages/AdminUsers.tsx`, but it only supports approval, suspension, and role changes.
- Admin node usage exists at `GET /api/admin/usage/nodes/:userId` and `apps/web/src/pages/AdminComputeUsage.tsx`, but it is not tied to the user management page and has no shutdown control.
- Nodes already store `credential_source` (`user` or `platform`) in `apps/api/src/db/schema.ts`, which is the right discriminator for redaction and admin action authorization.
- Existing user-owned node stop path is `POST /api/nodes/:id/stop`, but it requires node ownership and resolves credentials through the user's current credential state. The admin action must only be available for platform-owned nodes and should not expose user-owned provider details.
- Product analytics are in Analytics Engine and currently exposed only as aggregate admin endpoints. Project activity events are project-scoped in `ProjectData` Durable Objects. There is not yet a safe cross-project per-user activity timeline API.
- D1 can compute useful storage/resource summaries today from `projects`, `project_files`, `deployment_environments`, `deployment_volumes`, `workspaces`, `agent_sessions`, and `nodes`.

## Checklist

- [ ] Add shared admin user detail response types.
- [ ] Add a superadmin-only `GET /api/admin/users/:userId` detail endpoint with counts, storage summaries, privacy-filtered nodes, and recent platform-owned activity.
- [ ] Add a superadmin-only platform-node stop endpoint that rejects user-owned nodes.
- [ ] Link Admin Users rows to `/admin/users/:userId`.
- [ ] Add the admin user detail UI with resource overview, node controls, redaction messaging, and an activity/timeline placeholder grounded in current data.
- [ ] Add focused API tests for redaction, detail aggregation, and platform-only stop authorization.
- [ ] Run typecheck/lint/test and UI visual audit for the changed admin surface.

## Acceptance Criteria

- A superadmin can click a user from Admin → Users and see a user detail page.
- The page shows active/running node counts split by platform-owned vs user-owned.
- Platform-owned nodes show enough operational detail for shutdown and have a stop action.
- User-owned nodes are visible as records but hide sensitive fields such as IP/provider instance identifiers and do not expose stop controls.
- The backend rejects attempts to stop user-owned nodes through the admin endpoint.
- The page makes clear that a full cross-project per-user event timeline is not implemented yet, while showing available recent platform-owned node/session/resource signals.
