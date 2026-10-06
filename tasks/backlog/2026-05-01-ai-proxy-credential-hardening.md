# AI Proxy Credential Hardening

> **Reconciliation 2026-10-05:** #2224 (`4f223d6fa`) now injects the renewed callback token (`packages/vm-agent/internal/acp/session_host_startup.go:365,402`), but it is still the full callback token: no proxy-scoped token, BaseURL origin check, or sentinel guard on credential sync. A related gap is tracked only as SAM idea `01M432G3276YZWCP3HEJ5B25J5`: an agent process that is already running keeps the token it started with as its AI-proxy key (`session_host_callback_token.go:20-23`).

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** Go tests for the main proxy injection branches
>   (`packages/vm-agent/internal/acp/session_host_test.go:3113-3181` and
>   `gateway_test.go:1301-1338`).
> - **Still open:** Go files are under `packages/vm-agent/internal/acp/`.
>   - A short-lived token scoped to the AI proxy. The platform path still injects the full
>     callback token (`session_host_startup.go:324`) and puts it in the base URL (`:355-360`).
>   - Clear `credential` when `inferenceConfig` is set (`session_host_reporting.go:117-126`). The
>     API still sends `apiKey: '__platform_proxy__'`
>     (`apps/api/src/routes/workspaces/runtime.ts:1174`).
>   - Validate the `inferenceConfig.BaseURL` origin in the Go agent (there is no check).
>   - Reject `__platform_proxy__` in `POST /:id/agent-credential-sync` (`runtime.ts:1237`;
>     `apps/api/src/schemas/workspaces.ts:75-79` accepts any string).
>   - Go tests for the claude-code platform-proxy and codex passthrough branches.
> - **Moot/dropped:** the OpenCode proxy branch. PR #1431 removed platform OpenCode, and the Go
>   agent now rejects an OpenCode inference proxy (`session_host_test.go:3181`).

**Created**: 2026-05-01
**Source**: Security audit of WP3 (Codex Credential Injection Fallback)

## Problem Statement

The AI proxy credential fallback paths (claude-code, openai-codex, opencode) inject the full workspace callback token as the API key into agent containers. This token has a 24-hour lifetime and grants access to all workspace runtime endpoints, not just the AI proxy. Additionally, the `__platform_proxy__` sentinel string propagates through the credential field even when inferenceConfig is present.

These are pre-existing architectural patterns (not regressions from any single PR), but they represent defense-in-depth gaps that should be addressed.

## Research Findings

- Callback token TTL is 24h (jwt.ts), scoped to workspace — grants access to all runtime endpoints
- Claude Code path injects callback token as `ANTHROPIC_AUTH_TOKEN`
- Codex path injects callback token as `OPENAI_API_KEY`
- `__platform_proxy__` sentinel propagates to `agentCredential.credential` in Go agent
- Go agent does not validate `inferenceConfig.BaseURL` origin before injection
- No Go-side unit tests exist for any proxy injection branch in session_host.go

## Implementation Checklist

- [ ] Introduce short-lived, AI-proxy-scoped token variant (audience `workspace-ai-proxy`, TTL 1-2h)
- [ ] Inject proxy-scoped token instead of full callback token for all proxy paths
- [ ] In Go agent `fetchAgentKey`, clear `credential` field when `inferenceConfig != nil`
- [ ] Add origin validation for `inferenceConfig.BaseURL` in Go agent
- [ ] Add Go unit tests for all proxy injection branches (claude-code, openai-codex, opencode)
- [ ] Add credential-sync endpoint guard to reject `__platform_proxy__` payloads

## Acceptance Criteria

- [ ] Proxy-injected API keys cannot access non-proxy workspace endpoints
- [ ] `__platform_proxy__` sentinel never appears in auth files or credential-sync payloads
- [ ] `inferenceConfig.BaseURL` validated against control plane origin
- [ ] All proxy injection branches have Go-level test coverage
