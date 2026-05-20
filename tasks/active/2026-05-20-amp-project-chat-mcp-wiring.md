# Amp Project Chat MCP Wiring

## Problem

Amp direct project-chat sessions must receive SAM MCP configuration before ACP `NewSession` starts. Prior staging evidence only proved Amp can install/start and reach the ACP lifecycle; it did not prove Amp called SAM MCP tools during a direct project-chat run. The integration is not complete until staging evidence shows Amp using at least one SAM MCP tool and using the result in its chat response.

This task is being handled through the `/do` workflow.

## Research Findings

- `apps/api/src/routes/workspaces/agent-sessions.ts` creates direct project-chat agent sessions and calls `createAgentSessionOnNode(...)` with only `sessionId`, `label`, `chatSessionId`, and `projectId`.
- `apps/api/src/services/node-agent.ts` supports sending MCP server config only through `startAgentSessionOnNode(...)`, which task-driven agents call, but direct project-chat sessions do not.
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts` mints an MCP token with `generateMcpToken()` / `storeMcpToken()`, uses `https://api.${BASE_DOMAIN}/mcp`, and passes it to `startAgentSessionOnNode(...)`.
- `packages/vm-agent/internal/server/workspaces.go` validates and persists `mcpServers` only in `handleStartAgentSession(...)`; `handleCreateAgentSession(...)` currently does not accept MCP config.
- `packages/vm-agent/internal/server/agent_ws.go` creates the ACP `SessionHost` on WebSocket attach and reads MCP config from `sessionMcpServers` or persisted SQLite before `SelectAgent` can call ACP `NewSession`.
- `packages/vm-agent/internal/acp/session_host_handshake.go` passes `buildAcpMcpServers(h.config.McpServers)` into both `LoadSession` and `NewSession`.
- `packages/vm-agent/internal/acp/mcp_servers_test.go` already covers ACP wire formatting for `sam-mcp` once config reaches the host.
- Relevant postmortems:
  - `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`: component-level contracts are insufficient unless the full user-to-agent path is verified.
  - `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md`: MCP token lifetime must match ACP session lifetime.
  - `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`: live chat state must use the canonical chat-scoped session identity, not workspace-level heuristics.

## Implementation Checklist

- [ ] Re-read `.do-state.md` before each phase transition and keep it current.
- [ ] Create a dedicated worktree for `sam/use-command-workflow-handle-01ks2x`.
- [ ] Move this task file from `tasks/backlog/` to `tasks/active/` in the worktree.
- [x] Add API/control-plane wiring so direct project-chat session creation mints a SAM MCP token and sends `https://api.<BASE_DOMAIN>/mcp` plus the token to the VM before ACP startup.
- [x] Ensure the direct project-chat MCP token is scoped to the correct user, project, workspace, chat session, and agent session, and does not leak in logs.
- [x] Extend VM agent create-session handling, if needed, so MCP config sent during session creation is validated, persisted, and available before WebSocket `select_agent` triggers ACP `NewSession`.
- [x] Add focused API/control-plane coverage proving direct project-chat session creation supplies SAM MCP config.
- [x] Add VM agent coverage proving create-session MCP config is persisted and later injected into the ACP host before `NewSession`, if the VM create endpoint changes.
- [x] Run focused tests for the modified API and VM paths.
- [ ] Run required quality gates before PR.
- [ ] Complete required specialist reviews: task-completion-validator, cloudflare-specialist, security-auditor, constitution-validator, test-engineer, and go-specialist if VM Go changes are made.
- [ ] Deploy the PR branch to staging via `gh workflow run deploy-staging.yml --ref sam/use-command-workflow-handle-01ks2x`.
- [ ] Verify staging on a fresh workspace/node with the primary staging smoke-test user and valid Amp credential.
- [ ] Collect PR evidence: staging deploy URL, timestamp, user/project/workspace/node/agent-session/chat-session IDs, summarized D1 state, debug-package log excerpts, and explicit SAM MCP tool-call evidence with no secret values.
- [ ] Merge only if `/do`, CI, staging, credential, and project policies all allow it.

## Acceptance Criteria

- Direct project-chat agent session creation provides a valid SAM MCP server config before ACP startup.
- The MCP URL is `https://api.<BASE_DOMAIN>/mcp`.
- MCP token metadata preserves security boundaries for user, project, workspace, chat session, and agent session.
- Tokens are not printed in application or VM logs.
- Automated tests prove the direct project-chat wiring path and any VM persistence/injection changes.
- Staging deploy for the PR branch passes through the normal GitHub Actions pipeline.
- Staging verification uses a fresh workspace/node and the primary smoke-test user with the active Amp credential.
- Amp installs and starts with `acp-amp` and `@sourcegraph/amp` present.
- `AMP_API_KEY` is injected without printing the secret.
- ACP `NewSession` includes a `sam-mcp` MCP server config.
- Logs, telemetry, or chat events prove Amp called at least one SAM MCP tool.
- The MCP tool result influences Amp's project-chat response, which references real repo/project facts.
- The session reaches a sane terminal state and is not left stuck `running`.
- No Amp API 401/403, missing credits, missing CLI, missing npm, or missing key errors occur.
- If staging fails, the PR classifies the failure as platform bug, external credential/credits issue, or infrastructure bug and does not merge unless policy permits.

## References

- `apps/api/src/routes/workspaces/agent-sessions.ts`
- `apps/api/src/services/node-agent.ts`
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts`
- `apps/api/src/services/mcp-token.ts`
- `packages/vm-agent/internal/server/workspaces.go`
- `packages/vm-agent/internal/server/agent_ws.go`
- `packages/vm-agent/internal/acp/session_host.go`
- `packages/vm-agent/internal/acp/session_host_handshake.go`
- `packages/vm-agent/internal/acp/session_host_startup.go`
- `packages/vm-agent/internal/acp/mcp_servers_test.go`
- `tests/smoke/amp-agent.spec.ts`
