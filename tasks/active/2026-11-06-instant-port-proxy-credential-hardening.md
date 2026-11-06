# Port proxy and git-credential hardening for Instant workspaces

**Created**: 2026-11-06
**SAM task**: `01M6QZBHRCQGW8W36W894Q3XDP`
**Idea**: `01M5R2BTGXBWVN8D51CT9GM7HD` (full analysis lives there; this repository is public)
**Branch**: `sam/security-fix-instant-cf-4q3xdp`

## Problem

In standalone mode (Instant / `cf-container`) the vm-agent port proxy has no container discovery,
so it forwards workspace port traffic to `127.0.0.1:<port>`. That includes the vm-agent's own
listen port. The vm-agent's `GET /git-credential` endpoint grants bearerless trust to loopback
and private peers, and a request relayed by the vm-agent's own reverse proxy arrives from
`127.0.0.1`. Public port previews (`portsPublicEnabled`) therefore must not be able to reach
the vm-agent's own listener, and `/git-credential` must not treat a relayed request as a local
credential-helper call.

Confirmed on unpatched staging on 2026-11-06 (details in the idea; no credential value was
printed or stored).

## Research Findings

- `packages/vm-agent/internal/server/ports_proxy.go` `handleWorkspacePortProxy`: `targetHost`
  stays `127.0.0.1` whenever no discovery exists (standalone mode, and non-container VM mode).
  No guard for the vm-agent's own port.
- `packages/vm-agent/internal/server/local_forward.go` `resolveWorkspaceBridgeIP`: returns
  `127.0.0.1` when `!ContainerMode`; it requires an owner local-forward JWT, but should share the
  same own-port guard.
- The vm-agent has exactly one listener: `config.Port` (`server.go` `httpServer`). In standalone
  mode that is `VM_AGENT_PORT` (default 8080), matching the API's
  `CF_CONTAINER_VM_AGENT_PORT`/`SANDBOX_VM_AGENT_PORT`.
- `git_credential.go` `isLocalGitCredentialExchange` is the only vm-agent route that trusts the
  peer address. All other mux routes use workspace JWT/session cookie, node-management or
  node-event auth, or a local-forward JWT; the port proxy strips its own `token` query value
  before forwarding.
- `local_forward.go` sets `X-Forwarded-For: 127.0.0.1` on its outbound request; nothing in the
  vm-agent reads `X-Forwarded-For`, so this is not itself a trust input.
- In-container helpers call `/git-credential` directly with curl (`standalone_git.go` helper,
  devcontainer helper in `bootstrap.go`), never through a SAM proxy.
- API `apps/api/src/index.ts` cf-container branch rewrites `ws-<id>--<port>` to
  `/workspaces/<id>/ports/<port>` on the container's vm-agent port with no check that `<port>`
  differs from that vm-agent port. The VM branch targets the container bridge IP, where the
  host vm-agent does not listen; it is unchanged.

## Implementation Checklist

- [ ] vm-agent: port proxy refuses (403) when the target is loopback and the port is a
      vm-agent listen port
- [ ] vm-agent: local forward applies the same refusal
- [ ] vm-agent: both proxies mark forwarded requests with a SAM-proxied marker header
- [ ] vm-agent: `/git-credential` refuses bearerless loopback trust when the marker is present,
      and when the request carries API-forwarding headers
- [ ] API: cf-container route rejects `targetPort === vmAgentPort` with 403 before minting a
      port-proxy token
- [ ] API: cf-container forwards set the same marker header (defense in depth for
      non-port routes)
- [ ] Tests: attack through the real path (API cf-container port route + public ports →
      vm-agent port proxy → handler) returns no credential
- [ ] Tests: owner control, a dev-server port is still proxied with public ports on
- [ ] Tests: discrimination check, each guard deleted in turn reddens the attack test
- [ ] Tests: VM-runtime control, VM routing unchanged for the same port number
- [ ] Tests: in-container credential helper (git and gh shim) still works
- [ ] Update `tasks/backlog/2026-03-16-port-exposure-security-hardening.md` and
      `tasks/backlog/2026-06-09-git-credential-loopback-container-binding.md`
- [ ] Docs: note the reserved port in the public port-exposure docs if they list behaviour

## Acceptance Criteria

- [ ] With public ports on, a request to the vm-agent's own port on an Instant workspace returns
      403 and never reaches `/git-credential` (unit + staging)
- [ ] A relayed request that does reach `/git-credential` without a bearer is refused (unit)
- [ ] A normal public preview on another port still works (unit + staging)
- [ ] `git` and `gh` still authenticate inside an Instant session (unit + staging)
- [ ] VM runtime port routing unchanged (unit)

## References

- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`,
  `packages/vm-agent/.claude/rules/61-guards-must-cover-every-runtime.md`,
  `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md`
