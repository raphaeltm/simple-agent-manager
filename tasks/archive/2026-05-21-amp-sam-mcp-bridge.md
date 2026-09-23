# Amp SAM MCP Bridge

## Problem

Amp is present in the SAM agent catalog and can install/start through `acp-amp`, but the current MCP path is not complete. SAM sends its MCP server to ACP as an HTTP MCP entry. The installed `acp-amp==0.1.3` bridge advertises HTTP/SSE capabilities but only translates MCP entries that have a stdio `command`, so SAM's HTTP `sam-mcp` entry is silently dropped before Amp starts.

Direct project-chat Amp sessions also need SAM MCP configuration before ACP `NewSession` starts. Without that, even a fixed Amp MCP transport cannot prove the required product behavior: Amp must call a SAM MCP tool during a project-chat session and use the result in its response.

## Research Findings

- Local experiment on 2026-05-21 verified `AMP_API_KEY` is present, valid, and has usable credits.
- Local temp install used the same runtime shape as SAM's VM path: `acp-amp==0.1.3` plus `@sourcegraph/amp`.
- `amp mcp doctor` with `@modelcontextprotocol/server-everything` connected over stdio and discovered 13 tools.
- A live Amp `--stream-json` run invoked `mcp__everything__echo` and returned `Echo: sam-amp-mcp-proof-63255a88`.
- Installed `acp-amp==0.1.3` source at `acp_amp/mapping/to_amp.py` confirms `mcp_servers_to_amp_config()` only copies servers with `name` and `command`; HTTP/SSE entries are skipped.
- `mcp-remote@0.1.38` bridges stdio-only clients to remote MCP servers and supports custom headers.
- Local bridge proof used `npx -y mcp-remote@0.1.38 ${SAM_API_URL}/mcp --header "Authorization:Bearer ${SAM_MCP_TOKEN}" --silent`.
- `amp mcp doctor` through `mcp-remote` connected to this session's SAM MCP endpoint and discovered 84 SAM tools.
- A live Amp `--stream-json` run through `mcp-remote` called `mcp__sam_mcp__get_instructions` exactly once and used the returned task title in its response.
- Existing direct project-chat MCP wiring task notes identify these relevant paths:
  - `apps/api/src/routes/workspaces/agent-sessions.ts`
  - `apps/api/src/services/node-agent.ts`
  - `apps/api/src/durable-objects/task-runner/agent-session-step.ts`
  - `apps/api/src/services/mcp-token.ts`
  - `packages/vm-agent/internal/server/workspaces.go`
  - `packages/vm-agent/internal/server/agent_ws.go`
  - `packages/vm-agent/internal/acp/session_host_handshake.go`
  - `packages/vm-agent/internal/acp/mcp_servers_test.go`
- Relevant postmortems reviewed:
  - `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md`: MCP token lifetime must match ACP session lifetime.
  - `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`: use canonical chat-scoped session identity, not workspace-scoped heuristics.
  - `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`: component contracts are insufficient without full end-to-end verification.

## Implementation Checklist

- [x] Move this task file from `tasks/backlog/` to `tasks/active/` in the feature worktree.
- [x] Add an Amp-specific MCP conversion path that turns SAM's remote MCP entry into a stdio MCP entry using `npx -y mcp-remote@0.1.38`.
- [x] Ensure the SAM MCP token is passed to `mcp-remote` through an environment variable, not embedded directly in command-line arguments or logs.
- [x] Keep raw HTTP MCP entries for agents that support HTTP MCP directly.
- [x] Add VM agent tests proving Amp receives a stdio `sam-mcp` ACP entry while non-Amp agents continue receiving HTTP MCP entries.
- [x] Wire direct project-chat agent session creation so it mints a scoped SAM MCP token and sends MCP server config to the VM before ACP startup.
- [x] Ensure the direct project-chat MCP token is scoped to the correct user, project, workspace, chat session, and agent session.
- [x] Extend VM agent create-session handling, if needed, so MCP config sent during session creation is validated, persisted, and available before WebSocket `select_agent` triggers ACP `NewSession`.
- [x] Add API/control-plane vertical slice coverage proving direct project-chat creation sends MCP config to the VM with realistic user/project/workspace/session state.
- [x] Add or update VM agent coverage proving create-session MCP config persists and reaches ACP `NewSession`.
- [x] Update docs describing Amp MCP behavior and the `mcp-remote` bridge dependency.
- [x] Run focused API and VM tests for changed paths.
- [x] Run full required quality gates before PR.
- [x] Complete required specialist reviews: task-completion-validator, go-specialist, cloudflare-specialist, security-auditor, constitution-validator, test-engineer, doc-sync-validator, and env-validator if env handling changes.
- [x] Deploy the PR branch to staging through the normal `deploy-staging.yml` GitHub Actions workflow.
- [ ] Verify staging with a fresh workspace/node and a valid Amp credential.
- [ ] Collect evidence that Amp called at least one SAM MCP tool, ideally `get_instructions`, during a real project-chat session and used the result in its response.

## Acceptance Criteria

- Amp project-chat sessions receive SAM MCP configuration before ACP `NewSession`.
- Amp gets `sam-mcp` as a stdio MCP server using `mcp-remote`, not as an HTTP ACP MCP entry that `acp-amp` drops.
- The bridge command uses a pinned `mcp-remote` version.
- The SAM MCP bearer token is not printed, persisted in logs, or embedded directly in command-line arguments.
- Non-Amp agents keep their existing MCP behavior.
- Automated tests prove both the Amp-specific VM ACP MCP formatting and the direct project-chat control-plane wiring.
- Token metadata preserves user, project, workspace, chat session, and agent session boundaries.
- Staging evidence shows Amp installing/starting, seeing SAM MCP tools, calling at least one SAM MCP tool, and using the tool result in a project-chat response.
- No missing credential, missing credits, missing CLI, missing npm, or token-auth failures occur during staging verification.

## References

- `tasks/backlog/2026-05-20-amp-project-chat-mcp-wiring.md`
- `tasks/active/2026-05-19-amp-acp-integration.md`
- `packages/vm-agent/internal/acp/gateway.go`
- `packages/vm-agent/internal/acp/session_host_handshake.go`
- `packages/vm-agent/internal/acp/mcp_servers_test.go`
- `packages/vm-agent/internal/server/workspaces.go`
- `apps/api/src/routes/workspaces/agent-sessions.ts`
- `apps/api/src/services/node-agent.ts`
- `apps/api/src/services/mcp-token.ts`
- `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md`
- `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`
- `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`
