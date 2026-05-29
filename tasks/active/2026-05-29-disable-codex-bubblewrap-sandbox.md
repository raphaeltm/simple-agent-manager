# Disable Codex Bubblewrap Sandbox

## Problem

Codex CLI v0.115+ uses bubblewrap during file verification. SAM workspace containers do not grant the capability needed for bubblewrap network namespaces, so Codex sessions can fail writes with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`, become unresponsive, and crash.

## Research Findings

- `packages/vm-agent/internal/acp/gateway.go` generates SAM-managed Codex `config.toml` content in `generateCodexMcpConfig()`.
- `writeCodexConfigToContainer()` merges the generated block into `.codex/config.toml`, preserving non-SAM user configuration and replacing the managed block on restart.
- Existing tests in `packages/vm-agent/internal/acp/gateway_test.go` cover generated Codex config, MCP token env vars, proxy provider config, and managed-block replacement.
- Postmortem review: PR #568 shows specialist review evidence must be tracked before merge; the env-var quote postmortem reinforces testing the real serialized config contract.

## Checklist

- [x] Add Codex sandbox and approval settings to the SAM-managed Codex config block before MCP server entries.
- [x] Update Codex config tests to assert the managed block includes `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`.
- [x] Run `go test ./...` from `packages/vm-agent`.
- [x] Run required specialist validation for VM-agent Go/config behavior.
- [ ] Open PR, wait for CI, and merge to `main` without staging deployment per task instruction.

## Acceptance Criteria

- SAM-managed Codex config includes `sandbox_mode = "danger-full-access"` and `approval_policy = "never"` whenever a managed Codex config block is written.
- Existing MCP server and proxy provider config generation behavior is preserved.
- `go test ./...` passes in `packages/vm-agent`.
- PR CI passes before merge.

## References

- `packages/vm-agent/internal/acp/gateway.go`
- `packages/vm-agent/internal/acp/session_host_startup.go`
- OpenAI guidance: run Codex with `--sandbox danger-full-access` inside containerized Linux environments.
