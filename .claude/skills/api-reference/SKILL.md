---
name: api-reference
description: Full API endpoint reference for SAM. Use when working on API routes, adding endpoints, writing API tests, or understanding the API surface.
user-invocable: false
---

# SAM API Endpoint Reference

## Node Management

- `POST /api/nodes` — Create node
- `GET /api/nodes` — List user's nodes
- `GET /api/nodes/:id` — Get node details
- `POST /api/nodes/:id/stop` — Stop node
- `DELETE /api/nodes/:id` — Delete node
- `GET /api/nodes/:id/events` — List node events (proxied from VM Agent via control plane)
- `GET /api/nodes/:id/system-info` — Full system info (proxied from VM Agent)
- `POST /api/nodes/:id/token` — Get node-scoped token for direct VM Agent access

## Workspace Management

- `POST /api/workspaces` — Create workspace
- `GET /api/workspaces` — List user's workspaces
- `GET /api/workspaces/:id` — Get workspace details
- `PATCH /api/workspaces/:id` — Rename workspace display name
- `POST /api/workspaces/:id/sleep` — Strictly checkpoint and sleep a persistent session; verified VM snapshots are resumable on a replacement workspace
- `POST /api/workspaces/:id/stop` — Permanently stop a running workspace and delete retained session snapshot state
- `POST /api/workspaces/:id/restart` — Restart a workspace
- `DELETE /api/workspaces/:id` — Permanently delete a workspace and retained session snapshot state

## Project Management

- `POST /api/projects` — Create project
- `GET /api/projects` — List user's projects (supports `limit` and `cursor`)
- `GET /api/projects/:id` — Get project detail (includes task status counts and linked workspace count)
- `PATCH /api/projects/:id` — Update project metadata (`name`, `description`, `defaultBranch`)
- `DELETE /api/projects/:id` — Delete project (cascades project tasks/dependencies/events)

## Chat Sessions (Project Scoped)

- `GET /api/projects/:projectId/sessions` — List chat sessions for a project
- `GET /api/projects/:projectId/sessions/:sessionId` — Get chat session detail with recent messages
- `GET /api/projects/:projectId/sessions/:sessionId/state` — Get lightweight ACP activity state for a chat session
- `GET /api/projects/:projectId/sessions/:sessionId/messages` — List persisted session messages (supports `roles`, `before`, `limit`, `compact`, `order=asc|desc`)
- `GET /api/projects/:projectId/sessions/:sessionId/messages/:messageId/tool-content` — Lazy-load stored tool content for compact messages
- `POST /api/projects/:projectId/sessions/:sessionId/prompt` — Send a follow-up prompt to the active agent session
- `POST /api/projects/:projectId/sessions/:sessionId/attention/:markerId/resolve` — Validate, forward, and record one structured human-input answer (`{ answer }`)
- `POST /api/projects/:projectId/sessions/:sessionId/summarize` — Generate a session summary for conversation forking
- `POST /api/projects/:projectId/sessions/:sessionId/stop` — Stop a chat session

## Task Management (Project Scoped)

- `POST /api/projects/:projectId/tasks` — Create task
- `GET /api/projects/:projectId/tasks` — List tasks (supports `status`, `minPriority`, `sort`, `limit`, `cursor`)
- `GET /api/projects/:projectId/tasks/:taskId` — Get task detail (includes dependencies + blocked state)
- `PATCH /api/projects/:projectId/tasks/:taskId` — Update task fields (`title`, `description`, `priority`, `parentTaskId`)
- `DELETE /api/projects/:projectId/tasks/:taskId` — Delete task
- `POST /api/projects/:projectId/tasks/:taskId/status` — Transition task status
- `POST /api/projects/:projectId/tasks/:taskId/status/callback` — Trusted callback status update for delegated tasks
- `POST /api/projects/:projectId/tasks/:taskId/dependencies` — Add dependency edge (`dependsOnTaskId`)
- `DELETE /api/projects/:projectId/tasks/:taskId/dependencies?dependsOnTaskId=...` — Remove dependency edge
- `POST /api/projects/:projectId/tasks/:taskId/delegate` — Delegate ready+unblocked task to owned running workspace
- `GET /api/projects/:projectId/tasks/:taskId/events` — List append-only task status events

## MCP Orchestration

- `wait_for_subtasks` — Task-agent-only tool that registers one durable wait for unique direct-child task IDs. `waitKey` is a required stable workflow-step idempotency key and must be reused after a lost response. `condition` is `all` (default) or `any`; optional `wakeAfterSeconds` is positive and server-capped. Persist workflow state before calling, then end the turn. ProjectData wakes the parent through exact-once durable prompt delivery when the condition or finite deadline resolves.
- `dispatch_task` — Create a direct child task subject to project dispatch depth and concurrency limits.
- `get_task_details` / `get_peer_agent_output` — Read authoritative child status and output after a durable wake.

`wait_for_subtasks` rejects conversation/direct-workspace agents, non-child IDs, terminal parents, duplicate IDs, mismatched parent sessions, invalid wait keys, and installations where durable prompt delivery is disabled. Reusing the same `waitKey` and intent is idempotent even after resolution; using a key for a different intent is rejected. Automatic wake prompts contain only trusted task IDs/statuses—child-authored summaries, errors, and URLs must be fetched explicitly and treated as untrusted data.

## Administration (Superadmin Only)

- `GET /api/admin/tasks/stuck` — List tasks currently in transient states
- `GET /api/admin/tasks/:taskId/reconciliation-diagnostics` — Read the TaskRunner probe, task-scoped runtime liveness, eligibility threshold, reconciliation decision, and whether/where the bounded cursor page selects the task, without mutating task state
- `GET /api/admin/tasks/recent-failures` — List recent failed tasks with error details
- `GET /api/admin/observability/errors` — Query platform errors; VM error rows include their same-installation diagnostic incident summary
- `GET /api/admin/observability/errors/:errorId/incident` — Read one diagnostic incident summary and redacted preview
- `GET /api/admin/observability/errors/:errorId/incident/artifacts/:artifactId/download` — Stream one private diagnostic artifact through the authenticated Worker; R2 keys and URLs are never exposed
- `GET /api/admin/project-data/storage` — List latest per-project ProjectData storage telemetry from D1 (`projectId`, `status`, `limit` filters)
- `POST /api/admin/project-data/storage/:projectId/measure` — Force one ProjectData `databaseSize` measurement and D1 telemetry upsert
- `POST /api/admin/project-data/storage/:projectId/emergency-purge` — Run a bounded ProjectData emergency purge of oldest `activity_events` and `acp_session_events` rows only

## Agent Sessions

- `GET /api/workspaces/:id/agent-sessions` — List workspace agent sessions
- `POST /api/workspaces/:id/agent-sessions` — Create agent session (optional `worktreePath` binds session to a worktree)
- `PATCH /api/workspaces/:id/agent-sessions/:sessionId` — Rename agent session label
- `POST /api/workspaces/:id/agent-sessions/:sessionId/stop` — Stop agent session

### VM Agent direct execution protocol (node-management JWT)

- `GET /workspaces/:workspaceId/agent-capabilities` — Discover VM execution protocol version, durable receipt support, checkpoint-rollover support, and configured timing bounds
- `POST /workspaces/:workspaceId/agent-sessions/:sessionId/start` — Start a session; optional protocol-v1 `deliveryId` durably guards the initial prompt
- `POST /workspaces/:workspaceId/agent-sessions/:sessionId/prompt` — Send a follow-up; optional protocol-v1 `deliveryId` durably guards agent invocation
- `GET /workspaces/:workspaceId/agent-sessions/:sessionId/prompt-receipts/:deliveryId` — Reconcile `accepted`, `in_flight`, `completed`, or cross-runtime `ambiguous` delivery state
- `POST /workspaces/:workspaceId/agent-sessions/:sessionId/checkpoint-rollovers` — Submit an idempotent protocol-v1 graceful/forced strict same-session rollover operation
- `GET /workspaces/:workspaceId/agent-sessions/:sessionId/checkpoint-rollovers/:operationId` — Reconcile rollover state

All direct routes require the workspace-scoped node-management Bearer token. Omitting new version/delivery fields preserves the legacy start/prompt behavior. Automatic rollover remains disabled until a control-plane caller invokes it.

## Agent Settings

- `GET /api/agent-settings/:agentType` — Get user's agent settings
- `PUT /api/agent-settings/:agentType` — Upsert agent settings (model, permissionMode)
- `DELETE /api/agent-settings/:agentType` — Reset agent settings to defaults

## Notifications

- `GET /api/notifications` — List notifications (supports `cursor`, `limit`, `filter`, `type`, `projectId`, `sessionId`)
- `GET /api/notifications/unread-count` — Get unread notification count
- `POST /api/notifications/:id/read` — Mark a notification as read
- `POST /api/notifications/read-all` — Mark all notifications as read
- `POST /api/notifications/:id/dismiss` — Dismiss a notification
- `GET /api/notifications/preferences` — Get notification preferences
- `PUT /api/notifications/preferences` — Update a notification preference
- `POST /api/notifications/push/subscriptions` — Add or refresh the authenticated browser's PushSubscription
- `GET /api/notifications/push/subscriptions` — List the authenticated user's PushSubscriptions
- `DELETE /api/notifications/push/subscriptions` — Remove the authenticated user's matching endpoint (`{ endpoint }`)
- `GET /api/notifications/ws` — WebSocket upgrade for real-time notification delivery
- `GET /api/config/vapid-public-key` — Public runtime VAPID key used when creating a browser PushSubscription

## Automation Triggers (Project Scoped)

- `POST /api/projects/:projectId/triggers` — Create a cron, GitHub, or generic webhook trigger. Webhook creation requires `agentProfileId` and `webhookConfig`; its response includes a one-time `webhookCredential`.
- `GET /api/projects/:projectId/triggers` — List triggers with safe source configuration. Webhook tokens are redacted to `tokenLastFour`.
- `GET /api/projects/:projectId/triggers/:triggerId` — Get trigger details and recent execution history.
- `PATCH /api/projects/:projectId/triggers/:triggerId` — Update common trigger settings or source-specific webhook configuration.
- `DELETE /api/projects/:projectId/triggers/:triggerId` — Delete a trigger and cascading source configuration, delivery audit, and execution history.
- `POST /api/projects/:projectId/triggers/:triggerId/test` — Preview the cron template context.
- `POST /api/projects/:projectId/triggers/:triggerId/run` — Submit a manual trigger execution. Webhook triggers accept optional `{ payload, headers }` preview context.
- `POST /api/projects/:projectId/triggers/:triggerId/webhook/preview` — Render a webhook template and evaluate configured filters without creating an execution.
- `POST /api/projects/:projectId/triggers/:triggerId/webhook/rotate` — Rotate the webhook bearer token and return the replacement once.
- `GET /api/projects/:projectId/triggers/:triggerId/webhook/deliveries` — List redacted webhook delivery audit metadata (`limit`, `cursor`).
- `POST /api/webhooks/ingest` — Public generic webhook ingress. Requires `Authorization: Bearer <token>`, `Content-Type: application/json`, and a JSON object body. Supports optional `Idempotency-Key`.

The MCP `create_trigger` tool intentionally creates cron triggers only. Generic webhook creation, filter management, preview, and credential rotation use the authenticated UI/REST surface so one-time credentials can be presented safely.

## VM Communication (Callback Endpoints)

- `POST /api/nodes/:id/ready` — Node Agent ready callback
- `POST /api/nodes/:id/heartbeat` — Node Agent heartbeat callback
- `POST /api/nodes/:id/errors` — VM agent error report batch. An optional stable ULID `incidentId` makes persistence idempotent; error-level entries create the same-installation diagnostic incident before acknowledgment.
- `POST /api/nodes/:id/diagnostic-incidents/:incidentId/artifacts` — Register bounded, redacted VM evidence metadata using the node callback JWT
- `PUT /api/nodes/:id/diagnostic-incidents/:incidentId/artifacts/:artifactId/content` — Stream the registered gzip artifact into private R2 storage using the node callback JWT
- `POST /api/workspaces/:id/ready` — Workspace ready callback
- `POST /api/workspaces/:id/provisioning-failed` — Workspace provisioning failure callback (sets workspace to `error`)
- `POST /api/workspaces/:id/heartbeat` — Workspace activity heartbeat callback
- `GET /api/workspaces/:id/runtime` — Workspace runtime metadata callback (repository/branch for recovery)
- `POST /api/workspaces/:id/boot-log` — Workspace boot progress log callback
- `POST /api/workspaces/:id/agent-settings` — Workspace agent settings callback (model, permissionMode)
- `POST /api/workspaces/:id/session-snapshot/prepare` — Prepare deterministic R2 artifact uploads for the workspace-scoped chat snapshot
- `POST /api/workspaces/:id/session-snapshot/artifacts/:artifact/upload-url` — Authorize a short-lived, exact-length/checksum-bound private-R2 PUT for `home` or `wip`. Requires the workspace callback bearer; current-agent relays additionally present their independent node-scoped callback identity.
- `PUT /api/workspaces/:id/session-snapshot/artifacts/:artifact` — Upload a bounded HOME tar or Git WIP bundle with a workspace callback token
- `POST /api/workspaces/:id/session-snapshot/complete` — Verify artifact metadata and commit the snapshot manifest
- `POST /api/workspaces/:id/session-snapshot/failure` — Persist a generation-scoped VM-agent capture failure so sleep fallback can degrade with the real capture error
- `GET /api/workspaces/:id/session-snapshot/restore` — Fetch strict restore metadata and signed artifact paths
- `POST /api/workspaces/:id/session-snapshot/restore-result` — Persist the VM Agent's strict restore result
- `POST /api/bootstrap/:token` — Redeem one-time bootstrap token (credentials + git identity)
- `POST /api/agent/ready` — VM agent ready callback
- `POST /api/agent/activity` — VM agent activity report

### VM Agent snapshot relay (busy legacy node compatibility)

- `PUT /session-snapshot-upload-relay?authorizationPath=...` — A current same-user managed VM streams a busy legacy agent's bounded snapshot to the checksum-bound R2 URL returned by the control plane. The relay supplies independent workspace- and node-scoped callback credentials, accepts only the exact relative snapshot authorization route, uses the configurable snapshot-operation deadline, and forwards neither bearer to R2.

## Terminal Access

- `POST /api/terminal/token` — Get terminal WebSocket token

## Git Integration (VM Agent direct — browser calls via ws-{id} subdomain)

- `GET /workspaces/:id/worktrees` — List git worktrees for the workspace
- `POST /workspaces/:id/worktrees` — Create a git worktree
- `DELETE /workspaces/:id/worktrees?path=...&force=true|false` — Remove a git worktree
- `GET /workspaces/:id/git/status?worktree=...` — Git status (staged, unstaged, untracked files)
- `GET /workspaces/:id/git/diff?path=...&staged=true|false&worktree=...` — Unified diff for a single file
- `GET /workspaces/:id/git/file?path=...&ref=HEAD&worktree=...` — Full file content

## File Browser (VM Agent direct — browser calls via ws-{id} subdomain)

- `GET /workspaces/:id/files/list?path=.&worktree=...` — Directory listing
- `GET /workspaces/:id/files/find?worktree=...` — Recursive flat file index

## Voice Transcription

- `POST /api/transcribe` — Transcribe audio via Workers AI (Whisper)

## Client Error Reporting

- `POST /api/client-errors` — Receive batched client-side errors for Workers observability logging

## Authentication (BetterAuth)

- `POST /api/auth/sign-in/social` — GitHub OAuth login
- `GET /api/auth/session` — Get current session
- `POST /api/auth/sign-out` — Sign out

## Credentials

- `GET /api/credentials` — Get the user's cloud provider connections. GCP returns safe `authType`, project, service-account email, zone, and optional key ID metadata; encrypted source credentials are never returned, and malformed rows are isolated.
- `POST /api/credentials` — Save a cloud provider credential. New GCP WIF writes use the versioned `workload-identity` variant.
- `DELETE /api/credentials/:provider` — Delete the stored cloud provider credential. GCP deletion atomically removes legacy and generated composable copies and cached derivatives; it does not revoke Google-managed keys.

### GCP

- `PUT /api/gcp/service-account` — Validate and atomically save or rotate an OAuth-free service-account JSON credential. Body: `{ serviceAccountJson, defaultZone }`. Verification and the mutation rate limit run before replacement; the response contains safe metadata only.
- `POST /api/gcp/setup` — Complete the recommended keyless WIF setup using an OAuth handle and store the versioned WIF credential.
- `POST /api/gcp/projects` — List Google Cloud projects for a short-lived infrastructure OAuth handle.
- `POST /api/gcp/verify` — Verify the currently stored GCP credential, dispatching to WIF or service-account authentication.

The service-account flow ignores uploaded endpoint fields and exchanges RS256 assertions only at SAM's fixed Google token endpoint.

## GitHub Integration

- `GET /api/github/installations` — List user's GitHub App installations
- `GET /api/github/repositories` — List accessible repositories
- `GET /api/github/branches?repository=owner/repo` — List branches for a repository

## Error Format

All API errors follow this format:

```typescript
{
  error: "error_code",
  message: "Human-readable description"
}
```
