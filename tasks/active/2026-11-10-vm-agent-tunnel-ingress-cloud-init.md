# VM-agent tunnel ingress and cloud-init connector bootstrap

Bounded slice of parent task `01M719ZRT6MJX696B9FH8TBWX9` (Cloudflare Tunnel managed-VM
integration). This task owns `packages/vm-agent/**` and `packages/cloud-init/**`. The parent
owns API/lifecycle wiring, consolidated staging, review gates, PR and merge.

## Problem

The staging proof (`experiments/cloudflare-tunnel/FINDINGS.md`) showed that a direct
`cloudflared` ingress request reaches loopback without relay headers. The existing Git
credential handler trusts a bearerless private/loopback peer that is not marked as relayed, so
pointing a tunnel at the existing listener would expose the credential exchange publicly.
Managed nodes also need an outbound-only connector bootstrap that never carries the account
API token, never fetches an Origin CA certificate, and blocks public inbound traffic.

## Research findings

- `internal/server/git_credential.go:isAuthorizedGitCredentialRequest` is the only handler that
  trusts the peer address. All other routes use JWT/session/callback auth.
- `internal/server/proxy_guard.go:isRelayedRequest` is header-based (`X-SAM-Proxied-Request`,
  `X-Forwarded-Host`). Inbound headers on a direct tunnel request are attacker-controlled, so the
  tunnel classification must be held outside headers (request context).
- `isOwnListenerTarget` refuses port proxy / local forward to `config.Port` only.
- `Server.Start` uses `ListenAndServe(TLS)`; `Stop` shuts down only `httpServer`.
- `main.go` runs `srv.Start()` in a goroutine for all three roles; workspace mode installs the
  firewall from `internal/provision` after the listener is already serving.
- Cloud-init: `generate.ts` (761 lines, over the 500-line ceiling) and `template.ts`. The firewall
  script allowlists Cloudflare IPs for the agent port; Origin CA bootstrap runs when
  `originCaCertificateUrl` is set. Output must stay under 32 KB.
- `cloudflared 2026.10.7` supports `tunnel run --token-file`. Verified sha256: amd64
  `1f99fb51…1872`, arm64 `3df43aed…5775` (GitHub release asset digests and release notes agree).
- `apps/api/src/routes/node-boot-failure.ts` accepts only `origin_ca_bootstrap` and
  `vm_agent_download`; new tunnel reasons need a parent-owned API change (published on channel).

## Checklist

- [ ] Config: `VM_AGENT_TUNNEL_ENABLED` (default false), `VM_AGENT_TUNNEL_PORT` (default 8444),
      validation (range, distinct from `VM_AGENT_PORT`).
- [ ] Server: loopback-only tunnel listener wrapping the existing handler; every request classified
      relayed via request context before CORS/mux. `isRelayedRequest` honours the context marker.
- [ ] Own-listener guard covers the tunnel port when enabled (port proxy + local forward).
- [ ] Start binds both listeners before serving; Stop shuts both down; Start returns the first
      fatal serve error.
- [ ] Go tests: bearerless Git credential refused via tunnel listener and allowed on main
      loopback; header spoofing (`Connection:` stripping) cannot unclassify; JWT routes still work
      through tunnel; port proxy/local forward refuse tunnel port; start/stop/bind failure; disabled
      by default (no listener).
- [ ] Split `generate.ts` (validation/variables) to respect the file-size rule.
- [ ] Cloud-init: new variables + validation (token charset/length, port, pinned version, tunnel +
      Origin CA mutual exclusion).
- [ ] Cloud-init tunnel mode: pinned/checksummed cloudflared install, 0600 token file, systemd
      connector unit (hardened, `--token-file`, `--no-autoupdate`), firewall before agent start,
      wait for tunnel listener health before starting connector, boot-failure reporting.
- [ ] Firewall tunnel mode: drop public inbound for agent port, tunnel port, SSH on IPv4/IPv6;
      allow docker bridges to agent port only; fail closed when global IPv6 exists without ip6tables.
- [ ] Cloud-init tests: parsed YAML for tunnel + legacy; execute changed runcmd/firewall entries
      under their interpreters with stubs.
- [ ] Docs: VM agent env vars, cloud-init docs/self-hosting where behaviour is described.
- [ ] Publish contract + completion evidence on `feature.vm-tunnels-staging`; send SHAs to parent.

## Acceptance criteria

- Tunnel listener absent unless explicitly enabled; legacy and instant behaviour unchanged.
- Bearerless Git credential requests through the tunnel listener return 401 regardless of headers;
  the private Docker helper path still returns credentials.
- Legacy cloud-init output keeps Origin CA + Cloudflare allowlist behaviour.
- Tunnel cloud-init installs only the pinned checksum-verified binary and starts the connector only
  after the firewall and the loopback tunnel listener are ready.

Local tests here are not staging proof; the parent runs live staging E2E.
