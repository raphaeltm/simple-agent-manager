# Binary Install Security Hardening

**Created**: 2026-03-13
**Source**: Security audit of Mistral Vibe integration (PR #361)

## Problem

The `vibe-acp` binary (and potentially future non-npm agents) is downloaded from GitHub Releases via `curl` without checksum verification, version pinning, or architecture allowlist validation. While the binary runs inside an isolated devcontainer (not the host), this is a supply chain risk.

Additionally, agent stderr is forwarded to the observability system without credential scrubbing — a pre-existing issue affecting ALL agents, not just Mistral Vibe.

## Key Findings from Security Audit

1. **No checksum verification**: Binary downloaded and executed without SHA-256 check
2. **`releases/latest` is mutable**: A compromised GitHub account could replace the binary
3. **`uname -m` interpolated into shell string**: Should validate against `["x86_64", "aarch64"]` allowlist in Go before constructing URL
4. **Stderr forwarded unscrubbed**: Agent crash stderr (which may contain API keys) sent to ErrorReporter verbatim — affects all agents
5. **No ELF validity check**: Wrong-platform binary could be placed and treated as installed

## Checklist

- [ ] Pin `vibe-acp` download to a specific version tag instead of `releases/latest`
- [ ] Add SHA-256 checksum verification after download, before `chmod +x`
- [ ] Validate `uname -m` output against allowlist in Go `getAgentCommandInfo()` before URL construction
- [ ] Add credential scrubbing to `reportAgentError` stderr forwarding (all agents)
- [ ] Add post-download ELF magic byte check for non-npm installs
- [x] Replace dead TS `installCommand` with a structured pinned manifest and CI synchronization across the catalog, Go runtime, and cf-container image (2026-07-11 unified-agent-installation task)

## Acceptance Criteria

- [ ] Binary install cannot succeed without checksum validation
- [ ] Unsupported architectures produce a clear error, not a silent wrong-binary install
- [ ] API keys never appear in observability logs even on agent crash
- [ ] Changes apply to all agents, not just Mistral Vibe

## References

- Security audit output: `/tmp/claude-1000/-workspaces-simple-agent-manager/tasks/ac81a81d00ce092a6.output`
- Install command: `packages/shared/src/agents.ts:111`, `packages/vm-agent/internal/acp/gateway.go:635`
- Stderr forwarding: `packages/vm-agent/internal/acp/session_host.go:1100-1104`
