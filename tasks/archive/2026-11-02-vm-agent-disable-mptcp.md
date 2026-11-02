# Disable MPTCP by default in the VM agent

## Problem and scope

Mitigate the demonstrated MPTCP-listener attack path for CVE-2026-98432 with a VM-agent-only build default. Preserve ordinary TCP/HTTP/TLS behavior. No cloud-init, providers, firewalls, CLI, deployment-node or fleet-remediation changes.

## Research

- `packages/vm-agent/go.mod` declares Go 1.26.0/toolchain 1.26.10.
- `internal/server/server.go` uses standard `http.Server.ListenAndServeTLS` / `ListenAndServe`.
- The Go security advisory explicitly supports `godebug multipathtcp=0` in the main module. No custom listener is needed. Runtime GODEBUG and explicit per-socket opt-ins can override this default; this mitigation does not patch the underlying kernel bug.
- Standard release builds run from the VM-agent module through its Makefile.
- Use the SAM-provided output branch/isolated checkout. Task record travels in the feature PR because protected main requires PR checks.

## Checklist and acceptance criteria

- [x] Add only `godebug multipathtcp=0` as the production change.
- [x] Verify main package DefaultGODEBUG includes multipathtcp=0; deployed release matches the same agent contents.
- [x] Add at most one simple focused regression check if durable.
- [x] Run Go tests and normal CI quality gates (separate local vet/build evidence lost on workspace replacement).
- [x] Independent Go/security and task-completion reviews pass.
- [x] Staging verification passes using fresh VM-agent artifact.
- [ ] PR checks and CodeRabbit request/wait complete; merge and verify production deployment.

## References

- https://www.openwall.com/lists/oss-security/2026/10/30/1
- https://www.anthropic.com/research/discovering-vulnerabilities-with-claude
- https://go.dev/doc/godebug
- `.claude/commands/do.md`, `packages/vm-agent/AGENTS.md`

## Validation evidence so far

- Go 1.26.10: regression fails before directive and passes after; `go list -f '{{.Name}} {{.DefaultGODEBUG}}' .` returns `main multipathtcp=0`.
- Independent local Go/security, test-engineer, constitution and implementation-completion reviews: PASS, no findings.
- `pnpm lint`: PASS (existing warnings). Remaining checks in progress.
- Credential correction: ordinary shell environments held placeholders. Actual Cloudflare and browser credentials work through `exec_with_secrets`; no credential refresh needed.
- Original staging deployment41442724493 passed; fresh allocation failed before heartbeat. All owned fixtures were subsequently removed and absence verified.
- Separate repair PR2496 shipped via production41508827405, with basic health smoke passing. It enables exact-resource recovery while retaining ambiguous empty allocations.
- Current main merged into this branch to preserve that repair during final MPTCP staging. VM-agent production diff remains only the directive. Fresh VM heartbeat/access and CodeRabbit/release gates remain pending.

## Final staging evidence (2026-11-02 20:37 UTC)

- CI41516473238, E2E41516473257 and staging41516465614 PASS on93459d1f.
- Fresh Hetzner cx23 node01M6EZAFAX09Z52RFK4YKCVW01 reported healthy heartbeats and authenticated system-info. Agent releasecb6f73e1f36d5613b79f9201541a877f32e6b62b matches the content-based release resolver for this branch and includes the directive.
- Default workspace reservation exceeded the small node capacity (409 before creation); explicit0.5vCPU/1GB/5GB reservation succeeded without resizing. Workspace01M6EZMFC1829CFK7H7NFRM5KH reached running; authenticated Playwright workspace view showed running and correct hardware, no page errors.
- Cleanup requested via normal APIs; final absence evidence and post-merge deployment recorded in PR body and local workflow state. CodeRabbit and release remain separate gates.
