# AI Proxy Credential Hardening

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
