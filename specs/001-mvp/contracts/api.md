# API Contract: Simple Agent Manager MVP

**Feature**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)
**Phase**: 1 - Design
**Date**: 2026-01-24
**Updated**: 2026-01-25
**Base URL**: `https://api.{domain}`

## Overview

RESTful API for managing AI coding workspaces. Authentication varies by route: browser routes use
the normal authenticated browser session, runtime callbacks use scoped callback JWTs, and other API
routes use the bearer-token contract described below.

---

## Authentication

All requests must include the `Authorization` header:

```
Authorization: Bearer {API_TOKEN}
```

**Error Response** (401 Unauthorized):

```json
{
  "error": "Unauthorized",
  "message": "Invalid or missing API token"
}
```

---

## Endpoints

### ACP interaction foundation and runtime permission bridge

These routes exist for the durable ACP interaction foundation. New interaction creation remains
disabled while `ACP_INTERACTIONS_ENABLED=false`; existing records remain readable and serviceable.
The Worker includes a versioned `acpInteractions` object in every agent-session start request. The
VM agent only creates permission interactions when that per-session contract is enabled; missing,
disabled, invalid, or unsupported contracts cancel the ACP permission request explicitly.

The start request uses this additive runtime contract (values shown are the centralized defaults):

```json
{
  "acpInteractions": {
    "enabled": false,
    "protocolVersion": 1,
    "permissionDeadlineMs": 1800000,
    "maxDeadlineMs": 14400000,
    "deadlineMarginMs": 60000,
    "requestMaxBytes": 32768,
    "optionsMaxCount": 16,
    "optionIdMaxChars": 128,
    "optionNameMaxChars": 200,
    "receiptLimit": 256,
    "responseMaxBytes": 65536,
    "settleRetryDelaysMs": [1000, 5000, 30000, 120000, 300000],
    "settleRetrySteadyMs": 300000
  }
}
```

Conversation-mode sessions use the separately configured conversation deadline in the serialized
`permissionDeadlineMs` field. The global default remains disabled. The VM rejects unknown protocol
versions and invalid or incomplete enabled contracts rather than inferring local defaults.

- `POST /api/projects/:projectId/workspaces/:workspaceId/acp-interactions` creates an
  interaction. It requires a workspace-scoped callback JWT; project, workspace,
  chat-session, and running agent-session identity are resolved server-side.
- `POST /api/projects/:projectId/workspaces/:workspaceId/acp-interactions/:interactionId/settle`
  records runtime cancellation or completion under the same callback-JWT binding.
- `GET /api/projects/:projectId/sessions/:sessionId/interactions` returns a safe snapshot.
  Project members without session ownership receive generic pending summaries only.
- `GET /api/projects/:projectId/sessions/:sessionId/interactions/:interactionId` returns
  decrypted detail only to the session creator and uses `Cache-Control: private, no-store`.
- `POST /api/projects/:projectId/sessions/:sessionId/interactions/:interactionId/answer`
  requires `task:write`, session-creator ownership, and the exact configured app Origin.
  The accepted decision is committed before no-wake delivery is attempted.
- `POST /workspaces/:workspaceId/agent-sessions/:sessionId/interactions/:interactionId/answer`
  is the dedicated runtime answer endpoint. It requires a node-management JWT whose workspace and
  node claims match the route and active runtime. Its JSON body contains `protocolVersion`, the same
  UUID `interactionId` as the route, UUID `generation`, `runtimeIdentity`, a `decision` of
  `selected_option`, `declined`, or `cancelled`, an exact `optionId` only for `selected_option`, and
  the durable `answerHash`. It returns a structural receipt status of `consumed`, `duplicate`,
  `conflict`, `stale_generation`, or `no_waiter`.

Runtime create/settle routes return `404` for mismatched workspace/project/session
binding, `409` for stale or conflicting state, and `410` for terminal workspaces.
Browser mutation routes reject callback/MCP bearer tokens because they require the
normal authenticated browser session in addition to the Origin check.

Permission requests use a fresh UUID generation for every ACP connection attachment. The VM agent
persists bounded option labels and structural tool metadata through the callback route, waits for
the durable answer, and accepts only an exact option ID. Create and wait share the exact outgoing
prompt attempt's cancellation/deadline even though the ACP SDK gives inbound permission callbacks
an independent connection context. An ambiguous create acknowledgement keeps waiting because the
durable create may already have committed. Raw tool input/content is never sent on the viewer
WebSocket or copied into the interaction payload. Runtime answers use the dedicated
node-management-JWT endpoint and an attempt-bound in-memory waiter/receipt registry; missing or stale
runtimes are never woken or recreated to consume an answer. Instant delivery forwards through the
already-running Durable Object container TCP port and never calls an SDK helper that can start the
container. A live runtime with no matching registry entry returns `no_waiter`; an absent or stopped
runtime returns an HTTP error before registry lookup.

### GET /projects/:projectId/library/:fileId/preview

Return an inline preview for supported project library files. Supported MIME
families are previewable images, PDF, Markdown, and HTML.

HTML preview safety contract: files stored as `text/html` MUST be returned as
`Content-Type: text/plain; charset=utf-8` with
`Content-Security-Policy: default-src 'none'`. The API preview response must
never serve generated HTML as `text/html`; clients that render HTML must fetch
the inert text and place it in a sandboxed iframe without same-origin access.

Unsupported MIME types return a client error without decrypting the file body.

### POST /vms

Create a new workspace.

**Request**:

```http
POST /vms HTTP/1.1
Authorization: Bearer {token}
Content-Type: application/json

{
  "repoUrl": "https://github.com/user/repo",
  "size": "medium",
  "name": "my-project"
}
```

**Request Body**:

| Field     | Type   | Required | Description                                   |
| --------- | ------ | -------- | --------------------------------------------- |
| `repoUrl` | string | Yes      | Git repository URL                            |
| `size`    | string | No       | VM size: `small`, `medium` (default), `large` |
| `name`    | string | No       | Custom workspace name                         |

> **Note**: Anthropic API key is NOT required. Users authenticate Claude Code via
> `claude login` in the CloudCLI terminal using their Claude Max subscription.

**Success Response** (201 Created):

```json
{
  "id": "ws-abc123",
  "name": "my-project",
  "repoUrl": "https://github.com/user/repo",
  "status": "creating",
  "size": "medium",
  "hostname": "ui.ws-abc123.vm.example.com",
  "accessUrl": null,
  "createdAt": "2026-01-24T12:00:00Z",
  "message": "Workspace is being created. This typically takes 2-5 minutes."
}
```

**Error Responses**:

| Status | Error                  | Description                             |
| ------ | ---------------------- | --------------------------------------- |
| 400    | `invalid_repo_url`     | Repository URL is malformed             |
| 400    | `invalid_size`         | Size must be small/medium/large         |
| 400    | `github_required`      | Private repo requires GitHub connection |
| 400    | `repo_not_accessible`  | Repo not in GitHub App permissions      |
| 503    | `provider_unavailable` | Cloud provider API is down              |

```json
{
  "error": "invalid_repo_url",
  "message": "Repository URL must start with https://"
}
```

---

### GET /vms

List all workspaces.

**Request**:

```http
GET /vms HTTP/1.1
Authorization: Bearer {token}
```

**Query Parameters**:

| Parameter | Type   | Description                 |
| --------- | ------ | --------------------------- |
| `status`  | string | Filter by status (optional) |

**Success Response** (200 OK):

```json
{
  "workspaces": [
    {
      "id": "ws-abc123",
      "name": "my-project",
      "status": "running",
      "accessUrl": "https://ui.ws-abc123.vm.example.com",
      "createdAt": "2026-01-24T12:00:00Z"
    },
    {
      "id": "ws-def456",
      "name": "another-project",
      "status": "creating",
      "accessUrl": null,
      "createdAt": "2026-01-24T12:30:00Z"
    }
  ],
  "count": 2
}
```

---

### GET /vms/:id

Get workspace details.

**Request**:

```http
GET /vms/ws-abc123 HTTP/1.1
Authorization: Bearer {token}
```

**Success Response** (200 OK):

```json
{
  "id": "ws-abc123",
  "name": "my-project",
  "repoUrl": "https://github.com/user/repo",
  "status": "running",
  "providerId": "12345678",
  "provider": "hetzner",
  "ipAddress": "159.69.123.45",
  "hostname": "ui.ws-abc123.vm.example.com",
  "accessUrl": "https://ui.ws-abc123.vm.example.com",
  "size": "medium",
  "createdAt": "2026-01-24T12:00:00Z",
  "lastActivityAt": "2026-01-24T12:45:00Z",
  "error": null
}
```

**Error Responses**:

| Status | Error                 | Description              |
| ------ | --------------------- | ------------------------ |
| 404    | `workspace_not_found` | Workspace does not exist |

---

### DELETE /vms/:id

Stop and delete a workspace.

**Request**:

```http
DELETE /vms/ws-abc123 HTTP/1.1
Authorization: Bearer {token}
```

**Success Response** (200 OK):

```json
{
  "id": "ws-abc123",
  "status": "stopping",
  "message": "Workspace is being stopped. This typically takes 30 seconds."
}
```

**Error Responses**:

| Status | Error                       | Description                  |
| ------ | --------------------------- | ---------------------------- |
| 404    | `workspace_not_found`       | Workspace does not exist     |
| 409    | `workspace_already_stopped` | Workspace is already stopped |

---

### POST /vms/:id/cleanup

Callback endpoint for VM self-termination. Called by the VM before self-destruct.

**Request**:

```http
POST /vms/ws-abc123/cleanup HTTP/1.1
Authorization: Bearer {token}
Content-Type: application/json

{
  "reason": "idle_timeout"
}
```

**Request Body**:

| Field    | Type   | Required | Description                                           |
| -------- | ------ | -------- | ----------------------------------------------------- |
| `reason` | string | Yes      | Reason for cleanup: `idle_timeout`, `manual`, `error` |

**Success Response** (200 OK):

```json
{
  "id": "ws-abc123",
  "dnsCleanedUp": true,
  "message": "DNS records removed. VM may now self-terminate."
}
```

**Notes**:

- This endpoint is called by the VM, not the UI
- Removes DNS records before VM self-destructs
- Idempotent: can be called multiple times safely

---

## GitHub Integration Endpoints

### GET /github/connect

Initiate GitHub App installation. Redirects user to GitHub.

**Request**:

```http
GET /github/connect HTTP/1.1
Authorization: Bearer {token}
```

**Response** (302 Redirect):

```
Location: https://github.com/apps/simple-agent-manager/installations/new
```

---

### GET /github/callback

GitHub App installation callback. Called by GitHub after user installs the app.

**Request**:

```http
GET /github/callback?installation_id=12345&setup_action=install HTTP/1.1
```

**Query Parameters**:

| Parameter         | Type   | Description                |
| ----------------- | ------ | -------------------------- |
| `installation_id` | number | GitHub App installation ID |
| `setup_action`    | string | `install` or `update`      |

**Success Response** (302 Redirect):

```
Location: https://app.{domain}/?github=connected
```

**Error Response** (302 Redirect):

```
Location: https://app.{domain}/?github=error&message=...
```

---

### GET /github/status

Get current GitHub connection status.

**Request**:

```http
GET /github/status HTTP/1.1
Authorization: Bearer {token}
```

**Success Response** (200 OK) - Connected:

```json
{
  "connected": true,
  "installationId": 12345,
  "accountLogin": "username",
  "accountType": "User",
  "repositories": ["username/repo1", "username/repo2"],
  "installedAt": "2026-01-24T12:00:00Z"
}
```

**Success Response** (200 OK) - Not Connected:

```json
{
  "connected": false,
  "connectUrl": "https://api.{domain}/github/connect"
}
```

---

### GET /github/repos

List accessible repositories from GitHub App installation.

**Request**:

```http
GET /github/repos HTTP/1.1
Authorization: Bearer {token}
```

**Success Response** (200 OK):

```json
{
  "repositories": [
    {
      "fullName": "username/repo1",
      "private": true,
      "defaultBranch": "main",
      "description": "My private project"
    },
    {
      "fullName": "username/repo2",
      "private": false,
      "defaultBranch": "main",
      "description": "My public project"
    }
  ],
  "count": 2
}
```

**Error Responses**:

| Status | Error                  | Description                      |
| ------ | ---------------------- | -------------------------------- |
| 400    | `github_not_connected` | No GitHub App installation found |
| 502    | `github_api_error`     | GitHub API unavailable           |

---

### DELETE /github/disconnect

Disconnect GitHub App (does not uninstall from GitHub).

**Request**:

```http
DELETE /github/disconnect HTTP/1.1
Authorization: Bearer {token}
```

**Success Response** (200 OK):

```json
{
  "disconnected": true,
  "message": "GitHub connection removed. App remains installed on GitHub."
}
```

---

## Common Error Format

All errors follow this structure:

```json
{
  "error": "error_code",
  "message": "Human-readable description",
  "details": {}
}
```

**Common Error Codes**:

| Code               | HTTP Status | Description                 |
| ------------------ | ----------- | --------------------------- |
| `unauthorized`     | 401         | Invalid or missing token    |
| `forbidden`        | 403         | Token valid but not allowed |
| `not_found`        | 404         | Resource does not exist     |
| `validation_error` | 400         | Request validation failed   |
| `provider_error`   | 502         | Cloud provider API error    |
| `internal_error`   | 500         | Unexpected server error     |

---

## Rate Limits

| Endpoint              | Limit | Window   |
| --------------------- | ----- | -------- |
| POST /vms             | 10    | 1 hour   |
| GET /vms              | 100   | 1 minute |
| GET /vms/:id          | 100   | 1 minute |
| DELETE /vms/:id       | 20    | 1 minute |
| POST /vms/:id/cleanup | 10    | 1 minute |

**Rate Limit Headers**:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1706097600
```

**Rate Limit Exceeded** (429 Too Many Requests):

```json
{
  "error": "rate_limit_exceeded",
  "message": "Too many requests. Please wait before retrying.",
  "retryAfter": 60
}
```

---

## Webhook Events (Future)

For future integration, workspaces will emit events:

| Event                | Payload               |
| -------------------- | --------------------- |
| `workspace.created`  | Full workspace object |
| `workspace.running`  | Full workspace object |
| `workspace.failed`   | Workspace with error  |
| `workspace.stopping` | Workspace ID          |
| `workspace.stopped`  | Workspace ID          |

---

## SDK Usage Examples

### JavaScript/TypeScript

```typescript
const API_URL = 'https://api.example.com';
const API_TOKEN = 'your-token';

// Create workspace (no API key needed!)
const response = await fetch(`${API_URL}/vms`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    repoUrl: 'https://github.com/user/repo',
    size: 'medium',
  }),
});

const workspace = await response.json();
console.log(`Workspace ${workspace.id} is ${workspace.status}`);

// After workspace is running, user authenticates Claude Code
// by running `claude login` in the CloudCLI terminal
```

### cURL

```bash
# Connect GitHub (for private repos)
# This returns a redirect URL - open in browser
curl -I https://api.example.com/github/connect \
  -H "Authorization: Bearer $API_TOKEN"

# Check GitHub connection status
curl https://api.example.com/github/status \
  -H "Authorization: Bearer $API_TOKEN"

# Create workspace (no API key needed!)
curl -X POST https://api.example.com/vms \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/user/repo",
    "size": "medium"
  }'

# List workspaces
curl https://api.example.com/vms \
  -H "Authorization: Bearer $API_TOKEN"

# Delete workspace
curl -X DELETE https://api.example.com/vms/ws-abc123 \
  -H "Authorization: Bearer $API_TOKEN"
```

---

## OpenAPI Specification

Full OpenAPI 3.0 spec will be generated from route handlers and available at:

- `/openapi.json` - JSON format
- `/docs` - Swagger UI (optional, development only)

## Project event member controls

Active project members with `task:read` can `GET /api/projects/:projectId/event-subscriptions`
with `state`, `limit`, and `sessionId`, inspect `GET /:subscriptionId`, browse
`GET /api/projects/:projectId/event-channels`, and read `GET /event-channels/:channel/history`.
Subscription session filtering precedes the bounded SQL limit. Channel reads accept
`cursor` and `limit`; history discloses `watermark`, `hasMore`, and `retentionGap`.

`POST /api/projects/:projectId/event-subscriptions/:subscriptionId/cancel` requires
`task:write`, accepts only optional `reason`, and derives cancellation attribution
from the authenticated human. Human/agent-owned subscriptions can be cancelled;
policy/system/standing-watch ownership uses its separate control path. Cancellation
is idempotent and revokes pending canonical deliveries.

### Pinned Codex runtime download

`GET /api/acp/codex-runtime/download?release=<sha256>&os=linux&arch=amd64`
streams the exact reviewed public runtime archive from its immutable R2 key.
The release parameter is required and must match the server allowlist; Linux
amd64 is the only supported platform (glibc and Node 22+ are required at install).
Responses are 400 for unsupported release/platform, 404 before publication,
503 for unavailable storage or invalid artifact size, and 200 with immutable
cache headers for a published archive. Installers must verify the pinned SHA-256
before extraction or execution. This public binary endpoint grants no workspace
access and does not enable ACP features.

## MCP Webhook Credential Claim

`create_trigger` accepts `sourceType: "webhook"`, an explicit project-local `agentProfileId`, and `webhookConfig`. It returns safe `webhookClaim` metadata (`claimUrl`, ISO `expiresAt`, `endpointUrl`, `headerName`, `method`, handling instructions), never a plaintext credential. REST creation and rotation continue returning credentials once.

### POST /mcp/webhook-claims/:claimId

Authenticate with the originating project/user/workspace/session MCP bearer token. Current active project `task:write` membership is required. Atomic redemption returns the installed credential as `text/plain` with `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. Only its keyed hash is persisted.

Missing/revoked authentication returns 401; missing project capability returns 403; missing, expired, consumed, incorrectly scoped, disabled-trigger, or revoked claims return 404; MCP rate limiting returns 429. GET/HEAD never redeem. Concurrent redemptions have exactly one winner. Rotation clears pending claims and deletion cascades their removal. `WEBHOOK_CREDENTIAL_CLAIM_TTL_SECONDS` defaults to 600.

### Fresh VM boot failure callback

`POST /api/nodes/:id/boot-failure` accepts `{ "reason": "origin_ca_bootstrap" }` (also `vm_agent_download`) with an explicit node-scoped callback JWT. Only managed VMs before their first heartbeat/ready signal can record a failure. Returns `{ "accepted": true }` when recorded, `{ "accepted": false }` for a delayed report after startup, 401 for invalid/mismatched identity, 403 for wrong scope or unmanaged runtime, and 410 for terminal/missing nodes. Arbitrary diagnostics are not accepted. TaskRunner polls this signal and confirms failed-node deletion before a bounded fresh-VM replacement (default one).

### Lifecycle timing callback

- `POST /api/workspaces/:id/lifecycle-timings` — Workspace callback JWT; fixed bounded numeric lifecycle phase summary emitted to structured logs only. See `docs/notes/session-lifecycle-timings.md`.
