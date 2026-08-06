# Isolate standalone agent process environments

## Context

`startLocalProcess` currently constructs the child process environment with `append(os.Environ(), cfg.EnvVars...)`. As a result, every standalone agent process inherits all ambient `vm-agent` environment variables in addition to its configured variables.

A security review flagged this as a risk now that the outer container is the intended security boundary. This behavior is pre-existing and was not introduced by the Codex bwrap diff.

## Risk

Ambient inheritance may expose credentials, platform configuration, internal endpoints, or other host-level values to standalone agent processes that do not require them. It also makes each runtime's effective environment dependent on how `vm-agent` was launched, complicates auditing, and permits duplicate keys whose resolution can vary by consumer or ordering.

## Scope

Design and implement a separate, all-agent environment-isolation change:

- Inventory the ambient variables required by every standalone agent and runtime.
- Replace wholesale `os.Environ()` inheritance with an explicit allowlist of required ambient variables plus the assembled `cfg.EnvVars`.
- Canonicalize duplicate environment keys so each key has one deterministic final value, with clearly defined precedence.
- Add child-process tests that place a canary secret in the parent environment and prove it is unavailable to standalone child processes unless explicitly allowed or configured.
- Verify the behavior in staging using an Instant workspace, covering the supported standalone agents and runtimes.

This task must address the shared standalone process design rather than applying a Codex-only exception.

## Acceptance criteria

- The required ambient environment variables are documented for every supported standalone agent/runtime.
- Standalone child processes no longer inherit the complete ambient `vm-agent` environment.
- The child environment consists only of explicitly allowlisted ambient variables and assembled `cfg.EnvVars`.
- Duplicate keys are canonicalized with deterministic, tested precedence.
- Automated child-process tests demonstrate that a parent-only canary secret is not visible in the child.
- Tests cover explicitly allowlisted and explicitly configured variables to prevent required runtime behavior from regressing.
- Staging Instant verification confirms supported standalone agents/runtimes start and operate correctly with the isolated environment.
- The implementation and review notes explicitly preserve the finding's provenance: the ambient-inheritance behavior was pre-existing and was not introduced by the Codex bwrap diff.

## References

- `packages/vm-agent/internal/acp/process.go`
- `packages/vm-agent/internal/acp/session_host_startup.go`
