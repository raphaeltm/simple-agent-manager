---
title: API Reference
description: SAM REST API endpoints for managing workspaces, nodes, and credentials.
---

The SAM API runs on a Cloudflare Worker at `api.{domain}`. All authenticated endpoints require a valid BetterAuth session cookie.

:::note
This reference covers the most commonly used endpoints. For the complete list of all API routes, see the [source code](https://github.com/raphaeltm/simple-agent-manager/tree/main/apps/api/src/routes).
:::

## MCP orchestration

Task agents can call `wait_for_subtasks` with a stable workflow-step `waitKey`, unique direct-child task IDs, an optional `condition` of `all` (the default) or `any`, and an optional bounded `wakeAfterSeconds`. The agent must persist the workflow state and key before calling, reuse the key after a lost response, and end its turn after registration. ProjectData then reconciles child terminal state and durably wakes the same canonical parent session exactly once, including after session sleep and runtime replacement. Automatic wake prompts carry only trusted task IDs and statuses; agents fetch child-authored output explicitly as untrusted data. Servers without durable prompt delivery reject registration so clients can use bounded foreground polling as a compatibility fallback.

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

Permanently delete a workspace, its retained session snapshot, and all associated resources.

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

Report whether in-app issue reporting is available on this deployment. Returns `{ "enabled": false }` when `PLATFORM_FEEDBACK_PROJECT_ID` is unset or does not name an existing project — the UI hides both entry points in that case.

### `POST /api/report-issue`

Submit an issue report. Returns `201` with the created draft Idea's `ideaId`, its `status`, and `attachedRefKeys` listing the technical references that were actually stored.

Body fields: `title`, `description`, `consentToAttachRefs`, and an optional `refs` object (`sessionId`, `taskId`, `nodeId`, `errorId`, `diagnosisId`). References are only stored when `consentToAttachRefs` is true, and each is re-checked against the caller's access first — unauthorized references are dropped silently rather than rejecting the request, so `attachedRefKeys` may be shorter than what was sent.

Rate-limited to 20 submissions per clock hour per user (`RATE_LIMIT_REPORT_ISSUE_POST`); exceeding it returns `429`.

### `POST /api/admin/observability/feedback-triage`

Superadmin only. Runs a platform-error triage sweep immediately instead of waiting for the hourly cron. There is no UI for this yet, so it is the only way to verify a freshly configured `PLATFORM_FEEDBACK_PROJECT_ID` without waiting up to an hour.

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
