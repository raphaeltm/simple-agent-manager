# VM Agent Fast-Boot Hardening: Firewall INPUT-DROP Removal + HTTP Transport Resilience

**Created**: 2026-04-18
**Priority**: HIGH
**Related ideas**:
- `01KPFZHSYMP2N9FY0N9SNEN77Z` — original short-term fix bundle
- `01KPG1MWTWBN1GKR60CTYXG8NM` — deferred golden-image strategic fix

## Problem Statement

Every VM boot exhibits a consistent ~6-minute window where the VM agent logs "Cloudflare API unreachable" / "context deadline exceeded" while trying to talk to the control plane. It has been present for ~2 weeks and directly conflicts with the product goal of workspaces coming up as fast as technologically possible.

Diagnosis (prior session) identified two compounding causes:

1. **Firewall conntrack dependency.** `packages/cloud-init/src/template.ts` writes `setup-firewall.sh` which sets `iptables -P INPUT DROP` (and `ip6tables -P INPUT DROP`) and relies on `iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT` for reply packets from outbound connections. During the window where Docker is installed + `systemctl restart docker` + devcontainer veth/NAT churn occurs, `nf_conntrack` entries for existing connections to `api.simple-agent-manager.org` are invalidated. Subsequent reply packets hit the DROP policy and are silently discarded.
2. **Dead-socket pooling in Go transport.** `packages/vm-agent/internal/config/helpers.go:NewControlPlaneClient` returns `&http.Client{Timeout: t}` with the default transport. The default `IdleConnTimeout` is 90 seconds, so already-broken sockets linger in the pool and cause each new request to hang until Go's per-request timeout fires. This extends the firewall-induced outage from "a few seconds while conntrack heals" into the ~6 minute window we observe.

A secondary landmine compounds both: `trap 'iptables -P INPUT DROP 2>/dev/null; ip6tables -P INPUT DROP 2>/dev/null' EXIT` combined with `set -euo pipefail` means that any early failure in the firewall script leaves the box in a total blackout state (DROP policy with zero ACCEPT rules). If curl-ing the Cloudflare IP list is slow and any preceding step fails, the node becomes unreachable permanently.

## Research Findings

### Firewall script — current state (`packages/cloud-init/src/template.ts:93-177`)
- `set -euo pipefail` at top of script.
- `trap 'iptables -P INPUT DROP 2>/dev/null; ip6tables -P INPUT DROP 2>/dev/null' EXIT` — fires on normal exit AND on error exit, clamping policy to DROP regardless of whether ACCEPT rules were successfully added.
- `iptables -F INPUT` then adds `lo`, `conntrack ESTABLISHED,RELATED`, `docker0`/`br-+` on VM_AGENT_PORT, then CF IPv4 CIDRs on VM_AGENT_PORT.
- `iptables -P INPUT DROP` (line 148).
- Mirrored for IPv6 (line 160).
- DOCKER-USER metadata block + rules save.
- Re-run nightly by `/etc/cron.daily/update-cloudflare-firewall` — same script, same landmine.

### VM agent HTTP client factory (`packages/vm-agent/internal/config/helpers.go:132-140`)
```go
func NewControlPlaneClient(timeout time.Duration) *http.Client {
    if timeout <= 0 { timeout = 30 * time.Second }
    return &http.Client{Timeout: timeout}
}
```
Every caller inherits `http.DefaultTransport` with default `IdleConnTimeout: 90s`, `MaxIdleConnsPerHost: 2`, no dial/TLS handshake/response-header sub-timeouts.

Callers of note (those that matter for first-heartbeat time):
- `internal/bootstrap/bootstrap.go:627` — bootstrap token redemption.
- `internal/bootstrap/bootstrap.go:2426` — workspace-ready callback.
- `internal/server/server.go:313` — control-plane client used for heartbeat/state reports.

### Provisioning pipeline (`packages/vm-agent/internal/provision/provision.go`)
After PR #733, `provision.Run` now runs network-disruptive steps in-agent: packages → docker → firewall → tls-permissions → nodejs-install → devcontainer-cli → image-prepull (bg) → journald-config → docker-restart → metadata-block. The two steps most likely to invalidate pooled sockets are `restartDocker` and `installFirewall`.

### Post-mortem lessons (`docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`)
- Cloud-init output must be parsed as YAML in tests, not grep'd as strings — the TLS indentation bug shipped because tests used `toContain('BEGIN CERTIFICATE')` style assertions.
- Therefore: new firewall tests MUST parse generated cloud-init YAML, extract the firewall script body, and assert structural properties of the script.

### Related rules
- Rule 02 — Template Output Verification: parse, don't grep.
- Rule 22 — Infrastructure items are merge-blocking.
- Rule 27 — VM agent binary refresh: MUST delete all nodes on staging before deploying vm-agent changes (binary is downloaded at cloud-init time; existing nodes keep the old binary).

## Implementation Checklist

### Firewall hardening (`packages/cloud-init/src/template.ts`)
- [ ] Remove the `trap 'iptables -P INPUT DROP ...' EXIT` landmine. Replace with either no trap or a trap that logs + restores the pre-script ruleset.
- [ ] Invert the default: keep `INPUT` policy as `ACCEPT`. For `VM_AGENT_PORT`, add an explicit default-DROP at the *end* of the rule list so only CF CIDRs (and loopback / docker bridges) can reach the port. Pattern per family:
  - `iptables -F INPUT`
  - `iptables -A INPUT -i lo -j ACCEPT`
  - `iptables -A INPUT -i docker0 -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT`
  - `iptables -A INPUT -i br-+ -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT`
  - (for each CF CIDR) `iptables -A INPUT -s <cidr> -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT`
  - `iptables -A INPUT -p tcp --dport "$VM_AGENT_PORT" -j DROP`  ← final rule, catches non-CF traffic to that port only
  - `iptables -P INPUT ACCEPT`  ← explicit, never DROP
- [ ] Mirror the same pattern for IPv6.
- [ ] Leave `-m conntrack` out entirely (not needed when policy is ACCEPT).
- [ ] Preserve DOCKER-USER metadata block (unchanged).
- [ ] Preserve `/etc/cron.daily/update-cloudflare-firewall` (unchanged).

### HTTP transport resilience (`packages/vm-agent/internal/config/helpers.go`)
- [ ] Introduce a package-level shared `*http.Transport` configured with: `MaxIdleConns: 10`, `MaxIdleConnsPerHost: 2`, `IdleConnTimeout: 30*time.Second`, `DialContext` with 5s dial timeout, `TLSHandshakeTimeout: 10*time.Second`, `ResponseHeaderTimeout: 10*time.Second`, `ExpectContinueTimeout: 1*time.Second`, `ForceAttemptHTTP2: true`.
- [ ] `NewControlPlaneClient` returns `&http.Client{Timeout: t, Transport: sharedTransport}`.
- [ ] Expose `CloseIdleControlPlaneConnections()` which calls `sharedTransport.CloseIdleConnections()`.

### Provisioning integration (`packages/vm-agent/internal/provision/provision.go`)
- [ ] After `restartDocker(ctx)` completes, call `config.CloseIdleControlPlaneConnections()`.
- [ ] After `installFirewall(...)` completes, call `config.CloseIdleControlPlaneConnections()`.
- [ ] No change to step ordering or error handling.

### Tests
- [ ] Update `packages/cloud-init/tests/generate.test.ts` assertions that currently check for `iptables -P INPUT DROP` / the EXIT trap → assert the new pattern:
  - Parse generated output as YAML.
  - Extract `write_files` entry for `/etc/sam/firewall/setup-firewall.sh`.
  - Assert `iptables -P INPUT DROP` and `ip6tables -P INPUT DROP` are NOT present (except possibly inside a `# legacy:` comment if we keep one).
  - Assert final VM_AGENT_PORT DROP rule is present for both families.
  - Assert each Cloudflare fallback CIDR appears as an ACCEPT rule scoped to VM_AGENT_PORT.
  - Assert the `EXIT` trap no longer clamps to DROP (script contains no `trap '*DROP*' EXIT`).
- [ ] New unit test in `packages/vm-agent/internal/config/` that asserts `NewControlPlaneClient(t).Transport` is the package-shared `*http.Transport` with the expected tuned fields (timeouts, MaxIdleConnsPerHost, ForceAttemptHTTP2).
- [ ] New unit test that `CloseIdleControlPlaneConnections()` actually calls `CloseIdleConnections` on the shared transport (serve ephemeral HTTP, do a request to populate pool, call helper, assert the pool is flushed — observable via a follow-up request forcing a new TCP dial).
- [ ] `go test ./... && go vet ./...` clean.
- [ ] `pnpm test` clean.

### Staging verification (rule 27)
- [ ] Delete all existing nodes on staging BEFORE deploying.
- [ ] `gh workflow run deploy-staging.yml --ref <branch>` and wait for green.
- [ ] Start a fresh project chat session on staging — this provisions a node that downloads the new binary.
- [ ] Measure time from node creation to first successful heartbeat. Compare qualitatively against the prior 6-min outage pattern.
- [ ] Verify: no sustained "context deadline exceeded" window in VM agent logs during provisioning.
- [ ] Clean up the test workspace + node.

## Acceptance Criteria

- [ ] `iptables -P INPUT DROP` no longer appears in the generated cloud-init firewall script under any normal code path.
- [ ] `trap '*DROP*' EXIT` no longer appears.
- [ ] Cloudflare IPs remain the only external sources that can reach `VM_AGENT_PORT`; verified by unit test assertions on the generated script.
- [ ] `NewControlPlaneClient` uses a package-shared `*http.Transport` with the specified timeouts.
- [ ] `CloseIdleControlPlaneConnections()` is called after `restartDocker` and after `installFirewall` in the provisioning pipeline.
- [ ] On staging: a fresh project chat session boots without the 6-minute "context deadline exceeded" window. First-heartbeat time is measurably improved or at least no longer shows the sustained outage pattern.
- [ ] task-completion-validator passes.
- [ ] go-specialist + security-auditor review both return PASS or ADDRESSED.
- [ ] CI green on PR.

## References
- `.claude/rules/02-quality-gates.md` — Template output verification, infrastructure verification, staging merge gate.
- `.claude/rules/22-infrastructure-merge-gate.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`
- Idea `01KPFZHSYMP2N9FY0N9SNEN77Z` (this bundle).
- Idea `01KPG1MWTWBN1GKR60CTYXG8NM` (deferred golden-image fix).
