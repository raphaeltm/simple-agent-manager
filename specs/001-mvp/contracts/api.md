# API Contract: Cloud AI Coding Workspaces MVP

**Feature**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)
**Phase**: 1 - Design
**Date**: 2026-01-24
**Updated**: 2026-01-25
**Base URL**: `https://api.{domain}`

## Overview

RESTful API for managing AI coding workspaces. All endpoints require bearer token authentication.

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
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repoUrl` | string | Yes | Git repository URL |
| `size` | string | No | VM size: `small`, `medium` (default), `large` |
| `name` | string | No | Custom workspace name |

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

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `invalid_repo_url` | Repository URL is malformed |
| 400 | `invalid_size` | Size must be small/medium/large |
| 400 | `github_required` | Private repo requires GitHub connection |
| 400 | `repo_not_accessible` | Repo not in GitHub App permissions |
| 503 | `provider_unavailable` | Cloud provider API is down |

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
| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status (optional) |

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

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace does not exist |

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

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace does not exist |
| 409 | `workspace_already_stopped` | Workspace is already stopped |

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
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reason` | string | Yes | Reason for cleanup: `idle_timeout`, `manual`, `error` |

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
Location: https://github.com/apps/cloud-ai-workspaces/installations/new
```

---

### GET /github/callback

GitHub App installation callback. Called by GitHub after user installs the app.

**Request**:
```http
GET /github/callback?installation_id=12345&setup_action=install HTTP/1.1
```

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `installation_id` | number | GitHub App installation ID |
| `setup_action` | string | `install` or `update` |

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
  "repositories": [
    "username/repo1",
    "username/repo2"
  ],
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

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `github_not_connected` | No GitHub App installation found |
| 502 | `github_api_error` | GitHub API unavailable |

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
| Code | HTTP Status | Description |
|------|-------------|-------------|
| `unauthorized` | 401 | Invalid or missing token |
| `forbidden` | 403 | Token valid but not allowed |
| `not_found` | 404 | Resource does not exist |
| `validation_error` | 400 | Request validation failed |
| `provider_error` | 502 | Cloud provider API error |
| `internal_error` | 500 | Unexpected server error |

---

## Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| POST /vms | 10 | 1 hour |
| GET /vms | 100 | 1 minute |
| GET /vms/:id | 100 | 1 minute |
| DELETE /vms/:id | 20 | 1 minute |
| POST /vms/:id/cleanup | 10 | 1 minute |

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

| Event | Payload |
|-------|---------|
| `workspace.created` | Full workspace object |
| `workspace.running` | Full workspace object |
| `workspace.failed` | Workspace with error |
| `workspace.stopping` | Workspace ID |
| `workspace.stopped` | Workspace ID |

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
    'Authorization': `Bearer ${API_TOKEN}`,
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
