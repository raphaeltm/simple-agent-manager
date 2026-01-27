# API Contracts: Local Mock Mode

**Feature**: 002-local-mock-mode
**Date**: 2025-01-25

## No New Endpoints

This feature does not introduce new API endpoints. It reuses the existing workspace management API with different underlying providers.

## Existing Endpoints (Unchanged)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /vms | Create workspace |
| GET | /vms | List workspaces |
| GET | /vms/:id | Get workspace details |
| DELETE | /vms/:id | Stop/delete workspace |
| POST | /vms/:id/cleanup | Cleanup callback (internal) |

## Behavioral Differences in Mock Mode

While the API contract is identical, mock mode has these behavioral differences:

### POST /vms

**Production (HetznerProvider)**:
- Creates cloud VM via Hetzner API
- Creates DNS record via Cloudflare API
- Returns VM public IP

**Mock Mode (DevcontainerProvider)**:
- Clones repo locally
- Runs `devcontainer up`
- Returns container's internal IP
- DNS record stored in memory only

### Response Differences

The `serverType` field indicates the provider:

```json
// Production
{
  "id": "abc123",
  "serverType": "cx22",
  ...
}

// Mock Mode
{
  "id": "abc123",
  "serverType": "devcontainer-medium",
  ...
}
```

### Error Responses (Mock Mode Only)

| HTTP Status | Error | Description |
|-------------|-------|-------------|
| 503 | Docker not running | Docker daemon is not available |
| 503 | devcontainer CLI not found | CLI not installed |
| 409 | Workspace already exists | Single workspace limit reached |

## Interface Contracts

See `data-model.md` for:
- Provider interface (implemented by DevcontainerProvider)
- DNSService interface (implemented by MockDNSService)
