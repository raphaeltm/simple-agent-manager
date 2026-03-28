---
title: API Reference
description: SAM REST API endpoints for managing workspaces, nodes, and credentials.
---

The SAM API runs on a Cloudflare Worker at `api.{domain}`. All authenticated endpoints require a valid BetterAuth session cookie.

:::note
This reference covers the most commonly used endpoints. For the complete list of all API routes, see the [source code](https://github.com/raphaeltm/simple-agent-manager/tree/main/apps/api/src/routes).
:::

## Authentication

### `POST /api/auth/sign-in/social`
Start GitHub OAuth flow. Redirects to GitHub for authorization.

### `POST /api/auth/sign-out`
End the current session.

### `GET /api/auth/get-session`
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
Stop a running workspace. Powers off the VM if no other workspaces are using the node.

### `POST /api/workspaces/:id/restart`
Restart a stopped or errored workspace. Provisions a new VM and recreates the container.

### `DELETE /api/workspaces/:id`
Permanently delete a workspace and clean up all associated resources.

### `GET /api/workspaces/:id/boot-log`
Get the provisioning progress log for a workspace.

## Agent Sessions

### `POST /api/workspaces/:id/agent-sessions`
Create a new Claude Code agent session in a workspace.

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

### `DELETE /api/credentials/:id`
Delete a stored credential.

## GitHub

### `GET /api/github/installations`
List GitHub App installations for the authenticated user.

### `GET /api/github/installations/:id/repos`
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
Submit an idea for autonomous execution.

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
  "workspaceUrl": "wss://ws-abc123.example.com"
}
```

## Utility

### `GET /health`
Health check endpoint. Returns status and version info.

### `GET /.well-known/jwks.json`
JSON Web Key Set for JWT verification by VM Agents.

### `GET /api/agent/download`
Download the VM Agent binary. Query params: `os` (linux), `arch` (amd64, arm64).
