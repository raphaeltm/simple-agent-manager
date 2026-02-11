# Feature Specification: Agent OAuth & Subscription Authentication

**Feature Branch**: `013-agent-oauth-support`
**Created**: 2026-02-09
**Status**: Draft
**Input**: User description: "Add OAuth and subscription-based authentication support for all AI coding agents, enabling users to connect with their paid plans (Claude Max, ChatGPT Plus/Pro, Google AI Premium) instead of requiring separate API keys."

## Context

SAM currently requires users to provide a pay-per-use API key for each AI coding agent. This is the only authentication method supported. However, all three supported agents also offer subscription-based plans that include CLI/agent usage:

- **Claude Code**: Pro and Max subscribers can authenticate via OAuth tokens (generated with `claude setup-token` or `claude login`), using `CLAUDE_CODE_OAUTH_TOKEN` instead of `ANTHROPIC_API_KEY`
- **OpenAI Codex CLI**: ChatGPT Plus/Pro/Team subscribers can authenticate via OAuth (PKCE flow or device code auth), sharing their subscription quota
- **Google Gemini CLI**: Users with Google accounts can authenticate via Google OAuth ("Login with Google"), and Gemini Code Assist license holders can use Vertex AI authentication

Users with paid subscriptions are currently unable to use their existing plans with SAM. They must purchase separate API credits even though their subscription already includes agent usage. This creates friction, unnecessary cost, and a confusing experience — especially when users expect `claude setup-token` style credentials to "just work."

This feature extends the credential system to support OAuth/subscription tokens alongside API keys. **Version 1 targets Claude Code only**, since it supports a clean env-var-based OAuth injection (`CLAUDE_CODE_OAUTH_TOKEN` via `docker exec -e`). Codex and Gemini use file-based credential storage for OAuth, which requires a different container injection approach and is deferred to a future iteration. The architecture is designed to be extensible to additional agents when their OAuth injection methods are supported.

## Clarifications

### Session 2026-02-09

- Q: When a user has both credential types saved for one agent, should switching be a one-click toggle (both stored simultaneously) or a replace flow (one overwrites the other)? → A: Both stored simultaneously — user toggles which is active. Two credential rows per agent are allowed.
- Q: For Codex and Gemini OAuth, should we use env vars, file-based injection, or scope to Claude-only for v1? → A: Claude-only for v1. Codex and Gemini use file-based credential storage (not env vars) for OAuth, which requires a different injection approach. Defer to a future iteration.
- Q: When a user saves a new credential type (e.g., adds OAuth when API key exists), should it auto-activate or require explicit activation? → A: Auto-activate the newly saved credential. Users saving an OAuth token are doing so to use it immediately. Easy switching remains available in Settings.

## User Scenarios & Testing

### User Story 1 — Connect Claude Code with a Max/Pro Subscription (Priority: P1)

A Claude Max or Pro subscriber wants to use their existing subscription with SAM instead of paying for separate API credits. They generate an OAuth token using `claude setup-token` (or copy it from their local Claude Code setup), paste it into SAM's Settings page, and use Claude Code in their workspace — with usage counting against their subscription quota.

**Why this priority**: This is the triggering use case. Claude Max/Pro users are the most likely early adopters of SAM, and the inability to use their subscription is the #1 reported friction point.

**Independent Test**: A user can paste a Claude OAuth token in Settings, open a workspace, select Claude Code, and successfully send a prompt that executes against their subscription.

**Acceptance Scenarios**:

1. **Given** a user on the Settings page viewing the Claude Code agent card, **When** they see the authentication options, **Then** they can choose between "API Key" and "OAuth Token (Pro/Max subscription)"
2. **Given** a user selects "OAuth Token", **When** they paste a token from `claude setup-token`, **Then** the token is saved and the card shows "Connected (Pro/Max)"
3. **Given** a user has saved a Claude OAuth token, **When** they open a workspace and select Claude Code, **Then** the agent starts successfully using the subscription token
4. **Given** a user has saved a Claude OAuth token, **When** the token is passed to the workspace, **Then** it is injected as `CLAUDE_CODE_OAUTH_TOKEN` (not `ANTHROPIC_API_KEY`) so the agent uses subscription auth
5. **Given** a user has both an API key and OAuth token saved for Claude Code, **When** they open the Settings page, **Then** they see which credential type is active and can switch between them

---

### User Story 2 — Credential Type Switching and Management (Priority: P2)

A user who has configured both an API key and an OAuth token for the same agent wants to switch between them — for example, switching from their subscription to API credits when they've hit their subscription quota limit.

**Why this priority**: This is a power-user scenario that adds flexibility but isn't required for basic functionality.

**Independent Test**: A user can save both credential types for one agent, switch the active type, and verify the workspace uses the newly selected credential.

**Acceptance Scenarios**:

1. **Given** a user has both an API key and OAuth token for Claude Code, **When** they view the agent card in Settings, **Then** they see both credentials with a clear indicator of which is active
2. **Given** a user switches from OAuth to API key for an agent, **When** they next open a workspace, **Then** the API key is used instead of the OAuth token
3. **Given** a user removes their OAuth token but still has an API key, **When** they view the agent card, **Then** the API key automatically becomes the active credential

---

### Edge Cases

- **OAuth token expires mid-session**: The agent process crashes, the VM Agent detects the rapid exit, and the user sees a clear error: "Your subscription token has expired — re-authenticate in Settings." The workspace remains usable via terminal fallback.
- **User pastes an API key in the OAuth field (or vice versa)**: The system should detect obvious mismatches where possible (e.g., Anthropic API key prefixes like `sk-ant-api...` in OAuth mode, or Claude OAuth prefixes like `sk-ant-oat...` in API-key mode) and warn the user. If format detection isn't conclusive, the error surfaces at agent startup with a helpful message.
- **Subscription plan downgraded**: The token may become invalid. Same handling as token expiry — clear error message with re-authentication guidance.
- **Multiple credential types saved, none marked active**: The system must always have exactly one active credential per agent. The most recently saved credential automatically becomes active. When saving a new credential type, it auto-activates (e.g., adding OAuth when API key exists makes OAuth active immediately).
- **Token contains sensitive scopes beyond what's needed**: The platform stores only the token string — it does not inspect or validate OAuth scopes. Scope validation happens at the agent/provider level.

## Requirements

### Functional Requirements

- **FR-001**: System MUST support two authentication methods for Claude Code: API key (existing) and OAuth/subscription token (new). The architecture MUST be extensible to support additional agents in future iterations.
- **FR-002**: System MUST allow users to choose their preferred authentication method per agent from the Settings UI
- **FR-003**: System MUST store OAuth/subscription tokens with the same encryption model as API keys (AES-256-GCM, per-user)
- **FR-004**: System MUST differentiate between credential types in the database (e.g., `api-key` vs `oauth-token`)
- **FR-005**: System MUST pass Claude Code OAuth tokens using the `CLAUDE_CODE_OAUTH_TOKEN` environment variable (injected into the devcontainer via `docker exec -e` by the VM Agent)
- **FR-006**: System MUST allow only one active credential per agent type per user at any time
- **FR-007**: System MUST display the active credential type in the Settings UI (e.g., "Connected via API Key" vs "Connected via Pro/Max Subscription")
- **FR-008**: System MUST allow users to switch the active credential type without removing the inactive credential
- **FR-009**: System MUST display agent-specific guidance for obtaining OAuth tokens (e.g., "Run `claude setup-token` in your terminal" for Claude Code)
- **FR-010**: System MUST detect and display credential-type-specific error messages when agent startup fails (e.g., "OAuth token expired" vs "API key invalid")
- **FR-011**: System MUST surface the credential type to the VM Agent so it can inject the correct environment variable
- **FR-012**: The VM Agent MUST use the credential type to determine which environment variable to set when starting the agent process
- **FR-013**: System MUST mask OAuth tokens in the UI using the same pattern as API keys (last 4 characters visible)
- **FR-014**: When a new credential is saved, it MUST automatically become the active credential for that agent (newly saved credentials auto-activate)

### Key Entities

- **Agent Credential**: Extended to include a `credentialKind` field (`api-key` or `oauth-token`) alongside the existing `credentialType` (`agent-api-key`). Up to two credentials may exist per agent per user (one of each kind), with an `isActive` flag indicating which is currently in use. Only one credential per agent may be active at a time.
- **Agent Definition**: Extended with OAuth-specific metadata: supported auth methods, OAuth environment variable name, OAuth help text/instructions.
- **Active Credential Selection**: A user's choice of which credential type to use for a given agent. Persisted so it survives across sessions.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Users with Claude Max/Pro subscriptions can authenticate and use Claude Code in a workspace within 2 minutes of entering Settings
- **SC-002**: 90% of users who attempt OAuth setup complete it successfully on their first try
- **SC-003**: Agent startup with OAuth tokens succeeds within the same time bounds as API key auth (under 10 seconds)
- **SC-004**: When an OAuth token is invalid or expired, the user sees a specific, actionable error message within 5 seconds of the failure
- **SC-005**: Zero credential information (API keys or OAuth tokens) appears in plaintext in logs, network responses, or the UI beyond the masked last-4-character display
- **SC-006**: Users can switch between API key and OAuth authentication for an agent within 3 interactions in the Settings UI

## Assumptions

- **Token format is opaque**: The platform treats OAuth tokens as opaque strings. It does not validate, decode, or refresh them. Token lifecycle management is the responsibility of the user and the agent binary.
- **No browser-based OAuth flows**: This version uses a "paste your token" approach for all providers. Interactive browser-based OAuth flows (redirect-based) are a future enhancement. Users generate tokens using their agent's CLI tool (e.g., `claude setup-token`, `codex login --device-auth`) and paste them into SAM.
- **One active credential per agent**: Users cannot use both an API key and OAuth token simultaneously for the same agent. They choose one.
- **Claude Code handles OAuth natively**: The `claude-code-acp` binary authenticates via `CLAUDE_CODE_OAUTH_TOKEN` when set as an environment variable. SAM only needs to inject the correct variable via `docker exec -e` into the devcontainer.
- **Existing API key flow unchanged**: The current API key authentication path continues to work exactly as it does today. OAuth is an additional option, not a replacement.
- **Token persistence in container not needed**: For Claude Code, tokens are injected as environment variables at process start via `docker exec -e`. They do not need to be written to files inside the container (e.g., `~/.claude/credentials`). This env-var injection model is why Codex/Gemini OAuth is deferred — they require file-based credential injection.

## Out of Scope

- OAuth support for OpenAI Codex and Google Gemini CLI (they use file-based credential storage, not env vars — requires different container injection approach; deferred to future iteration)
- Interactive browser-based OAuth flows (redirect callbacks, PKCE flow hosted by SAM)
- Token refresh automation (automatically refreshing expired tokens server-side)
- OAuth scope inspection or validation
- Provider-specific subscription tier detection or display (e.g., showing "Max" vs "Pro" tier)
- Per-workspace credential overrides (credentials remain user-global)
- Credential sharing between users
- Token rotation policies or expiration warnings before token becomes invalid
