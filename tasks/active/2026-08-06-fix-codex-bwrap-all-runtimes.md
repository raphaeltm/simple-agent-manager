# Fix Codex Bubblewrap Across All Runtimes

## Problem

SAM-managed Codex sessions run inside an existing container security boundary, but Codex 0.115+ attempts a nested Linux bubblewrap sandbox. On current VM images, local reviewer/subagent commands fail at spawn with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. Instant/cf-container startup also historically skipped the managed Codex config, which removed both the sandbox override and SAM MCP token wiring.

## Research Findings

- The current official Codex manual says subagents inherit the parent sandbox policy and live runtime overrides, and recommends `danger-full-access` when the outer container is the intended boundary.
- Installed `@agentclientprotocol/codex-acp@1.1.2` launches `@openai/codex` app-server and reads wrapper configuration only from `CODEX_CONFIG`; it ignores arbitrary `-c` argv. It passes that JSON object into each app-server session/thread.
- The wrapper dependency is `@openai/codex@^0.144.0`; a fresh install resolved `0.144.6` on 2026-08-06, while a separately installed global Codex had already drifted to `0.146.1`.
- PR #1675 already moved Codex startup config ahead of the `containerID == ""` early return, but sandbox-only sessions still generated no managed block and tests did not assert the wrapper-only `CODEX_CONFIG` value.
- Both VM/devcontainer installs and the cf-container image must pin the same exact Codex CLI version.

## Implementation Checklist

- [x] Replace ignored codex-acp `-c` argv with exact `CODEX_CONFIG` sandbox and approval JSON in the startup environment.
- [x] Always generate and write the SAM-managed Codex sandbox block, even without MCP, proxy, or reasoning settings.
- [x] Keep standalone/cf-container config targeting active `CODEX_HOME` or local home.
- [x] Pin `@openai/codex@0.144.6` beside codex-acp in dynamic VM installs and the cf-container image.
- [x] Add discriminating real-startup-writer tests for VM/devcontainer and standalone/cf-container file plus exact env contracts.
- [x] Test missing SAM MCP token failure before launch for both runtime discriminators.
- [x] Extend rule 23 so wrapper-only launch config and runtime discriminators are mandatory contract assertions.
- [ ] Complete quality suite and mandatory specialist reviewer gates.
- [ ] Delete staging nodes, deploy branch, verify fresh VM subagent and Instant SAM MCP/config, then clean up.
- [ ] Open PR, pass CI, merge, and monitor production deployment.

## Acceptance Criteria

- Main Codex agents and spawned local subagents never invoke bwrap in SAM-managed containers.
- VM/devcontainer and standalone/cf-container startup write sandbox and approval controls and inject exact `CODEX_CONFIG` plus exact MCP token env values.
- Missing required MCP bearer tokens fail closed before the agent process starts.
- Fresh installs resolve codex-acp 1.1.2 with exactly Codex 0.144.6.
- The stale May 2026 task is archived.
- Local reviewer, staging VM, Instant, CI, cleanup, merge, and deploy gates complete successfully.

## Post-Mortem

### What broke

Codex local reviewers could not execute any command on fresh VM workspaces; every spawn exited with the bwrap loopback RTM_NEWADDR error. Instant sessions also previously lacked SAM MCP startup config and `SAM_MCP_TOKEN`.

### Root cause

The May mitigation assumed codex-acp forwarded Codex CLI `-c` arguments, but wrapper 1.1.2 ignores them. Generated TOML was conditional, and startup config previously sat behind a container-only early return. A floating transitive Codex dependency silently changed the runtime under those assumptions.

### Timeline

Codex 0.115 moved Linux sandboxing to bwrap. PRs #1153/#1157 added main-process mitigations in May 2026. PR #1675 fixed standalone config writing in July 2026. Fresh VM reproduction on 2026-08-06 proved reviewer/subagent execution still used bwrap.

### Why It Was Not Caught

Tests asserted pure TOML generation and main launch args, not the wrapper-specific environment object passed into app-server threads. Runtime tests did not jointly assert the config file and sibling environment values for every container discriminator, and the effective transitive CLI version was not pinned.

### Class of Bug

Generated startup configuration crossed file, environment, wrapper, and runtime boundaries without one production-shaped contract test, while dependency drift changed the downstream consumer behavior.

### Process Fix

Rule 23 now requires exact wrapper-only launch configuration assertions on every runtime path and a discriminating empty-container regression test, in addition to config-file and secret environment checks.

## References

- `packages/vm-agent/internal/acp/gateway.go`
- `packages/vm-agent/internal/acp/session_host_startup.go`
- `packages/vm-agent/internal/acp/gateway_test.go`
- `apps/api/Dockerfile.vm-agent-container`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- Official Codex manual sections: Subagents; Sandbox and approvals
- PRs #1153, #1157, #1675; PR #1709 recovery evidence; SAM task 01KZAGGBDE77XENJPCGTQ4MBK6
