# Credentials API

## Agent Credentials

### Save Agent Credential
`PUT /api/credentials/agent`

Saves an API key or OAuth token for an AI coding agent.

**Request Body:**
```json
{
  "agentType": "claude-code",
  "credentialKind": "oauth-token", // or "api-key"
  "credential": "token_or_key",
  "autoActivate": true // optional, defaults to true
}
```

**Response:**
```json
{
  "agentType": "claude-code",
  "provider": "anthropic",
  "credentialKind": "oauth-token",
  "isActive": true,
  "maskedKey": "...last4",
  "label": "Pro/Max Subscription",
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

### List Agent Credentials
`GET /api/credentials/agent`

Returns all saved agent credentials with their active status.

**Response:**
```json
{
  "credentials": [
    {
      "agentType": "claude-code",
      "provider": "anthropic",
      "credentialKind": "api-key",
      "isActive": false,
      "maskedKey": "...abc1",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z"
    },
    {
      "agentType": "claude-code",
      "provider": "anthropic",
      "credentialKind": "oauth-token",
      "isActive": true,
      "maskedKey": "...xyz2",
      "label": "Pro/Max Subscription",
      "createdAt": "2024-01-02T00:00:00Z",
      "updatedAt": "2024-01-02T00:00:00Z"
    }
  ]
}
```

### Toggle Active Credential
`POST /api/credentials/agent/:agentType/toggle`

Switches which credential is active for an agent.

**Request Body:**
```json
{
  "credentialKind": "oauth-token" // or "api-key"
}
```

**Response:**
```json
{
  "success": true,
  "activated": "oauth-token"
}
```

### Delete Specific Credential
`DELETE /api/credentials/agent/:agentType/:credentialKind`

Removes a specific credential type for an agent. If it was active, another credential is auto-activated if available.

**Response:**
```json
{
  "success": true
}
```

### Delete All Agent Credentials
`DELETE /api/credentials/agent/:agentType`

Removes all credentials for an agent.

**Response:**
```json
{
  "success": true
}
```

## OAuth Support Details

### Claude Code
- Supports both API keys (`ANTHROPIC_API_KEY`) and OAuth tokens (`CLAUDE_CODE_OAUTH_TOKEN`)
- OAuth tokens from Claude Max/Pro subscriptions via `claude setup-token`
- Automatic environment variable selection based on credential type
- OAuth tokens are treated as opaque values; API-side checks only reject obvious type mismatches

### Other Agents
- OpenAI Codex and Google Gemini currently only support API keys
- OAuth support planned for future releases
