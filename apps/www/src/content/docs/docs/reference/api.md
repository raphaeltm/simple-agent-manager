---
title: API Reference
description: SAM REST API endpoints for managing workspaces, nodes, and credentials.
---

The SAM API runs on a Cloudflare Worker at `api.{domain}`. All authenticated endpoints require a valid BetterAuth session cookie.

:::note
This reference covers the most commonly used endpoints. For the complete list of all API routes, see the [source code](https://github.com/raphaeltm/simple-agent-manager/tree/main/apps/api/src/routes).
:::

## MCP orchestration

Task agents can call `wait_for_subtasks` with a stable workflow-step `waitKey`, unique same-project task IDs, an optional `condition` of `all` (the default) or `any`, and an optional bounded `wakeAfterSeconds`. The agent must persist the workflow state and key before calling, reuse the key after a lost response, and end its turn after registration. ProjectData then reconciles selected task terminal state and durably wakes the same canonical caller session exactly once, including after session sleep and runtime replacement. Automatic wake prompts carry only trusted task IDs and statuses; agents fetch peer-authored output explicitly as untrusted data. Servers without durable prompt delivery reject registration so clients can use bounded foreground polling as a compatibility fallback.

Private feedback-project agents can also call `list_incident_queue`, `get_incident`, `claim_incident`, and `resolve_incident`. These tools are scoped server-side to the effective private feedback project setting (Admin → Integrations runtime value first, then `PLATFORM_FEEDBACK_PROJECT_ID` fallback); callers cannot provide a project id. `claim_incident` and `resolve_incident` require a task-scoped MCP token, use bounded leases/CAS tokens, and return only private redacted incident evidence labelled as untrusted. `resolve_incident` accepts structured ship-or-track fields for resolved outcomes: `fixPrUrl`, `dispatchedTaskId`, or `linkedRecordId`; rejected outcomes require a justification note instead.

Project eventing uses a pull loop over the canonical ProjectData `project_event_*` tables. Agents create a short-lived subscription with `create_project_event_subscription`, using v1 exact/set filters for `source`, `eventType`, `subjectType`, `subjectId`, and `severity`; recover existing subscriptions with `list_project_event_subscriptions`; inspect or cancel with `get_project_event_subscription` and `cancel_project_event_subscription`. Project, task, session, workspace, owner, and agent identity come from the verified MCP token, not tool arguments.

After subscribing, call `list_subscription_events` with the `subscriptionId` to replay missed or queued matches. The list response is payload-free: it returns summaries, delivery IDs, delivery state, `hasMore`, and an opaque `nextCursor` that is valid only for the same subscription. Call `get_event` only when a summary needs full stored event details, then call `ack_event_delivery` after processing each returned `deliveryId`; ack is idempotent. V1 records matches, delivery decisions, and pull acknowledgements only. It does not inject prompts, steer runtimes, interrupt sessions, spawn tasks, or expose human/UI controls.

## Authentication

### `POST /api/auth/sign-in/social`

Start GitHub OAuth flow. Redirects to GitHub for authorization.

### `POST /api/auth/sign-out`

End the current session.

### `GET /api/auth/session`

Returns the current authenticated session and user info.

## Workspaces

### `POST /api/workspaces`

Create a new workspace.

**Body:**

```json
{
  "installationId": "12345",
  "repository": "owner/repo",
  "branch": "main",
  "vmSize": "medium",
  "displayName": "My Workspace"
}
```

### `GET /api/workspaces`

List all workspaces for the authenticated user.

### `GET /api/workspaces/:id`

Get workspace details including status, node info, and URLs.

### `POST /api/workspaces/:id/stop`

Permanently stop a running workspace and delete any retained persistent-session snapshot. Use sleep when the same chat must be resumable.

### `POST /api/workspaces/:id/sleep`

Checkpoint the workspace's agent HOME, harness identity, and repository work in progress, verify the snapshot, and put the session to sleep. VM compute is stopped only after SAM re-verifies the durable manifest and every artifact the manifest still claims. A complete snapshot restores the full state; a degraded-but-verified snapshot can still sleep and will surface reduced restore state on wake. If an accepted final checkpoint stops reporting progress, SAM records an explicit degraded snapshot instead of leaving idle compute awake indefinitely. Sending a follow-up in the same chat wakes the session during the seven-day retention window.

### `POST /api/workspaces/:id/restart`

Restart a stopped or errored workspace. Provisions a new VM and recreates the container.

### `DELETE /api/workspaces/:id`

Permanently request deletion of a workspace, its retained session snapshot, and associated
resources. A confirmed deletion returns `200` with
`{ "success": true, "deletionStatus": "confirmed" }`. If VM deletion is not yet proven,
the endpoint returns `202` with
`{ "success": true, "deletionStatus": "pending", "workspaceStatus": "stopping", "reason": "..." }`.
The `202` response is not deletion proof: SAM keeps the workspace quarantined and retries from
durable state until VM absence/success or strict provider/container termination is confirmed.

### `GET /api/workspaces/:id/boot-log`

Get the provisioning progress log for a workspace.

## Agent Sessions

### `POST /api/workspaces/:id/agent-sessions`

Create a new agent session in a workspace. The agent (Claude Code, Codex, Gemini CLI, etc.) is determined by the selected agent profile.

### `GET /api/workspaces/:id/agent-sessions`

List active agent sessions for a workspace.

### `POST /api/workspaces/:id/agent-sessions/:sessionId/stop`

Stop a running agent session.

## Nodes

### `GET /api/nodes`

List all nodes for the authenticated user.

### `GET /api/nodes/:id`

Get node details including health status and hosted workspaces.

### `POST /api/nodes/:id/stop`

Stop a running node. All workspaces on the node must be stopped first.

### `DELETE /api/nodes/:id`

Delete a node and clean up DNS records and Hetzner resources.

## Credentials

### `POST /api/credentials`

Add or update a credential (cloud provider token or agent API key).

**Body:**

```json
{
  "provider": "hetzner",
  "credentialType": "cloud-provider",
  "token": "your-api-token"
}
```

### `GET /api/credentials`

List all credentials for the authenticated user (tokens are not returned).

### `DELETE /api/credentials/:provider`

Delete a stored cloud-provider credential.

### `GET /api/providers/catalog`

List non-secret compute-provider catalog metadata for cloud-provider credentials the caller can use.
The response includes provider-native instance offerings, locations, normalized resource metadata,
price metadata when available, and a `catalogSource` value such as `api` or `static`.

Optional query parameters:

| Parameter   | Values                            | Description                                                                                     |
| ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `scope`     | `user`, `project`, `installation` | Selects the credential scope to inspect. Omit it for the authenticated user's personal catalog. |
| `projectId` | Project ID                        | Required when `scope=project`; the caller must have the project `secret:read` capability.       |

Installation scope is restricted to superadmins and uses enabled platform compute credentials.
User scope uses the caller's active personal compute credentials. Project scope returns active
compute credentials attached to that project after project `secret:read` authorization, including
composable-credential attachments from other project members. Effective default pool summaries expose
project → user → installation fallback separately.

If no credentials are visible for the requested scope, the response still returns `catalogs: []`
with `credentialSetupRequired: true` and a `credentialSetupMessage` suitable for setup UI.

## Capacity pools

Default capacity-pool endpoints expose non-secret pool, source, and concrete candidate metadata.
Responses have this shape: `effective`, `effectiveScope`, `defaults`, `precedence`,
`reconciledScopes`, and `policyMutationSupported`. Use `ensure=true` on GET endpoints, or call the
matching `/reconcile` endpoint, to refresh pool metadata from the credential-scoped provider-native
catalog. Provider API failures fall back to static curated catalog rows for that provider. Provider
catalog offerings expose `catalogSource`; capacity-pool candidates expose the persisted
`providerInstanceCatalogSource` snapshot.

### `GET /api/capacity-pools/defaults`

Read the authenticated user's default compute pool. Optional `ensure=true` reconciles it from the
user's active personal compute credentials. Disabled zero-active owned pools remain visible for the
editor; they are not selected as `effective`.

### `POST /api/capacity-pools/defaults/reconcile`

Explicitly reconcile the authenticated user's default pool from active personal compute
credentials.

### `PATCH /api/capacity-pools/defaults`

Update the authenticated user's owned default-pool policy, candidate statuses, or provider-native
`catalogAdditions`. This endpoint does not mutate project or installation fallback pools.

`catalogAdditions` reactivates a currently available provider-native offering from the same
credential-scoped catalog used by reconciliation. It identifies the active source plus concrete
provider/location/instance type; it does not accept secret material:

```json
{
  "catalogAdditions": [
    {
      "sourceId": "cap-source-default:user:user-credential-id",
      "provider": "hetzner",
      "location": "fsn1",
      "providerInstanceType": "cpx62",
      "providerInstanceSku": null
    }
  ]
}
```

### `GET /api/projects/:id/capacity-pools/defaults`

Read a project's default pool context. Requires project `secret:read`. Optional `ensure=true`
reconciles project credentials plus visible fallback summaries. Non-superadmins do not receive
installation fallback details.

### `POST /api/projects/:id/capacity-pools/defaults/reconcile`

Explicitly reconcile visible default capacity-pool metadata from existing credentials in the project
context. Project-scoped metadata comes from active project compute credentials. Requires project
`secret:read`.

### `PATCH /api/projects/:id/capacity-pools/defaults`

Update only the project-owned default-pool policy, candidate statuses, or provider-native
`catalogAdditions`. Requires project `secret:write`.

### `GET /api/admin/capacity-pools/defaults`

Read the installation default pool. Superadmin only. Optional `ensure=true` reconciles enabled
platform compute credentials.

### `POST /api/admin/capacity-pools/defaults/reconcile`

Explicitly reconcile the installation default pool from enabled platform compute credentials.
Superadmin only.

### `PATCH /api/admin/capacity-pools/defaults`

Update only the installation-owned default-pool policy, candidate statuses, or provider-native
`catalogAdditions`. Superadmin only.

## GitHub

### `GET /api/github/installations`

List GitHub App installations for the authenticated user.

### `GET /api/github/repositories?installation_id=:id`

List repositories accessible through a GitHub App installation.

### `GET /api/github/callback`

Post-installation redirect handler. Records the installation and redirects to Settings.

## Projects

### `GET /api/projects`

List all projects for the authenticated user.

### `POST /api/projects`

Create a new project linked to a GitHub repository.

### `GET /api/projects/:id`

Get project details.

### `POST /api/projects/:id/tasks`

Create a task record.

**Body:**

```json
{
  "title": "Fix the login button"
}
```

## Deployment Releases

### `POST /api/projects/:projectId/environments/:envId/releases`

Create a deployment release for an environment.

Preferred body: Docker Compose YAML with `Content-Type: text/yaml`, `application/yaml`, `text/x-yaml`, or `application/x-yaml`. Compose submissions may use `x-sam-routes` for routes and `x-sam-secret` environment values for secret references.

Raw manifest JSON is still accepted for backward compatibility when another content type is used.

### `POST /api/projects/:id/tasks/submit`

Submit an idea for autonomous execution. This is the chat-first path used by the web app; it creates the task, records the first message, and starts execution.

**Body:**

```json
{
  "message": "Fix the login button on the settings page"
}
```

## File Proxy (Project Chat)

These endpoints proxy file operations to the workspace's VM agent, accessed through a project chat session.

### `GET /api/projects/:id/sessions/:sessionId/files/list`

List files in a workspace directory.

### `GET /api/projects/:id/sessions/:sessionId/files/view`

View the contents of a file in the workspace.

### `POST /api/projects/:id/sessions/:sessionId/files/upload`

Upload files to the workspace container (multipart form data).

### `GET /api/projects/:id/sessions/:sessionId/files/download`

Download a file from the workspace container.

### `GET /api/projects/:id/sessions/:sessionId/files/raw`

Stream a binary file (images, etc.) with MIME detection and ETag support.

### `GET /api/projects/:id/sessions/:sessionId/git/status`

Get git status of the workspace repository.

### `GET /api/projects/:id/sessions/:sessionId/git/diff`

Get git diff output for the workspace repository.

## Terminal

### `POST /api/terminal/token`

Generate a short-lived JWT for WebSocket terminal access.

**Body:**

```json
{
  "workspaceId": "ws-abc123"
}
```

**Response:**

```json
{
  "token": "eyJhbG...",
  "expiresAt": 1730000000000,
  "workspaceUrl": "https://ws-abc123.example.com"
}
```

The client opens the terminal WebSocket at `wss://ws-abc123.example.com/terminal/ws/multi?token=...` using the returned token.

## Utility

### `GET /health`

Public health check endpoint. Returns `{ "status": "healthy", "timestamp": "..." }` (or `"degraded"` with a `503` when critical bindings are unavailable). No version or internal details are exposed.

### `GET /.well-known/jwks.json`

JSON Web Key Set for JWT verification by VM Agents.

### `GET /api/agent/download`

Download the VM Agent binary. Query params: `os` (linux), `arch` (amd64, arm64).

Used by cloud-init during VM (BYOC) provisioning. The Cloudflare Container instant-session runtime does **not** call this endpoint — its vm-agent binary is baked into the container image at deploy time.

### `POST /api/projects/:projectId/sessions/start`

Start an [Instant](/docs/guides/instant-sessions/) chat session. Returns **`202`** with `{ status: 'starting', runtime, taskId, sessionId, workspaceId, nodeId, workspaceUrl }` as soon as the records exist; the container launch, repository clone, agent start, and first prompt continue in the background, so a client disconnect no longer strands the session.

Because the launch is asynchronous, the response does **not** carry `agentSessionId`, `acpSessionId`, or launch `timings` — poll the session or connect to its stream for live state.

This endpoint is Instant-only. It returns `409` (`Selected profile resolves to VM runtime; use task submission instead.`) whenever the runtime resolves to VM — because the profile pins `vm`, because the caller has their own or a project cloud credential, or because `CF_CONTAINER_ENABLED` is not `true` for the deployment. Use `POST /api/projects/:id/tasks/submit` for VM work.

## Issue Reports

See [Reporting Issues](/docs/guides/reporting-issues/) for the user-facing flow and the operator configuration these endpoints depend on.

### `GET /api/report-issue/config`

Report whether in-app issue reporting is available on this deployment. Returns `{ "enabled": false }` when no effective private feedback project is configured, or when the effective setting does not name an existing project — the UI hides both entry points in that case.

### `POST /api/report-issue`

Submit an issue report. Returns `201` with the grouped incident's private draft Idea `ideaId`, its `status`, and `attachedRefKeys` listing the technical references that were actually stored. Repeated matching reports update the same grouped incident/Idea instead of creating one Idea per occurrence.

Body fields: `title`, `description`, `consentToAttachRefs`, and an optional `refs` object (`sessionId`, `taskId`, `nodeId`, `errorId`, `diagnosisId`). References are only stored when `consentToAttachRefs` is true, and each is re-checked against the caller's access first — unauthorized references are dropped silently rather than rejecting the request, so `attachedRefKeys` may be shorter than what was sent.

Rate-limited to 20 submissions per clock hour per user (`RATE_LIMIT_REPORT_ISSUE_POST`); exceeding it returns `429`.

### `POST /api/admin/observability/feedback-triage`

Superadmin only. Runs a platform-error triage sweep immediately instead of waiting for the hourly cron. The feedback project itself is configured from **Admin → Integrations** or the environment fallback; this endpoint remains the manual way to verify automated triage without waiting up to an hour.

## Admin Runtime Controls

These endpoints require an approved, authenticated **superadmin**. The switches
are availability brakes: an absent KV key or KV read error means enabled
(fail-open), so a transient KV outage does not silently halt recovery work.

### `GET /api/admin/runtime-controls`

Read the cron-sweep and Durable Object alarm switches. The response includes
`cronSweepsEnabled`, `doAlarmsEnabled`, the resolved KV keys, the in-memory
cache TTL, the disabled-alarm retry interval, and `semantics: "fail-open"`.

### `PATCH /api/admin/runtime-controls`

Update either or both switches. At least one field is required and every
provided value must be boolean.

```json
{
  "cronSweepsEnabled": false,
  "doAlarmsEnabled": false
}
```

Disabling the alarm switch does not drop alarm chains: each affected Durable
Object re-arms at the reported safe retry interval and resumes normally after
the switch is enabled again.
