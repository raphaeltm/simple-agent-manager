# OpenAI Codex OAuth Token Support (Bring Your ChatGPT Subscription)

**Created**: 2026-03-03
**Updated**: 2026-03-04
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
- Token storage: `~/.codex/auth.json` with format (verified against real file 2026-03-04):
  ```json
  {
    "OPENAI_API_KEY": null,
    "tokens": {
      "id_token": "eyJ...<OIDC JWT>",
      "access_token": "eyJ...<RS256 JWT, ~1hr expiry>",
      "refresh_token": "<opaque, long-lived>",
      "account_id": "acct-..."
    },
    "last_refresh": "2026-03-03T15:32:25.189497Z"
  }
  ```
  Note: Initial research indicated an `auth_mode: "Chatgpt"` field with `rt_` prefix on refresh tokens. Real files use `OPENAI_API_KEY: null` and opaque refresh tokens without a fixed prefix. Validation accepts both formats.

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

All these tools use the **same OAuth endpoint and client flow** as the official Codex CLI. Notably, Cline and OpenCode **bypass the Codex CLI entirely** — they run their own OAuth flow, then call the ChatGPT backend API (`https://chatgpt.com/backend-api/codex/responses`) directly with Bearer tokens, transforming requests to match the ChatGPT backend format. This is a more invasive approach; SAM's approach of injecting `auth.json` into the container for `codex-acp` to read is simpler and more maintainable.

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

---

## Resolved Open Questions (Deep Research 2026-03-04)

### Q1: How does `codex-acp` accept OAuth credentials?

**Answer: `auth.json` file injection is REQUIRED. There is no OAuth env var.**

Deep analysis of the `codex-acp` Rust source code ([`src/codex_agent.rs`](https://github.com/zed-industries/codex-acp/blob/main/src/codex_agent.rs)) and the underlying `codex-core` auth system ([`codex-rs/core/src/auth.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/auth.rs)) reveals:

**Environment variables supported:**
- `OPENAI_API_KEY` — for API keys only (read via `read_openai_api_key_from_env()`)
- `CODEX_API_KEY` — for API keys only, CI/non-interactive mode only (read via `read_codex_api_key_from_env()`)
- **No `CODEX_OAUTH_TOKEN` or `OPENAI_OAUTH_TOKEN` env var exists**

**Auth resolution priority in `AuthManager::load_auth()`:**
1. `CODEX_API_KEY` env var (only when `enable_codex_api_key_env=true`, which is non-interactive/CI mode)
2. Ephemeral in-memory store (only used by app-server `chatgptAuthTokens` protocol, not by codex-acp)
3. Persistent store: `~/.codex/auth.json` (file mode) or OS keyring

**What this means for SAM:** Unlike Claude Code which has `CLAUDE_CODE_OAUTH_TOKEN`, there is no equivalent env var for Codex OAuth. The injection mechanism must be **writing `~/.codex/auth.json` into the container** before starting the `codex-acp` process. This is the same approach OpenAI recommends for headless/Docker environments.

**The `codex-acp` ACP `authenticate()` method** supports three auth methods:
1. ChatGPT browser login (`codex_login::run_login_server()`) — disabled when `NO_BROWSER` env var is set
2. `CODEX_API_KEY` env var → `codex_login::login_with_api_key()`
3. `OPENAI_API_KEY` env var → `codex_login::login_with_api_key()`

None of these paths accept an OAuth token directly. However, if `auth.json` already exists with valid tokens when `codex-acp` starts, `AuthManager::load_auth()` will find them in the persistent store and skip the authenticate step entirely.

### Q2: What is the OpenAI OAuth token format for validation?

**Answer: Access and ID tokens are JWTs (RS256-signed). Refresh tokens are opaque with `rt_` prefix.**

Analysis of [`codex-rs/core/src/token_data.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/token_data.rs) and the [OpenAI OIDC configuration](https://auth0.openai.com/.well-known/openid-configuration) reveals:

| Token Type | Format | Prefix/Pattern | Decodable? | Local Validation? |
|---|---|---|---|---|
| `access_token` | JWT (RS256) | `eyJ...` (3 dot-separated parts) | Yes (base64url decode) | Yes (JWKS at `auth0.openai.com`) |
| `refresh_token` | Opaque | `rt_...` | No | No (must call token endpoint) |
| `id_token` | JWT (RS256) | `eyJ...` (3 dot-separated parts) | Yes (base64url decode) | Yes (JWKS signature verification) |

**Access token JWT payload claims** include:
- `exp` — expiration (Unix timestamp, ~1 hour from issuance)
- `iss` — issuer (`https://auth0.openai.com/`)
- `"https://api.openai.com/auth"` namespace containing:
  - `chatgpt_account_id` (UUID)
  - `chatgpt_plan_type` (e.g., `"plus"`, `"pro"`, `"free"`, `"team"`)
  - `organization_id` (e.g., `"org-X3NlU8lBlWab7DoQCEdeK6g3"`)

**ID token** (`id_token`) is a standard OIDC JWT with claims parsed by Codex's `IdTokenInfo`:
```rust
struct IdClaims {
    email: Option<String>,
    chatgpt_plan_type: Option<PlanType>,  // Free, Go, Plus, Pro, Team, Business, Enterprise, Edu
    chatgpt_user_id: Option<String>,
    chatgpt_account_id: Option<String>,
}
```

**Refresh token** has `rt_` prefix followed by an opaque string. Lifetime is server-controlled. Token refresh interval in Codex is ~8 days.

**JWKS endpoint**: `https://auth0.openai.com/.well-known/jwks.json` (5 RSA public keys, all RS256)

**Validation strategy for SAM:**
- Store the **full auth.json content** (all three tokens + auth_mode) as a single encrypted credential blob
- Validate the JSON structure: must have `auth_mode: "Chatgpt"`, `tokens.access_token` (starts with `eyJ`), `tokens.refresh_token` (starts with `rt_`), `tokens.id_token` (starts with `eyJ`)
- Decode the `id_token` JWT to extract `chatgpt_plan_type` for display in the UI (show "Plus", "Pro", etc.)
- Optionally check `access_token` expiry via JWT `exp` claim and warn the user if expired
- Full signature verification against JWKS is possible but likely overkill for the MVP

### Q3: Does `codex-acp` support device code auth for headless environments?

**Answer: Yes, indirectly. But it's not useful for SAM's use case.**

The `codex-acp` `initialize()` method checks for the `NO_BROWSER` env var. When set, it removes the ChatGPT browser login option from the advertised auth methods. However, `codex-acp` does NOT directly expose device code auth in its ACP authenticate handler.

The Codex CLI itself supports `codex login --device-auth` which directs users to `https://auth.openai.com/codex/device` to enter a one-time code. But this is a CLI-interactive flow that requires user input during the login process.

**For SAM, device code auth is not the right approach** because:
1. It requires real-time user interaction during workspace startup (entering a code)
2. The workspace is already running in a container — the user can't easily interact with it during agent startup
3. The simpler approach is to have the user obtain their `auth.json` content once (locally) and paste it into SAM Settings

The recommended flow for SAM users is:
1. Run `codex login` on their local machine (browser-based OAuth)
2. Copy the contents of `~/.codex/auth.json`
3. Paste into SAM Settings as their OpenAI Codex OAuth credential
4. SAM encrypts and stores it, then writes it to `~/.codex/auth.json` inside the container at agent startup

---

## Implementation Plan (Updated)

### Phase 1: Core OAuth Token Support via auth.json Injection

The architecture is already 90% there for the API/DB/UI side. The main new work is the auth.json file injection in the VM agent.

#### 1.1 Update Agent Catalog (`packages/shared/src/agents.ts`)

Add `oauthSupport` to the OpenAI Codex agent definition:

```typescript
{
  id: 'openai-codex',
  // ... existing fields ...
  oauthSupport: {
    envVarName: 'CODEX_AUTH_JSON',  // SAM-internal identifier for the credential; not a real codex env var
    setupInstructions: 'Run "codex login" on your local machine and sign in with your ChatGPT account, then paste the contents of ~/.codex/auth.json',
    subscriptionUrl: 'https://openai.com/chatgpt/pricing/',
  },
}
```

Note: `envVarName` in the `oauthSupport` field is used by SAM internally to identify the credential. For OpenAI Codex, the actual injection will be via file write, not env var. The VM agent needs to handle this difference.

#### 1.2 Update VM Agent Credential Injection

**gateway.go — `getAgentCommandInfo()`:**

For OAuth tokens, we need a new injection strategy. The current `agentCommandInfo` struct only supports env var injection. We need to add a field or mechanism to signal "write to file instead of env var".

```go
case "openai-codex":
    if credentialKind == "oauth-token" {
        // Signal that this credential should be written to auth.json, not injected as env var.
        // Use a sentinel env var name that startAgent() recognizes as "file injection needed".
        return agentCommandInfo{"codex-acp", nil, "__CODEX_AUTH_JSON__", "npm install -g @zed-industries/codex-acp"}
    }
    return agentCommandInfo{"codex-acp", nil, "OPENAI_API_KEY", "npm install -g @zed-industries/codex-acp"}
```

**session_host.go — `startAgent()`:**

Add auth.json file injection before spawning the codex-acp process:

```go
// Before starting the agent process, check if we need to inject auth.json
if info.envVarName == "__CODEX_AUTH_JSON__" {
    // Write the credential (which is the full auth.json content) to ~/.codex/auth.json
    // inside the container
    codexHome := filepath.Join(homeDir, ".codex")
    if err := os.MkdirAll(codexHome, 0700); err != nil {
        return fmt.Errorf("failed to create .codex dir: %w", err)
    }
    authJsonPath := filepath.Join(codexHome, "auth.json")
    if err := os.WriteFile(authJsonPath, []byte(cred.apiKey), 0600); err != nil {
        return fmt.Errorf("failed to write auth.json: %w", err)
    }
    // Also set NO_BROWSER=1 to prevent codex-acp from trying to open a browser
    // Set cli_auth_credentials_store to "file" to ensure codex reads from auth.json
    env = append(env, "NO_BROWSER=1")
    // Don't inject the credential as an env var — it's already in auth.json
}
```

**Alternative approach — `agentCommandInfo` struct extension:**

Instead of the sentinel value hack, extend `agentCommandInfo` with a `credentialInjectionMode` field:

```go
type agentCommandInfo struct {
    command       string
    args          []string
    envVarName    string
    installCmd    string
    injectionMode string // "env" (default) or "auth-file"
    authFilePath  string // e.g., ".codex/auth.json" (relative to home)
}
```

This is cleaner and more extensible for future agents that may need file-based auth.

#### 1.3 Credential Storage — What Users Paste

Users will paste the **full contents of `~/.codex/auth.json`** into the SAM Settings OAuth token field. This is a JSON blob containing:

```json
{
  "auth_mode": "Chatgpt",
  "tokens": {
    "access_token": "...",
    "refresh_token": "...",
    "id_token": "...",
    "expires_at": "2026-12-31T23:59:59Z"
  },
  "last_refresh": "2026-01-15T10:30:00Z"
}
```

SAM encrypts this entire JSON blob as a single credential (same as how we handle other tokens — AES-GCM with per-credential IV).

#### 1.4 Credential Validation (`apps/api/src/services/validation.ts`)

Add validation for the OpenAI Codex OAuth credential:

```typescript
function validateOpenAICodexOAuthToken(credential: string): ValidationResult {
  try {
    const parsed = JSON.parse(credential);
    // Verify required structure
    if (!parsed.auth_mode || (parsed.auth_mode !== 'Chatgpt' && parsed.auth_mode !== 'chatgpt')) {
      return { valid: false, error: 'Invalid auth mode. Expected "Chatgpt".' };
    }
    if (!parsed.tokens?.access_token || !parsed.tokens.access_token.startsWith('eyJ')) {
      return { valid: false, error: 'Missing or invalid access_token. Must be a JWT (starts with eyJ).' };
    }
    if (!parsed.tokens?.refresh_token || !parsed.tokens.refresh_token.startsWith('rt_')) {
      return { valid: false, error: 'Missing or invalid refresh_token. Must start with rt_.' };
    }
    if (!parsed.tokens?.id_token || !parsed.tokens.id_token.startsWith('eyJ')) {
      return { valid: false, error: 'Missing or invalid id_token. Must be a JWT (starts with eyJ).' };
    }
    // Decode id_token to extract plan type for display
    const claims = decodeJwtPayload(parsed.tokens.id_token);
    const planType = claims?.['https://api.openai.com/auth']?.chatgpt_plan_type;
    // Optionally check access_token expiry
    const accessClaims = decodeJwtPayload(parsed.tokens.access_token);
    const isExpired = accessClaims?.exp && (accessClaims.exp * 1000) < Date.now();
    return {
      valid: true,
      metadata: { planType, isExpired },
    };
  } catch {
    return { valid: false, error: 'Invalid JSON. Paste the full contents of ~/.codex/auth.json' };
  }
}
```

#### 1.5 UI Considerations

The existing OAuth UI shows a text input for pasting a token. For OpenAI Codex, the credential is a multi-line JSON blob rather than a single token string. Consider:
- Use a `<textarea>` instead of `<input>` for the OpenAI Codex OAuth credential field
- Add a hint: "Paste the full contents of ~/.codex/auth.json"
- Optionally parse the `id_token` to show the user's ChatGPT plan type (Plus, Pro, etc.) as confirmation
- Show the `expires_at` date so users know when they need to refresh

#### 1.6 Add/Update Tests

- [ ] Unit test: `getAgentCommandInfo("openai-codex", "oauth-token")` returns correct injection mode
- [ ] Unit test: Agent catalog lookup for OpenAI Codex returns `oauthSupport` metadata
- [ ] Unit test: Credential validation accepts valid auth.json and rejects malformed input
- [ ] Integration test: Credential save/retrieve/toggle for OpenAI Codex OAuth tokens
- [ ] Integration test: VM agent writes auth.json to correct path with correct permissions
- [ ] UI test: Settings page shows OAuth toggle for OpenAI Codex agent with textarea input

### Phase 2: Token Refresh (Future Enhancement)

OpenAI OAuth access tokens expire in **~1 hour** (not days). The `auth.json` includes a `refresh_token` (prefixed `rt_`) which `codex-acp` will use automatically via `AuthManager` to refresh the access token during an active session. The refresh token interval in Codex is ~8 days. This means:

- **During active sessions**: Token refresh is handled automatically by `codex-acp`/`AuthManager`
- **Between sessions**: If the access token expired, `codex-acp` will use the refresh token at startup
- **Refresh token expiry**: Long-lived but eventually expires server-side. When it does, the user must re-authenticate

**Server-side refresh option** (nice-to-have for robustness):
- On each agent startup, SAM could decode the access token JWT and check the `exp` claim
- If expired, use the `refresh_token` to call `https://auth.openai.com/oauth/token` with:
  ```
  client_id=app_EMoamEEZ73f0CkXaXp7hrann
  grant_type=refresh_token
  refresh_token=<stored_refresh_token>
  ```
- Update the stored credential with fresh tokens before writing `auth.json`
- This would ensure the injected `auth.json` always has a fresh access token
- Note: `codex-acp` handles this itself via `AuthManager`, so this is belt-and-suspenders

### Phase 3: Codex App Server Integration (Alternative Architecture)

The Codex App Server (`codex app-server`) exposes a JSON-RPC 2.0 protocol with a `chatgptAuthTokens` auth mode specifically designed for host applications that manage OAuth tokens externally. This is how the VS Code Codex extension works.

**Protocol:**
1. Launch `codex app-server` instead of `codex-acp`
2. Inject tokens via JSON-RPC: `account/login/start` with `{ type: "chatgptAuthTokens", idToken, accessToken }`
3. Handle refresh callbacks: `account/chatgptAuthTokens/refresh` (server→client RPC, 10s timeout)
4. Tokens stored in memory only (never persisted)

**Pros**: More dynamic control, no file I/O, official protocol for IDE integrations
**Cons**: Requires switching from ACP (`codex-acp`) to JSON-RPC (`codex app-server`), different protocol entirely, more complex VM agent integration

**Verdict**: The auth.json approach (Phase 1) is much simpler and `codex-acp` handles refresh automatically. This is only worth pursuing if we need more granular control over the Codex session lifecycle.

### Phase 4: Browser-Based OAuth Flow (Future Enhancement)

Instead of users copying auth.json manually, SAM could implement the full OAuth flow:
1. User clicks "Sign in with OpenAI" in SAM Settings
2. SAM redirects to `https://auth.openai.com/oauth/authorize` with PKCE
3. User authenticates with OpenAI
4. Callback returns to SAM with auth code
5. SAM exchanges code for tokens and stores them

**Considerations**:
- Uses the same public client ID as the Codex CLI (`app_EMoamEEZ73f0CkXaXp7hrann`) — this is a public PKCE client, no secret needed
- PKCE flow can be done entirely client-side (SPA-friendly)
- Redirect URI would need to be `https://app.${BASE_DOMAIN}/auth/openai/callback`
- OpenAI may need to allowlist our redirect URI (or the public client may accept any localhost/HTTPS redirect)
- Would eliminate the manual auth.json copy step entirely
- Similar to how Cline implements "Sign in with OpenAI"

---

## Checklist

### Implementation (Phase 1)
- [x] Add `oauthSupport` to OpenAI Codex entry in `packages/shared/src/agents.ts`
- [x] Extend `agentCommandInfo` struct in `gateway.go` to support file-based credential injection
- [x] Update `getAgentCommandInfo()` in `packages/vm-agent/internal/acp/gateway.go` for `openai-codex` + `oauth-token`
- [x] Add auth.json file injection logic in `session_host.go` `startAgent()` — write credential to `~/.codex/auth.json` with `0600` permissions, set `NO_BROWSER=1`
- [x] Add credential validation in `apps/api/src/services/validation.ts` — validate auth.json structure
- [x] Update UI to use textarea for OpenAI Codex OAuth credential input (if current input is single-line)
- [x] Optionally decode `id_token` JWT to display ChatGPT plan type in Settings UI
- [x] Add unit tests for credential injection, validation, and agent catalog changes
- [ ] Add integration tests for end-to-end credential flow
- [x] Verify existing API key flow for OpenAI Codex continues to work unchanged
- [ ] Update CLAUDE.md agent authentication section if needed
- [ ] Test end-to-end: save auth.json → start workspace → select Codex → agent authenticates via auth.json

### Documentation
- [x] Update `docs/architecture/credential-security.md` with OpenAI OAuth details and auth.json injection pattern
- [x] Add user-facing instructions for obtaining auth.json from local Codex CLI (in oauthSupport.setupInstructions)

## Acceptance Criteria

- [ ] Users can save their OpenAI `auth.json` content in SAM Settings for the Codex agent
- [ ] Users can toggle between API key and OAuth token for OpenAI Codex
- [ ] OAuth credential is correctly written to `~/.codex/auth.json` in the container when Codex agent starts
- [ ] `codex-acp` successfully authenticates with OpenAI using the injected auth.json
- [ ] Settings UI shows subscription info and setup instructions for OpenAI OAuth
- [ ] Existing API key flow for OpenAI Codex continues to work unchanged
- [ ] All credential security guarantees maintained (encryption at rest, auth.json written with 0600 perms, cleaned up after agent stops)
- [ ] `NO_BROWSER=1` is set in the agent environment to prevent browser popup attempts

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| **auth.json injection** (not env var) | `codex-acp` has no OAuth env var; `auth.json` is the official headless mechanism |
| **Full auth.json blob** (not just access_token) | `codex-acp` needs `auth_mode`, `access_token`, `refresh_token`, and `id_token` for proper operation including auto-refresh |
| **`NO_BROWSER=1`** env var | Prevents `codex-acp` from trying to open a browser for ChatGPT login in the container |
| **JSON validation** (not prefix validation) | OpenAI tokens are opaque — no prefix like `sk-` — so we validate the JSON structure instead |
| **Textarea input** (not single-line) | auth.json is multi-line JSON; textarea provides better UX for pasting |

## References

- [OpenAI Codex Auth Documentation](https://developers.openai.com/codex/auth/)
- [OpenAI Codex Configuration Reference](https://developers.openai.com/codex/config-reference/)
- [codex-rs/core/src/auth.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/auth.rs) — Core auth with `AuthManager::load_auth()` priority order
- [codex-rs/core/src/token_data.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/token_data.rs) — Token data structures, JWT parsing
- [zed-industries/codex-acp](https://github.com/zed-industries/codex-acp) — ACP adapter source code
- [codex-acp src/codex_agent.rs](https://github.com/zed-industries/codex-acp/blob/main/src/codex_agent.rs) — `authenticate()` method (lines 149-192)
- [PR #10012: External auth mode](https://github.com/openai/codex/pull/10012) — `chatgptAuthTokens` protocol for app-server
- [Cline OpenAI Codex OAuth Integration](https://cline.bot/blog/introducing-openai-codex-oauth)
- [OpenCode Codex Auth Plugin](https://github.com/numman-ali/opencode-openai-codex-auth)
- [JetBrains Codex Integration](https://www.jetbrains.com/help/ai-assistant/ai-chat.html)
- [Issue #3820: Headless auth](https://github.com/openai/codex/issues/3820) — Device code flow request
- [Issue #5212: OPENAI_API_KEY without auth.json](https://github.com/openai/codex/issues/5212) — Env var limitations
- [Issue #9253: Headless login](https://github.com/openai/codex/issues/9253) — Container auth challenges
- [Discussion #4650: Docker auth](https://github.com/openai/codex/discussions/4650) — Headless workarounds

## Related Files

- `packages/shared/src/agents.ts` — Agent catalog (primary change)
- `packages/vm-agent/internal/acp/gateway.go` — Credential injection struct + function (primary change)
- `packages/vm-agent/internal/acp/session_host.go` — Agent startup with auth.json file write (primary change)
- `apps/api/src/routes/credentials.ts` — Credential API (likely no changes)
- `apps/api/src/services/validation.ts` — Credential validation (add auth.json validator)
- `apps/web/src/components/AgentKeysSection.tsx` — Settings UI (may need textarea for JSON input)
- `apps/web/src/components/AgentKeyCard.tsx` — Agent card UI (auto-picks up oauthSupport)
- `apps/api/src/db/schema.ts` — Database schema (no changes needed)
