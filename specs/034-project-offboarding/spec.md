# Feature Specification: Project Member Offboarding and Ownership Transfer

**Feature Branch**: `sam/wave-6-design-first-01kwqr`
**Created**: 2026-07-04
**Status**: Design
**Input**: Wave 6 design-first task for shared projects, idea `01KVX4YP9C5255TEB28PGM1159`

## Summary

Shared projects need explicit ownership transfer and member offboarding flows. The hard product constraint is that SAM must not silently keep burning a removed member's personal key. This spec designs the API, authorization, data model, UI, and credential re-attribution semantics for follow-up implementation waves.

This is a design-only specification. It does not implement runtime code.

## Current Behavior Inventory

### Membership and Roles

- Project membership is stored in `project_members` with `(project_id, user_id)` primary key, `role`, and `status`; migration `0081_project_members.sql` backfilled every existing project owner as an active `owner` member (`apps/api/src/db/migrations/0081_project_members.sql:1-18`, `apps/api/src/db/schema.ts:353-377`).
- The role model includes `owner`, `admin`, `maintainer`, and `viewer`, but v1 authorization treats owner/admin as the useful roles: owner has every capability and admin has every capability except `project:delete` (`apps/api/src/middleware/project-auth.ts:9-47`).
- Capability checks require an active membership row before allowing access (`apps/api/src/middleware/project-auth.ts:81-135`, `apps/api/src/middleware/project-auth.ts:175-186`).
- There is currently no ownership-transfer route and no member-removal route; the member route file implements list, invite link creation/revocation, invite preview/request, and access-request approve/deny only (`apps/api/src/routes/projects/members.ts:315-721`).
- Invite link creation and revocation currently require only active project access, while approving/denying access requests requires `member:manage` (`apps/api/src/routes/projects/members.ts:383-456`, `apps/api/src/routes/projects/members.ts:610-719`).
- Access-request approval inserts or updates the requester as an active `admin` member (`apps/api/src/routes/projects/members.ts:646-665`).
- Projects still have `projects.user_id` and uniqueness indexes scoped to that value (`apps/api/src/db/schema.ts:328-350`). The design below keeps it synchronized as the canonical owner pointer until a future migration removes or repurposes it.

### Credential Attribution

- Composable credentials are split into credentials, configurations, and attachments. Credentials/configurations are owned by a user; project attachments bind a configuration to `(user_id, project_id, consumer_kind, consumer_target)` (`apps/api/src/db/migrations/0071_composable_credentials.sql:7-55`, `apps/api/src/db/schema.ts:2401-2496`).
- Project-scoped agent credential routes remain caller-scoped: listing, saving, and deleting project credentials filter by the current `userId` and `projectId`, so one member cannot read or modify another member's secret (`apps/api/src/routes/projects/credentials.ts:1-13`, `apps/api/src/routes/projects/credentials.ts:56-81`, `apps/api/src/routes/projects/credentials.ts:128-241`, `apps/api/src/routes/projects/credentials.ts:278-334`).
- Compute credential resolution checks project compute attachments first when a project is provided, then user credentials, then platform credentials. It returns `project`, `user`, or `platform` as non-secret source metadata (`apps/api/src/services/provider-credentials.ts:364-420`, `apps/api/src/services/provider-credentials.ts:422-465`).
- Provider construction uses the composable resolver first for explicit target providers, then falls back to legacy credential lookup (`apps/api/src/services/provider-credentials.ts:194-226`, `apps/api/src/services/provider-credentials.ts:232-282`).
- Credential health currently inspects trigger resources only. It marks agent and compute paths as `project` when an active project attachment covers the consumer target, otherwise as `personal` owned by the trigger creator (`apps/api/src/services/credential-attribution-health.ts:75-114`, `apps/api/src/services/credential-attribution-health.ts:116-156`, `apps/api/src/services/credential-attribution-health.ts:192-264`, `apps/api/src/services/credential-attribution-health.ts:266-323`).

### Tasks, Triggers, Nodes, and Deployments

- Tasks store non-secret root attribution pins: `credential_attribution_user_id`, `credential_attribution_project_id`, and `credential_attribution_source` (`apps/api/src/db/migrations/0084_credential_attribution_pins.sql:5-17`, `apps/api/src/db/schema.ts:685-692`).
- User-submitted child tasks inherit parent attribution pins instead of resolving against the child actor (`apps/api/src/routes/tasks/submit.ts:191-221`, `apps/api/src/routes/tasks/submit.ts:335-372`, `apps/api/src/routes/tasks/submit.ts:394-422`).
- TaskRunner DO startup receives those pins and defaults missing values to the task user and `user` source (`apps/api/src/services/task-runner-do.ts:69-75`, `apps/api/src/services/task-runner-do.ts:111-153`).
- Trigger-created tasks resolve compute source when the trigger fires and store the trigger owner's user id plus project source metadata if project credentials win (`apps/api/src/services/trigger-submit.ts:119-124`, `apps/api/src/services/trigger-submit.ts:171-200`, `apps/api/src/services/trigger-submit.ts:272-314`).
- Trigger rows store `user_id` as the creator/owner, and trigger edits update behavior fields without changing `user_id` (`apps/api/src/db/schema.ts:1571-1616`, `apps/api/src/routes/triggers/crud.ts:473-624`).
- Trigger list/detail/create responses attach credential-attribution warnings from the health service (`apps/api/src/routes/triggers/crud.ts:79-104`, `apps/api/src/routes/triggers/crud.ts:291-302`, `apps/api/src/routes/triggers/crud.ts:360-369`, `apps/api/src/routes/triggers/crud.ts:440-450`).
- Nodes also store attribution pins and use them for provisioning and teardown. Provisioning resolves credentials using the recorded attribution user/project, and deletion paths use the same attribution metadata to locate the cloud provider credentials (`apps/api/src/db/schema.ts:788-834`, `apps/api/src/services/nodes.ts:74-116`, `apps/api/src/services/nodes.ts:147-200`, `apps/api/src/services/nodes.ts:394-459`, `apps/api/src/services/nodes.ts:469-547`, `apps/api/src/services/nodes.ts:561-621`).
- Workspaces point at nodes and projects; the credential attribution for live compute is on the node, not on the workspace row (`apps/api/src/db/schema.ts:839-880`).
- Deployment environments point at deployment-role nodes; deployment environment rows do not carry credential attribution directly (`apps/api/src/db/schema.ts:1956-2025`). Deployment provisioning writes attribution onto the deployment node via `createNodeRecord` (`apps/api/src/services/deployment-provisioning.ts:382-395`).
- Deployment routes are capability-gated with `deployment:read`, `deployment:deploy`, `deployment:manage`, `secret:*`, and `infra:manage` depending on the operation (`apps/api/src/routes/deployment-environments.ts`, `apps/api/src/routes/deployment-releases.ts`, `apps/api/src/routes/deployment-environment-lifecycle.ts`, `apps/api/src/routes/deployment-secrets.ts`, `apps/api/src/routes/project-deployment.ts:65-68`, `apps/api/src/routes/project-deployment.ts:131-220`).

### Existing UI Surfaces

- Project settings renders the members section (`apps/web/src/pages/ProjectSettings.tsx:286-287`).
- The members section loads members plus credential health, treats owner/admin as managers, and shows the multiplayer credential transition warning when multiple members, an active invite, or pending requests exist (`apps/web/src/components/project-settings/ProjectMembersSection.tsx:187-231`, `apps/web/src/components/project-settings/ProjectMembersSection.tsx:343-374`).
- The compact credential health nav item opens a modal with resource details and fix links, and currently labels resources as triggers (`apps/web/src/components/CredentialHealthNavItem.tsx:32-153`, `apps/web/src/components/CredentialHealthNavItem.tsx:156-205`).
- Web API clients currently expose member/invite endpoints and credential health but no member removal or transfer calls (`apps/web/src/lib/api/projects.ts:148-154`, `apps/web/src/lib/api/projects.ts:272-340`).

## Product Decisions Needed

### Decision A: Offboarding Default for Personal-Backed Live Resources

**Option 1: Re-attach automatically to owner/project credentials.**

- Pros: Less breakage; triggers and deployments keep running.
- Cons: Silently changes who pays unless the target already has an explicit project credential. It can also imply credential transfer that SAM cannot safely perform because secret rows are user-owned.

**Option 2: Break-and-flag by default.**

- Pros: Satisfies "do not silently keep burning a removed member's key"; avoids acting through another member's identity; makes every cost-bearing change explicit.
- Cons: Offboarding can pause triggers or require manual resolution before removal completes.

**Recommendation for human review**: Use Option 2 as the default. Allow reattachment only when the project already has an active project-level attachment for the relevant consumer, or when the owner/admin explicitly chooses a new project attachment during the offboarding review. Never copy or transfer a user's secret to another user.

### Decision B: Synchronous Versus Draft Offboarding

**Recommendation for human review**: Implement a two-step preview/apply API. The preview returns all blockers and proposed effects. The apply request must echo an `offboardingPlanId` plus explicit choices for every affected resource class. This avoids accidental removal from stale UI state.

## Proposed Semantics

### Ownership Transfer

Ownership transfer is an owner-only action that moves the single project owner role to another active member.

Rules:

- Only an active owner may transfer ownership.
- The target must be an active member of the same project.
- The target may be an admin today; v1 should reject viewer/maintainer targets until those roles are productized.
- Transfer is atomic:
  - Set target member role to `owner`.
  - Set old owner role to `admin`.
  - Update `projects.user_id` to the new owner for compatibility with current owner-scoped indexes and legacy code.
  - Preserve `projects.created_by`.
  - Write audit rows/events for old owner, new owner, and actor.
- After transfer, the old owner may leave or be removed like any admin, subject to offboarding resource review.

Last-owner protection:

- A project must always have exactly one active owner in v1.
- The sole owner cannot be removed, cannot leave, and cannot be demoted directly.
- Ownership transfer must complete before the old owner can leave.
- A request that would leave zero active owners returns `409 last_owner_requires_transfer`.

### Member Removal and Offboarding

Member removal is owner/admin managed, except owner removal is blocked unless ownership has already transferred. The API uses preview/apply.

The offboarding preview must enumerate all resources that either:

- Are directly owned/created by the departing member and can still run, cost money, or require teardown credentials.
- Carry `credential_attribution_user_id = departingUserId`.
- Use project attachment rows where `cc_attachments.user_id = departingUserId` or the attached configuration/credential owner is the departing member.

The apply step must perform one of these per affected live resource:

- `reattach_to_project`: Allowed only when an active project-level attachment exists for the relevant consumer kind/target and the attachment will remain valid after removal.
- `break_and_flag`: Disable, pause, detach, or mark the resource as blocked, and surface it in credential health.
- `defer_removal`: Leave membership unchanged and return the blockers.

Offboarding must not create a new user-owned attachment under another user without that user's explicit credential selection.

## Resource Semantics Matrix

| Resource | Current attribution source | Offboarding behavior |
| --- | --- | --- |
| Trigger definitions | `triggers.user_id`; health infers agent/compute coverage from project attachments or trigger owner (`apps/api/src/db/schema.ts:1571-1616`, `apps/api/src/services/credential-attribution-health.ts:192-264`) | If a trigger would run on departing member personal credentials, default `break_and_flag`: set `status='disabled'`, clear `next_fire_at`, record `credential_blocked_reason='member_removed'`. If active project attachments cover every agent/compute check, keep active and set an offboarding audit note. Editing by another member must not change attribution unless an explicit future "take over trigger" action is added. |
| Trigger executions | Audit rows with optional `task_id`; no independent credentials (`apps/api/src/db/schema.ts:1624-1656`) | Do not rewrite historical executions. Future executions obey the trigger's post-offboarding state. Running executions follow task rules. |
| Root tasks | `tasks.credential_attribution_*` (`apps/api/src/db/schema.ts:685-692`) | Queued/not-started tasks attributed to departing personal credentials are canceled or marked `failed` with `member_removed_credentials_unavailable`, unless the apply plan explicitly reattaches to project credentials before start. Running tasks continue until stopped, but UI must show they are burning a departing member's key; owner/admin can stop them. Completed/failed/canceled tasks are historical and not rewritten. |
| Task trees/subtasks | Child tasks inherit parent pins (`apps/api/src/routes/tasks/submit.ts:191-221`, `apps/api/src/services/task-runner-do.ts:111-153`) | Treat the tree root as the unit. New descendant dispatch is blocked once the root attribution is broken. Existing running descendants follow running-task behavior. Historical descendants retain original attribution metadata. |
| Workspaces | Workspace points to node; no direct attribution (`apps/api/src/db/schema.ts:839-880`) | Workspaces on a node attributed to departing personal credentials are flagged through the node. If idle/not attached to a running task, stop/delete through node teardown before removal or require explicit `break_and_flag`. |
| Workspace nodes | `nodes.credential_attribution_*`; teardown uses those credentials (`apps/api/src/db/schema.ts:788-834`, `apps/api/src/services/nodes.ts:394-621`) | Running nodes attributed to departing personal credentials block immediate removal unless the apply plan stops/deletes them first or a project credential can resolve teardown. If credentials are unavailable, mark `offboarding_blocked` and keep member active until manual resolution to avoid orphaned cloud resources. |
| Deployment environments | Environment points to node; creation metadata records creator but not credential attribution (`apps/api/src/db/schema.ts:1956-2025`) | If linked node is project/platform attributed, keep environment. If linked node is departing personal attributed, stop environment or move/provision a replacement deployment node using project credentials. Do not keep a deployment node running on a removed member's key. |
| Deployment nodes | Node attribution applies; deployment provisioning writes it to nodes (`apps/api/src/services/deployment-provisioning.ts:382-395`) | Same as nodes, with extra volume safety: persistent-volume environments must detach/reattach through existing lifecycle controls before deleting the old node. If replacement cannot be verified, removal is blocked. |
| Deployment releases/config/secrets/domains/volumes | Project-scoped deployment data, capability-gated routes (`apps/api/src/routes/deployment-environment-config.ts`, `apps/api/src/routes/deployment-secrets.ts`, `apps/api/src/routes/deployment-volumes.ts`, `apps/api/src/routes/deployment-custom-domains.ts`) | Do not delete or rewrite because a member leaves. Only node/environment runtime state changes when the departing member's personal compute credential backs the live node. |
| Project credential attachments | `cc_attachments.user_id`, `project_id`, consumer kind/target; configuration and credential owners are user-scoped (`apps/api/src/db/schema.ts:2401-2496`) | Attachments owned by the departing member cannot remain the basis for project coverage after removal. They must be disabled/detached or replaced by an attachment owned by a remaining member before removal. |

## Data Model Changes

Add append-only migrations:

1. `project_ownership_transfers`
   - `id`
   - `project_id`
   - `from_user_id`
   - `to_user_id`
   - `initiated_by`
   - `completed_at`
   - `created_at`

2. `project_member_offboarding_plans`
   - `id`
   - `project_id`
   - `member_user_id`
   - `requested_by`
   - `status`: `preview`, `applied`, `expired`
   - `resource_summary_json`
   - `created_at`
   - `expires_at`
   - `applied_at`

3. `project_member_offboarding_resource_actions`
   - `id`
   - `plan_id`
   - `resource_kind`: `trigger`, `task_tree`, `node`, `deployment_environment`, `project_attachment`
   - `resource_id`
   - `credential_source_before`: `user`, `project`, `platform`, `unknown`
   - `attribution_user_id_before`
   - `attribution_project_id_before`
   - `recommended_action`: `reattach_to_project`, `break_and_flag`, `defer_removal`
   - `selected_action`
   - `status`
   - `details_json`
   - `created_at`
   - `updated_at`

4. Targeted resource state fields:
   - `triggers.credential_blocked_reason`, `triggers.credential_blocked_at`, `triggers.credential_blocked_by`.
   - `tasks.credential_blocked_reason`, `tasks.credential_blocked_at` for queued/task-tree blocking.
   - `nodes.offboarding_status`, `nodes.offboarding_blocked_reason`, `nodes.offboarding_blocked_at`.
   - Optional `deployment_environments.offboarding_status` for environment-level UI when the node is blocked.

Migration rules:

- Do not drop or rewrite historical attribution.
- Add indexes for `(project_id, member_user_id, status)` on plans and `(plan_id, resource_kind)` on actions.
- Add indexes for `tasks.credential_attribution_user_id` and `nodes.credential_attribution_user_id` already exist from migration 0084; preserve them.
- Avoid cascading deletes from users for audit tables; use bare references or nullable soft references where historical audit must survive account deletion.

## API Design

### Ownership Transfer

`POST /api/projects/:id/ownership-transfer`

Request:

```json
{
  "toUserId": "usr_...",
  "oldOwnerRole": "admin"
}
```

Authorization:

- Requires active `owner` membership, not merely `member:manage`.
- Rejects target users without active membership.
- Rejects target roles other than owner/admin in v1.

Response:

```json
{
  "projectId": "prj_...",
  "fromUserId": "usr_old",
  "toUserId": "usr_new",
  "fromRole": "admin",
  "toRole": "owner",
  "completedAt": "2026-07-04T00:00:00.000Z"
}
```

### Offboarding Preview

`POST /api/projects/:id/members/:userId/offboarding-preview`

Authorization:

- Requires `member:manage`.
- If `:userId` is an owner, caller must also be the owner and the response must be `409 last_owner_requires_transfer` unless another active owner already exists.

Response:

```json
{
  "planId": "off_...",
  "projectId": "prj_...",
  "memberUserId": "usr_departing",
  "canApply": false,
  "requiresHumanDecision": true,
  "summary": {
    "breakAndFlag": 3,
    "reattachAvailable": 2,
    "blockingTeardown": 1
  },
  "resources": []
}
```

### Offboarding Apply

`POST /api/projects/:id/members/:userId/offboarding-apply`

Request:

```json
{
  "planId": "off_...",
  "actions": [
    {
      "resourceKind": "trigger",
      "resourceId": "trg_...",
      "action": "break_and_flag"
    }
  ],
  "finalMemberStatus": "removed"
}
```

Authorization:

- Requires `member:manage`.
- Removing/demoting an owner requires completed transfer first.
- Applying a plan that would leave active personal-backed live resources must return `409 unresolved_credential_attribution`.

Response:

```json
{
  "projectId": "prj_...",
  "memberUserId": "usr_departing",
  "status": "removed",
  "appliedAt": "2026-07-04T00:00:00.000Z",
  "resourceResults": []
}
```

### Role Demotion

`PATCH /api/projects/:id/members/:userId`

Request:

```json
{
  "role": "admin"
}
```

Rules:

- Owner-only for v1 role changes.
- Direct owner demotion is rejected unless another active owner exists. In v1, prefer ownership transfer endpoint for owner changes.
- Viewer/maintainer should remain unsupported in UI until productized.

## Authorization Matrix

| Action | Owner | Admin | Departing member |
| --- | --- | --- | --- |
| View members | Yes | Yes | Yes |
| Create/revoke invite link | Yes | Yes | Yes today; consider tightening to owner/admin in implementation review |
| Approve/deny access request | Yes | Yes | No, unless owner/admin |
| Transfer ownership | Yes | No | No |
| Preview offboarding | Yes | Yes | Self-leave preview allowed, but apply blocked if last owner/resources unresolved |
| Apply offboarding for admin/member | Yes | Yes | Self-leave only if no blockers and not owner |
| Remove/demote owner | Only after ownership transfer | No | No |
| Resolve credential actions | Depends on action: `secret:write`, `deployment:manage`, `task:write`, or `infra:manage` as applicable | Same for admin where capability exists | No after removal |

Implementation note: owner-only must be explicit role checks. `member:manage` is insufficient because admin currently has that capability (`apps/api/src/middleware/project-auth.ts:33-47`).

## UI Flows

### Project Chat First

Offboarding can be initiated from project settings, but the consequences must be visible from project chat because chat is the primary surface. The compact credential health nav item should gain offboarding-related counts and deep links:

- `Credentials` badge includes blocked/offboarding resources.
- Modal groups resources by `Triggers`, `Running tasks`, `Nodes`, and `Deployments`, not only triggers.
- Deep links route to the resource's actual fix surface: trigger detail, session/task, node/workspace, deployment environment, or project connections.

### Project Settings Members

Add actions to each member row:

- `Transfer ownership` on eligible active members, visible to owner.
- `Remove member` on non-owner active members, visible to owner/admin.
- `Leave project` for the current non-owner member.

Flow:

1. User clicks action.
2. UI calls offboarding preview.
3. Dialog shows:
   - Last-owner blockers.
   - Live resources by kind.
   - Which resources can use project credentials.
   - Which resources will be disabled/broken.
   - Running-task warning.
4. User confirms selected actions.
5. UI calls apply.
6. Members list and credential health modal refresh.

Transfer flow:

1. Owner clicks `Transfer ownership` next to an admin.
2. Confirmation dialog explains old owner becomes admin.
3. API applies atomic transfer.
4. Settings refresh; the old owner now sees admin-level controls.

### Copy Guidelines

Use explicit cost language:

- "This trigger runs on Raphaël's personal key."
- "Removing this member will disable the trigger unless you attach a project credential."
- "This deployment node is still running on the departing member's cloud credential. Stop or replace it before removal."

Do not imply SAM can transfer a secret:

- Avoid "transfer credential".
- Prefer "attach a project credential" or "replace with a project credential".

## Edge Cases

- Removal while tasks are running: Do not silently re-resolve running tasks. Mark them in offboarding preview. Allow stop/cancel or defer removal. Keep membership active until any required teardown completes.
- Removed member re-invited later: New membership does not automatically restore disabled triggers or old credential attachments. Existing historical tasks/nodes retain old attribution metadata. A re-invited user must explicitly re-enable or reattach resources.
- Owner transfers away then leaves: Treat the old owner's remaining personal-backed resources exactly like member removal. Transfer does not solve credential attribution by itself.
- Project credential owned by departing member: Treat as affected. Even if it is project-scoped, it is backed by a user-owned credential/configuration row. Require replacement by a remaining member's project attachment or disable affected resources.
- Platform credentials: Platform-attributed resources may continue after member removal because they do not burn the departing member's key. Still show them in the preview for transparency.
- Missing credential needed for teardown: Block removal and show exact resource. Do not delete the membership row while SAM may need that user-owned credential to clean up cloud resources.
- GitHub repo access: Membership removal removes SAM access but does not alter GitHub repository permissions. Re-invite still uses the existing invite access check semantics.

## Migration and Compatibility

- Keep `projects.user_id` synchronized on transfer until all legacy owner-scoped paths are removed.
- Do not rewrite `tasks.user_id`, `triggers.user_id`, or historical execution rows. Those are audit/creator fields.
- Use nullable soft references for new offboarding audit records so account deletion does not erase project audit history.
- Backfill is not required for new offboarding status fields; null means "not offboarding-blocked".
- Credential health should be expanded in the same implementation wave as offboarding preview so UI counts agree with apply behavior.

## Implementation Wave Breakdown

1. **Wave 6A: Data model and read-only analysis**
   - Add offboarding/transfer audit tables and resource blocked fields.
   - Implement offboarding preview service.
   - Extend credential health to include triggers, queued/running task trees, nodes/workspaces, deployment environments, and project attachments.
   - Add tests for no secret leakage and resource enumeration.

2. **Wave 6B: Ownership transfer and last-owner protection**
   - Add owner-only transfer endpoint.
   - Add role update endpoint if still needed.
   - Enforce exactly-one-owner v1 invariant in transfer/removal paths.
   - Update project settings UI transfer flow.

3. **Wave 6C: Offboarding apply**
   - Add apply endpoint.
   - Implement `break_and_flag` for triggers/tasks/nodes/deployments.
   - Implement `reattach_to_project` only for already-existing active project attachments owned by remaining members.
   - Add vertical tests for personal-backed trigger disablement, project-covered trigger survival, running-task blockers, and deployment-node blocker behavior.

4. **Wave 6D: Project-chat-first UI**
   - Expand compact credential health modal and project chat/nav badge.
   - Add member remove/leave dialogs.
   - Add mobile/desktop Playwright visual audits for long member names, many affected resources, and destructive confirmations.

5. **Wave 6E: Staging verification**
   - Verify ownership transfer with two smoke users.
   - Verify offboarding preview and apply against trigger resources.
   - Provision a real node/deployment-node scenario only if the implementation wave touches teardown/provisioning behavior.

## Acceptance Criteria for Follow-Up Implementation

- Ownership transfer is owner-only and atomic.
- The old owner becomes admin after transfer.
- Sole owner cannot be removed, leave, or be demoted.
- Member removal cannot leave active live resources burning the removed member's personal credentials.
- Every affected credential-attributed resource type is represented in preview and health.
- Reattachment requires explicit existing project credential coverage or explicit human selection.
- No secret values are returned by preview, apply, health, logs, or audit tables.
- Historical audit rows retain creator/attribution metadata.
- UI is reachable from project settings and consequences are visible from the project chat/nav credential health surface.
