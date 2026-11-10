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

- [x] Config: `VM_AGENT_TUNNEL_ENABLED` (default false), `VM_AGENT_TUNNEL_PORT` (default 8444),
      validation (range, distinct from `VM_AGENT_PORT`).
- [x] Server: loopback-only tunnel listener wrapping the existing handler; every request classified
      relayed via request context before CORS/mux. `isRelayedRequest` honours the context marker.
- [x] Own-listener guard covers the tunnel port when enabled (port proxy + local forward).
- [x] Start binds both listeners before serving; Stop shuts both down; Start returns the first
      fatal serve error.
- [x] Go tests: bearerless Git credential refused via tunnel listener and allowed on main
      loopback; header spoofing (`Connection:` stripping) cannot unclassify; JWT routes still work
      through tunnel; port proxy/local forward refuse tunnel port; start/stop/bind failure; disabled
      by default (no listener).
- [x] Split `generate.ts` (validation/variables) to respect the file-size rule.
- [x] Cloud-init: new variables + validation (token charset/length, port, pinned version, tunnel +
      Origin CA mutual exclusion).
- [x] Cloud-init tunnel mode: pinned/checksummed cloudflared install, 0400 token file, systemd
      connector unit (hardened, `--token-file`, `--no-autoupdate`), firewall before agent start,
      wait for tunnel listener health before starting connector, boot-failure reporting.
- [x] Firewall tunnel mode: drop public inbound for agent port, tunnel port, SSH on IPv4/IPv6;
      allow docker bridges to agent port only; fail closed when global IPv6 exists without ip6tables.
- [x] Cloud-init tests: parsed YAML for tunnel + legacy; execute changed runcmd/firewall entries
      under their interpreters with stubs.
- [x] Docs: VM agent env vars, cloud-init docs/self-hosting where behaviour is described.
- [x] Publish contract + completion evidence on `feature.vm-tunnels-staging`; send SHAs to parent.

## Acceptance criteria

- Tunnel listener absent unless explicitly enabled; legacy and instant behaviour unchanged.
- Bearerless Git credential requests through the tunnel listener return 401 regardless of headers;
  the private Docker helper path still returns credentials.
- Legacy cloud-init output keeps Origin CA + Cloudflare allowlist behaviour.
- Tunnel cloud-init installs only the pinned checksum-verified binary and starts the connector only
  after the firewall and the loopback tunnel listener are ready.

Local tests here are not staging proof; the parent runs live staging E2E.

## Implementation notes

- Commits: `82029044c` (vm-agent listener), `4e44fb8a8` (cloud-init tunnel mode), then a
  follow-up for the parent's review finding: the tunnel firewall is a dedicated
  `SAM-TUNNEL-INGRESS` chain replaced by one `iptables-restore --noflush` transaction per
  family, and the vm-agent unit runs it as `ExecStartPre` in tunnel mode so a firewall
  failure stops the agent from listening on every start/reboot.
- A real-netfilter test (`sudo unshare -n`, skipped without passwordless sudo) re-applies the
  script 25 times under a checker loop: 0 gaps. The same driver against a flush-and-re-add
  variant recorded 151 gaps.
- That test found that the first tunnel script skipped IPv6 when `modprobe` was missing even
  though `ip6tables` worked. Usability of `ip6tables` now decides.
- User-data size: legacy output was ~31.9 KB of 32 KB with a 700-char callback JWT. Mode-only
  fragments and reading `/etc/sam/callback-token` bring it to ~30.2 KB (tunnel ~26.9 KB).
- go-specialist: no confirmed concurrency bugs; MEDIUM sequential listener shutdown sharing one
  deadline fixed (concurrent `shutdownListeners`, `TestStopClosesMainListenerWhileTunnelRequestDrains`
  red on the sequential version). LOW harness layering left as is.
- Parent config review: the readiness wait counted attempts (120 could take ~360 s). Fixed with
  an elapsed-time deadline; probe timeout, probe interval and connector RestartSec are optional
  CloudInitVariables with exported defaults (`746eca513`). The fake-clock test goes red on the
  count-based loop.
- Local review (this slice): doc-sync PASS; security-auditor 0 CRITICAL/HIGH (LOW systemd
  hardening applied; checksums verified against the release); task-completion-validator PASS
  (`template.ts` split into `template-resources.ts`; the configuration.md env table lists
  control-plane Worker vars, so the cloud-init-internal tunnel vars are documented in
  security.md instead).

## Deferred

- Direct (legacy) nodes still install the firewall from `internal/provision` after the agent
  starts listening; the provider cloud firewall is their primary gate. Tunnel nodes are gated
  before start. A provider-level firewall for tunnel nodes (security MEDIUM: in-VM iptables is
  the only layer) was reported to the parent, which decided the fail-closed host firewall is
  adequate for now and left provider-level defence in depth for separate future work.
- Live staging proof (real VM, connector, firewall evidence) is owned by parent task
  `01M719ZRT6MJX696B9FH8TBWX9`.
