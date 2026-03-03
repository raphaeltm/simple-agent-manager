# OpenAI Codex OAuth Token Support (Bring Your ChatGPT Subscription)

**Created**: 2026-03-03
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Medium

## Context

SAM already supports dual authentication for Claude Code: API keys (`ANTHROPIC_API_KEY`) and OAuth tokens (`CLAUDE_CODE_OAUTH_TOKEN`) from Claude Max/Pro subscriptions. However, OpenAI Codex currently only supports API key authentication (`OPENAI_API_KEY`) in SAM, despite OpenAI actively embracing subscription-based access for third-party tools.

OpenAI has taken the opposite approach to Anthropic on subscription usage in third-party tools. While Anthropic restricts OAuth token usage outside their own clients, OpenAI openly supports it — their official Codex CLI, IDE extensions (JetBrains, VS Code), and now third-party tools like Cline, OpenCode, and Kilo Code can all authenticate via ChatGPT subscription OAuth. This is a significant user experience and cost advantage we should support.

## Problem Statement

Users with ChatGPT Plus ($20/mo), Pro ($200/mo), Business, Enterprise, or Edu subscriptions cannot use their existing subscriptions with SAM's OpenAI Codex agent. They must separately provision and pay for OpenAI Platform API credits. This means:

1. **Double-paying**: Users pay for a ChatGPT subscription AND separate API credits
2. **Cost unpredictability**: API usage is per-token; subscriptions are flat-rate
3. **Credential friction**: API keys need manual provisioning, rotation, and management
4. **Competitive disadvantage**: Cline, JetBrains, and other tools already support "Sign in with ChatGPT"

## Research Findings

### OpenAI Codex OAuth Technical Architecture

OpenAI uses a standard **OAuth 2.0 Authorization Code flow with PKCE (S256)** for ChatGPT subscription authentication:

- **Authorization endpoint**: `https://auth.openai.com/oauth/authorize`
- **Token endpoint**: `https://auth.openai.com/oauth/token`
- **Client ID**: `app_EMoamEEZ73f0CkXaXp7hrann` (public client used by official Codex CLI)
- **Scopes**: `openid profile email offline_access`
- **PKCE**: SHA-256 code challenge from 32-byte random verifier
- **Redirect URI**: `http://localhost:1455/auth/callback` (localhost-based for CLI tools)

**Token lifecycle:**
- Access tokens refresh automatically (every ~8 days via `https://auth.openai.com/oauth/token`)
- Refresh tokens provide long-lived sessions
- Token storage: `~/.codex/auth.json` with format:
  ```json
  {
    "auth_mode": "chatgpt",
    "tokens": {
      "access_token": "...",
      "refresh_token": "...",
      "id_token": "...",
      "expires_at": "2026-12-31T23:59:59Z"
    }
  }
  ```

### Authentication Methods Available

1. **Browser-based OAuth** (`codex login`): Opens browser, PKCE flow, localhost callback
2. **Device Code** (`codex login --device-auth`): For headless environments, user enters code at `https://auth.openai.com/codex/device`
3. **API Key** (`OPENAI_API_KEY` env var or `codex login --with-api-key`): Standard platform API key
4. **auth.json copy**: Transfer `~/.codex/auth.json` between machines (headless workaround)

### How Third-Party Tools Integrate

- **Cline** (VS Code extension): "Sign in with OpenAI" button triggers OAuth flow, routes inference requests through subscription, detects all available models automatically
- **JetBrains AI Assistant**: Settings > AI Assistant > Providers > "Sign in with ChatGPT Account"
- **OpenCode**: `/connect` command with Codex auth plugin (`@spmurrayzzz/opencode-openai-codex-auth`)
- **Kilo Code**: BYOK model, bring any provider's API key or OAuth token

All these tools use the **same OAuth endpoint and client flow** as the official Codex CLI.

### How Codex CLI Consumes the Token

The Codex CLI reads from `~/.codex/auth.json` at startup. When an OAuth token is active, it uses the `access_token` as a Bearer token for API requests to OpenAI's inference endpoints. The CLI handles token refresh transparently.

**Key insight for SAM**: The Codex ACP binary (`codex-acp`) likely reads from the same `auth.json` file OR accepts the token via environment variable. We need to verify the exact injection mechanism — options include:
1. **Environment variable injection** (like Claude's `CLAUDE_CODE_OAUTH_TOKEN`) — cleanest for SAM
2. **auth.json file injection** — write the token to `~/.codex/auth.json` inside the container before starting the agent
3. **Stdin piping** — `echo $TOKEN | codex login --with-api-key` (but this is for API keys, not OAuth)

### Existing SAM Architecture (What We Already Have)

SAM's credential system is already designed for multi-provider, multi-credential-kind support:

**Database schema** (`apps/api/src/db/schema.ts`):
- `credentials` table supports `credentialKind: 'api-key' | 'oauth-token'`
- `agentType` field supports `'openai-codex'`
- Unique index on `(userId, agentType, credentialKind)` — already supports storing both API key and OAuth token per agent

**Agent catalog** (`packages/shared/src/agents.ts`):
- `AgentDefinition` interface already has `oauthSupport?` optional field
- Claude Code already uses it; OpenAI Codex just needs it populated
- `CredentialKind` type already includes `'oauth-token'`

**VM agent** (`packages/vm-agent/internal/acp/gateway.go`):
- `getAgentCommandInfo()` already switches on `credentialKind` for Claude Code
- Needs equivalent branch for `openai-codex` + `oauth-token`

**UI** (`apps/web/src/components/AgentKeysSection.tsx`, `AgentKeyCard.tsx`):
- Already renders OAuth toggle and setup instructions based on `oauthSupport` field
- Will automatically support OpenAI Codex once the catalog entry is updated

**Credential API** (`apps/api/src/routes/credentials.ts`):
- `PUT /api/credentials/agent` — already validates `oauthSupport` before accepting OAuth tokens
- `POST /api/credentials/agent/:agentType/toggle` — already handles switching between API key and OAuth token
- No changes needed to the API routes

## Implementation Plan

### Phase 1: Core OAuth Token Support (MVP)

The architecture is already 90% there. The changes are minimal:

#### 1.1 Update Agent Catalog (`packages/shared/src/agents.ts`)

Add `oauthSupport` to the OpenAI Codex agent definition:

```typescript
{
  id: 'openai-codex',
  name: 'OpenAI Codex',
  description: "OpenAI's AI coding agent",
  provider: 'openai',
  envVarName: 'OPENAI_API_KEY',
  acpCommand: 'codex-acp',
  acpArgs: [],
  supportsAcp: true,
  credentialHelpUrl: 'https://platform.openai.com/api-keys',
  installCommand: 'npx --yes @zed-industries/codex-acp --version',
  oauthSupport: {
    envVarName: 'CODEX_OAUTH_TOKEN',  // or write to auth.json — needs verification
    setupInstructions: 'Run "codex login" in your terminal and sign in with your ChatGPT account, then copy the token from ~/.codex/auth.json',
    subscriptionUrl: 'https://openai.com/chatgpt/pricing/',
  },
}
```

**Open question**: What environment variable does `codex-acp` accept for OAuth tokens? Options:
- Direct env var (like `CODEX_OAUTH_TOKEN` or `OPENAI_OAUTH_TOKEN`) — needs testing
- Injecting `~/.codex/auth.json` into the container filesystem — fallback approach

#### 1.2 Update VM Agent Credential Injection (`packages/vm-agent/internal/acp/gateway.go`)

Add OAuth token handling for `openai-codex` in `getAgentCommandInfo()`:

```go
case "openai-codex":
    if credentialKind == "oauth-token" {
        // Option A: env var (if codex-acp supports it)
        return agentCommandInfo{"codex-acp", nil, "CODEX_OAUTH_TOKEN", "npm install -g @zed-industries/codex-acp"}
        // Option B: write auth.json (if env var not supported)
        // Handled separately in startAgent()
    }
    return agentCommandInfo{"codex-acp", nil, "OPENAI_API_KEY", "npm install -g @zed-industries/codex-acp"}
```

If `codex-acp` doesn't support a direct environment variable for OAuth tokens, we'll need an alternative injection path:
- Write `~/.codex/auth.json` into the container before starting the agent process
- This would require a small addition to `startAgent()` in `session_host.go`

#### 1.3 Update Credential Validation (`apps/api/src/services/validation.ts`)

Add format validation for OpenAI OAuth tokens (if the format differs from API keys):
- OpenAI API keys start with `sk-`
- OAuth access tokens have a different format — validate accordingly
- May need to accept refresh tokens as well if we handle refresh server-side

#### 1.4 Add/Update Tests

- [ ] Unit test: `getAgentCommandInfo("openai-codex", "oauth-token")` returns correct env var
- [ ] Unit test: Agent catalog lookup for OpenAI Codex returns `oauthSupport` metadata
- [ ] Integration test: Credential save/retrieve/toggle for OpenAI Codex OAuth tokens
- [ ] UI test: Settings page shows OAuth toggle for OpenAI Codex agent

### Phase 2: Token Refresh (If Needed)

OpenAI OAuth access tokens expire (~8 days). If we store only the access token:
- Users need to re-paste when it expires
- Acceptable for MVP since Claude Code OAuth tokens have the same limitation

If we want automatic refresh:
- Store the refresh token (encrypted) alongside the access token
- Add a refresh endpoint or middleware that checks expiry before injection
- Call `https://auth.openai.com/oauth/token` with `grant_type=refresh_token`
- This is a nice-to-have improvement, not required for initial launch

### Phase 3: Browser-Based OAuth Flow (Future Enhancement)

Instead of users copying tokens manually, SAM could implement the full OAuth flow:
1. User clicks "Sign in with OpenAI" in SAM Settings
2. SAM redirects to `https://auth.openai.com/oauth/authorize` with PKCE
3. User authenticates with OpenAI
4. Callback returns to SAM with auth code
5. SAM exchanges code for tokens and stores them

**Considerations**:
- Requires a registered OAuth client ID with OpenAI (may need to use the public Codex client ID or register our own)
- PKCE flow can be done entirely client-side (public client)
- Would eliminate the manual token copy step entirely
- Similar to how Cline implements "Sign in with OpenAI"

## Checklist

### Pre-Implementation Research
- [ ] Verify how `codex-acp` accepts OAuth credentials (env var vs auth.json)
- [ ] Test OpenAI OAuth token format to establish validation rules
- [ ] Check if `codex-acp` supports device code auth for headless environments

### Implementation (Phase 1)
- [ ] Add `oauthSupport` to OpenAI Codex entry in `packages/shared/src/agents.ts`
- [ ] Update `getAgentCommandInfo()` in `packages/vm-agent/internal/acp/gateway.go`
- [ ] If auth.json injection needed: update `startAgent()` in `session_host.go`
- [ ] Update credential validation in `apps/api/src/services/validation.ts` (if format differs)
- [ ] Add unit tests for new credential injection path
- [ ] Add integration tests for save/retrieve/toggle of OpenAI OAuth tokens
- [ ] Verify UI automatically picks up oauthSupport (no changes expected)
- [ ] Update CLAUDE.md agent authentication section if needed
- [ ] Test end-to-end: save OAuth token → start workspace → select Codex → agent authenticates

### Documentation
- [ ] Update `docs/architecture/credential-security.md` with OpenAI OAuth details
- [ ] Add user-facing instructions for obtaining OAuth token from `~/.codex/auth.json`

## Acceptance Criteria

- [ ] Users can save an OpenAI OAuth token in SAM Settings for the Codex agent
- [ ] Users can toggle between API key and OAuth token for OpenAI Codex
- [ ] OAuth token is correctly injected into workspace when Codex agent starts
- [ ] Codex agent successfully authenticates with OpenAI using the OAuth token
- [ ] Settings UI shows subscription info and setup instructions for OpenAI OAuth
- [ ] Existing API key flow for OpenAI Codex continues to work unchanged
- [ ] All credential security guarantees maintained (encryption at rest, no disk persistence in container)

## References

- [OpenAI Codex Auth Documentation](https://developers.openai.com/codex/auth/)
- [OpenAI Codex Configuration Reference](https://developers.openai.com/codex/config-reference/)
- [Cline OpenAI Codex OAuth Integration](https://cline.bot/blog/introducing-openai-codex-oauth)
- [OpenCode Codex Auth Plugin](https://www.npmjs.com/package/@spmurrayzzz/opencode-openai-codex-auth)
- [OpenHax Codex Plugin](https://github.com/open-hax/codex)
- [JetBrains Codex Integration](https://blog.jetbrains.com/ai/2026/01/codex-in-jetbrains-ides/)
- [Codex CLI GitHub Issues on Auth](https://github.com/openai/codex/issues/3820)
- [OpenAI Codex Pricing](https://developers.openai.com/codex/pricing/)

## Related Files

- `packages/shared/src/agents.ts` — Agent catalog (primary change)
- `packages/vm-agent/internal/acp/gateway.go` — Credential injection (primary change)
- `packages/vm-agent/internal/acp/session_host.go` — Agent startup (may need auth.json injection)
- `apps/api/src/routes/credentials.ts` — Credential API (likely no changes)
- `apps/api/src/services/validation.ts` — Credential validation (may need update)
- `apps/web/src/components/AgentKeysSection.tsx` — Settings UI (auto-picks up oauthSupport)
- `apps/web/src/components/AgentKeyCard.tsx` — Agent card UI (auto-picks up oauthSupport)
- `apps/api/src/db/schema.ts` — Database schema (no changes needed)
