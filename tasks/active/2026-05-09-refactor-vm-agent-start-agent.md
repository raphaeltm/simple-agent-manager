# Refactor VM Agent Agent Startup

## Problem

The uploaded oversized-functions audit identified `packages/vm-agent/internal/acp/session_host.go:startAgent` as a 447-line lifecycle function that mixes container discovery, SAM environment resolution, credential injection, agent config file writes, process startup, and ACP session negotiation.

This is valid technical debt. The function sits on a high-risk runtime boundary where credential handling and agent lifecycle behavior must remain easy to audit.

## Research Findings

- `SessionHost.startAgent` currently owns credential injection metadata used later by `SessionHost.Stop` and `syncCredentialOnStop`.
- Credential and model environment behavior varies by agent type: Claude Code, OpenAI Codex, OpenCode, and Mistral Vibe.
- Relevant postmortems emphasize runtime-boundary verification:
  - `docs/notes/2026-05-09-mcp-retry-active-agent-stop-postmortem.md`
  - `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`
- Existing tests cover agent command metadata and sync-on-stop metadata, but not the extracted startup environment preparation as a unit.

## Implementation Checklist

- [x] Extract startup environment preparation from `startAgent` into named helpers.
- [x] Extract agent-specific config file/env handling from `startAgent`.
- [x] Keep `startAgent` as a readable coordinator without changing runtime behavior.
- [x] Add focused Go tests for credential injection/env preparation branches.
- [x] Run VM agent tests and repository quality checks that are practical in this workspace.
- [ ] Deploy branch to staging via `deploy-staging.yml`.
- [ ] Perform real staging verification with a multi-message agent conversation that uses MCP tools and pushes to a repo.

## Acceptance Criteria

- `startAgent` is materially shorter and reads as a lifecycle coordinator.
- Credential injection behavior remains covered for env var, auth-file, callback-token proxy, and user-credential proxy cases.
- No credential values are logged or persisted in new places.
- Staging deployment succeeds through the normal GitHub Actions pipeline.
- Staging verification exercises live agent/tool/repo-push behavior, not just page loading.

## Validation Notes

- `go test ./internal/acp` passes.
- `go test ./...` passes in `packages/vm-agent`.
- `pnpm lint` passes with existing warnings only.
- `pnpm typecheck` passes.
- `pnpm test` passes.
- `pnpm build` passes.
