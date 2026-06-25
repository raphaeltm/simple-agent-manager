# Re-architect deployment artifact loads away from undersized deadlines

## Problem

Deployment-node image artifact loading is bound to an undersized total HTTP client timeout. The deploy engine defaults to `&http.Client{Timeout: 30 * time.Second}`, and `ensureDeployEngine` does not override it, so downloading and copying an entire docker-save artifact body is killed after 30 seconds even when bytes are still flowing. A production `dexxy` apply failed with `write artifact frontend: context deadline exceeded`; reducing image size was only a band-aid.

## Proven Root Cause

- `packages/vm-agent/internal/deploy/engine.go` defaults `EngineConfig.HTTPClient` to a 30s total timeout.
- `packages/vm-agent/internal/server/server.go` builds `deploy.EngineConfig` without `HTTPClient`, so deployment artifacts inherit that timeout.
- `packages/vm-agent/internal/deploy/artifacts.go` streams the whole response body through `io.Copy`; an approximately 810 MB artifact needs more than 27 MB/s sustained to complete before the total timeout.
- `packages/vm-agent/internal/server/health.go` also detaches apply work with a fixed 10 minute wall-clock cap rather than a progress-aware watchdog.
- `packages/vm-agent/internal/server/mcp_build.go` has async publish jobs, but VM-side job state is in memory only.

## Implementation Checklist

- [ ] Add a dedicated artifact-download HTTP client with no total `Timeout`, using configurable dial, TLS handshake, and response-header timeouts.
- [ ] Add an idle/stall body-read watchdog that cancels artifact download only when no bytes have been read for the configured idle window.
- [ ] Wire the artifact client through `EngineConfig.HTTPClient` in `ensureDeployEngine`.
- [ ] Preserve size, SHA256, and signature verification behavior.
- [ ] Replace heartbeat apply's fixed 10 minute cap with a progress-based, env-configurable apply watchdog.
- [ ] Persist apply and publish job state/events in the VM agent SQLite store so status survives agent restart.
- [ ] Redact secrets from persisted events: signed R2 URLs, callback tokens, Authorization headers, JWTs, and secret values.
- [ ] Add regression tests for slow but progressing downloads, stalled downloads, multi-artifact apply, integrity enforcement, and job durability across restart.
- [ ] Add the required bug-fix process rule/checklist change for long-running VM work bound to request-scoped or undersized deadlines.
- [ ] Run quality gates: `pnpm lint`, `pnpm typecheck`, `go test ./...`, and VM agent build.
- [ ] Run specialist review: `go-specialist`, `cloudflare-specialist`, and `task-completion-validator`.
- [ ] Create PR with Post-Mortem section, wait for CI, merge, and monitor production deploy.

## Acceptance Criteria

- Slow, large artifact downloads complete as long as bytes continue to arrive before the idle window.
- Completely stalled artifact downloads are canceled by the idle watchdog.
- Exact byte count, SHA256, and signature verification remain enforced.
- Apply work is governed by progress, not an unconditional wall-clock cap.
- Publish and apply job status/events survive VM agent restart.
- Persisted events are bounded and redacted.
- PR includes post-mortem and a concrete process fix.
- Staging full e2e is explicitly exempted by human approval; document that VM-agent runtime verification would require fresh nodes per rule 27.

## References

- SAM idea `01KW0E6JT875K4XEJ1XA7NATH0`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `.claude/rules/43-long-running-mcp-tools.md`
